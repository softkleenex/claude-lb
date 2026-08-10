from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select

from app.core.crypto import encrypt, mask_secret
from app.db.models import Account
from app.dependencies import SessionDep
from app.modules.audit import service as audit
from app.modules.auth.dependencies import client_ip
from app.modules.proxy.load_balancer import headroom, is_available

router = APIRouter(prefix="/api/accounts", tags=["accounts"])


class AccountCreate(BaseModel):
    """Add an upstream account.

    Two shapes. A Console API key needs only `api_key`. An OAuth-style upstream sets
    `provider="oauth"` and supplies its own access token plus, optionally, the refresh
    material — claude-lb hardcodes no client constants for any provider.
    """

    name: str = Field(min_length=1, max_length=128)
    api_key: str = Field(min_length=8, description="API key or access token to present upstream.")
    provider: Literal["anthropic_api_key", "oauth"] = "anthropic_api_key"
    auth_scheme: Literal["x-api-key", "bearer"] | None = Field(
        default=None, description="Defaults to x-api-key for API keys, bearer for OAuth."
    )
    extra_headers: dict[str, str] = Field(
        default_factory=dict, description="Extra headers this upstream requires."
    )
    base_url: str | None = None

    oauth_refresh_token: str | None = None
    oauth_token_endpoint: str | None = Field(
        default=None, description="Where to POST the refresh_token grant."
    )
    oauth_client_id: str | None = None
    oauth_client_secret: str | None = None
    oauth_scope: str | None = None
    expires_in_seconds: int | None = Field(
        default=None, ge=1, description="Lifetime of the supplied access token."
    )

    weight: float = 1.0
    priority: int = 0
    enabled: bool = True

    @model_validator(mode="after")
    def _check_oauth_fields(self) -> AccountCreate:
        if self.provider == "oauth" and self.oauth_refresh_token and not self.oauth_token_endpoint:
            raise ValueError("oauth_token_endpoint is required when a refresh token is supplied")
        if self.provider != "oauth" and self.oauth_refresh_token:
            raise ValueError("oauth_refresh_token requires provider='oauth'")
        return self

    def resolved_auth_scheme(self) -> str:
        if self.auth_scheme:
            return self.auth_scheme
        return "bearer" if self.provider == "oauth" else "x-api-key"


class AccountUpdate(BaseModel):
    api_key: str | None = Field(default=None, min_length=8)
    base_url: str | None = None
    weight: float | None = None
    priority: int | None = None
    enabled: bool | None = None
    auth_scheme: Literal["x-api-key", "bearer"] | None = None
    extra_headers: dict[str, str] | None = None
    oauth_refresh_token: str | None = None
    oauth_token_endpoint: str | None = None
    expires_in_seconds: int | None = Field(default=None, ge=1)


class AccountOut(BaseModel):
    id: str
    name: str
    provider: str
    credential_hint: str
    base_url: str | None
    weight: float
    priority: int
    enabled: bool
    available: bool
    headroom: float
    disabled_reason: str | None
    cooldown_until: datetime | None
    rl_requests_limit: int | None
    rl_requests_remaining: int | None
    rl_tokens_limit: int | None
    rl_tokens_remaining: int | None
    rl_reset_at: datetime | None
    total_requests: int
    total_input_tokens: int
    total_output_tokens: int
    total_cost_usd: float
    last_used_at: datetime | None
    last_probe_at: datetime | None
    last_probe_ok: bool | None
    last_probe_detail: str
    models_synced_at: datetime | None
    auth_scheme: str
    credential_expires_at: datetime | None
    last_refresh_at: datetime | None
    refresh_failures: int
    created_at: datetime

    @classmethod
    def of(cls, account: Account) -> AccountOut:
        return cls(
            available=is_available(account),
            headroom=round(headroom(account), 4),
            **{
                field: getattr(account, field)
                for field in cls.model_fields
                if field not in {"available", "headroom"}
            },
        )


@router.get("", response_model=list[AccountOut])
async def list_accounts(session: SessionDep) -> list[AccountOut]:
    result = await session.execute(select(Account).order_by(Account.name))
    return [AccountOut.of(a) for a in result.scalars()]


@router.post("", response_model=AccountOut, status_code=201)
async def create_account(payload: AccountCreate, request: Request, session: SessionDep) -> AccountOut:
    existing = await session.execute(select(Account).where(Account.name == payload.name))
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(409, f"an account named {payload.name!r} already exists")

    account = Account(
        name=payload.name,
        provider=payload.provider,
        encrypted_credential=encrypt(payload.api_key),
        credential_hint=mask_secret(payload.api_key),
        auth_scheme=payload.resolved_auth_scheme(),
        extra_headers_json=json.dumps(payload.extra_headers),
        base_url=payload.base_url,
        weight=payload.weight,
        priority=payload.priority,
        enabled=payload.enabled,
        oauth_refresh_token_encrypted=(
            encrypt(payload.oauth_refresh_token) if payload.oauth_refresh_token else None
        ),
        oauth_token_endpoint=payload.oauth_token_endpoint,
        oauth_client_id=payload.oauth_client_id,
        oauth_client_secret_encrypted=(
            encrypt(payload.oauth_client_secret) if payload.oauth_client_secret else None
        ),
        oauth_scope=payload.oauth_scope,
        credential_lifetime_seconds=payload.expires_in_seconds,
        credential_expires_at=(
            datetime.now(UTC) + timedelta(seconds=payload.expires_in_seconds)
            if payload.expires_in_seconds
            else None
        ),
    )
    session.add(account)
    await session.flush()
    # Records that a credential was added, never the credential itself.
    await audit.record(
        session,
        action="account.created",
        target=account.name,
        detail=account.credential_hint,
        client_ip=client_ip(request),
    )
    return AccountOut.of(account)


@router.patch("/{account_id}", response_model=AccountOut)
async def update_account(
    account_id: str, payload: AccountUpdate, request: Request, session: SessionDep
) -> AccountOut:
    account = await session.get(Account, account_id)
    if account is None:
        raise HTTPException(404, "account not found")

    if payload.api_key is not None:
        account.encrypted_credential = encrypt(payload.api_key)
        account.credential_hint = mask_secret(payload.api_key)
        # A replaced token invalidates the recorded expiry unless a new one is given.
        account.credential_lifetime_seconds = payload.expires_in_seconds
        account.credential_expires_at = (
            datetime.now(UTC) + timedelta(seconds=payload.expires_in_seconds)
            if payload.expires_in_seconds
            else None
        )
    if payload.oauth_refresh_token is not None:
        account.oauth_refresh_token_encrypted = encrypt(payload.oauth_refresh_token)
        account.refresh_failures = 0
    if payload.extra_headers is not None:
        account.extra_headers_json = json.dumps(payload.extra_headers)
    for field in ("base_url", "weight", "priority", "enabled", "auth_scheme", "oauth_token_endpoint"):
        value = getattr(payload, field)
        if value is not None:
            setattr(account, field, value)

    if payload.enabled:
        # Re-enabling is an explicit operator decision; clear the breaker with it.
        account.disabled_reason = None
        account.cooldown_until = None
        account.consecutive_failures = 0

    await session.flush()
    await audit.record(
        session,
        action="account.updated",
        target=account.name,
        detail=", ".join(sorted(payload.model_dump(exclude_none=True))) or "no-op",
        client_ip=client_ip(request),
    )
    return AccountOut.of(account)


@router.delete("/{account_id}", status_code=204)
async def delete_account(account_id: str, request: Request, session: SessionDep) -> None:
    account = await session.get(Account, account_id)
    if account is None:
        raise HTTPException(404, "account not found")
    await audit.record(session, action="account.deleted", target=account.name, client_ip=client_ip(request))
    await session.delete(account)
