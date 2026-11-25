from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select

from claude_lb.core.crypto import encrypt, mask_secret
from claude_lb.db.models import Account
from claude_lb.dependencies import SessionDep
from claude_lb.modules.accounts import importer
from claude_lb.modules.audit import service as audit
from claude_lb.modules.auth.dependencies import client_ip
from claude_lb.modules.proxy import model_blocks
from claude_lb.modules.proxy.load_balancer import headroom, is_available
from claude_lb.modules.proxy.quota import (
    PLAN_TYPES,
    effective_capacity_credits,
    effective_primary_used,
    effective_secondary_used,
)

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
    plan_type: str | None = Field(
        default=None,
        description="Subscription plan tier (api, free, pro, max, max_5x, max_20x, team, enterprise).",
    )
    routing_policy: Literal["normal", "burn_first", "preserve"] = "normal"
    capacity_credits: float | None = Field(default=None, gt=0)
    spend_cap_usd: float | None = Field(
        default=None, ge=0, description="Stop routing here once estimated lifetime spend reaches this."
    )

    @model_validator(mode="after")
    def _check_oauth_fields(self) -> AccountCreate:
        if self.provider == "oauth" and self.oauth_refresh_token and not self.oauth_token_endpoint:
            raise ValueError("oauth_token_endpoint is required when a refresh token is supplied")
        if self.provider != "oauth" and self.oauth_refresh_token:
            raise ValueError("oauth_refresh_token requires provider='oauth'")
        if self.plan_type is not None and self.plan_type not in PLAN_TYPES:
            raise ValueError(f"plan_type must be one of {', '.join(PLAN_TYPES)}")
        return self

    def resolved_plan_type(self) -> str:
        if self.plan_type:
            return self.plan_type
        return "pro" if self.provider == "oauth" else "api"

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
    plan_type: str | None = None
    routing_policy: Literal["normal", "burn_first", "preserve"] | None = None
    capacity_credits: float | None = Field(default=None, gt=0)
    spend_cap_usd: float | None = Field(default=None, ge=0, description="Send null to remove the cap.")
    auth_scheme: Literal["x-api-key", "bearer"] | None = None
    extra_headers: dict[str, str] | None = None
    oauth_refresh_token: str | None = None
    oauth_token_endpoint: str | None = None
    expires_in_seconds: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def _check_plan_type(self) -> AccountUpdate:
        if self.plan_type is not None and self.plan_type not in PLAN_TYPES:
            raise ValueError(f"plan_type must be one of {', '.join(PLAN_TYPES)}")
        return self


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
    plan_type: str
    routing_policy: str
    capacity_credits: float | None
    spend_cap_usd: float | None
    blocked_models: list[str]
    effective_capacity: float
    primary_used_percent: float | None
    primary_reset_at: datetime | None
    secondary_used_percent: float | None
    secondary_reset_at: datetime | None
    unified_status: str | None
    overage_status: str | None
    quota_status: str
    quota_observed_at: datetime | None
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
        skip = {
            "available",
            "headroom",
            "effective_capacity",
            "primary_used_percent",
            "secondary_used_percent",
            "blocked_models",
        }
        return cls(
            blocked_models=model_blocks.active_blocks(account),
            available=is_available(account),
            headroom=round(headroom(account), 4),
            effective_capacity=effective_capacity_credits(account),
            primary_used_percent=effective_primary_used(account),
            secondary_used_percent=effective_secondary_used(account),
            **{field: getattr(account, field) for field in cls.model_fields if field not in skip},
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
        plan_type=payload.resolved_plan_type(),
        routing_policy=payload.routing_policy,
        capacity_credits=payload.capacity_credits,
        spend_cap_usd=payload.spend_cap_usd,
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
    for field in (
        "base_url",
        "weight",
        "priority",
        "enabled",
        "plan_type",
        "routing_policy",
        "capacity_credits",
        "auth_scheme",
        "oauth_token_endpoint",
    ):
        value = getattr(payload, field)
        if value is not None:
            setattr(account, field, value)
    if "spend_cap_usd" in payload.model_fields_set:
        account.spend_cap_usd = payload.spend_cap_usd

    if payload.enabled:
        # Re-enabling is an explicit operator decision; clear the breaker with it.
        account.disabled_reason = None
        account.cooldown_until = None
        account.consecutive_failures = 0
        account.quota_status = "active"

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


class AccountImport(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    credentials: dict
    plan_type: str | None = None
    routing_policy: Literal["normal", "burn_first", "preserve"] = "normal"
    weight: float = 1.0
    priority: int = 0
    base_url: str | None = None
    token_endpoint: str | None = None
    client_id: str | None = None

    @model_validator(mode="after")
    def _check_plan(self) -> AccountImport:
        if self.plan_type is not None and self.plan_type not in PLAN_TYPES:
            raise ValueError(f"plan_type must be one of {', '.join(PLAN_TYPES)}")
        return self


@router.post("/import", response_model=AccountOut, status_code=201)
async def import_account(payload: AccountImport, request: Request, session: SessionDep) -> AccountOut:
    """Import an OAuth/subscription credential bundle (e.g. Claude Code credentials JSON)."""
    existing = await session.execute(select(Account).where(Account.name == payload.name))
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(409, f"an account named {payload.name!r} already exists")

    try:
        parsed = importer.parse_credential_bundle(payload.credentials)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

    account = Account(
        name=payload.name,
        provider="oauth",
        encrypted_credential=encrypt(parsed.access_token),
        credential_hint=mask_secret(parsed.access_token),
        auth_scheme="bearer",
        extra_headers_json=json.dumps(parsed.extra_headers),
        base_url=payload.base_url or parsed.base_url,
        weight=payload.weight,
        priority=payload.priority,
        plan_type=payload.plan_type or parsed.plan_type,
        routing_policy=payload.routing_policy,
        oauth_refresh_token_encrypted=(
            encrypt(parsed.refresh_token) if parsed.refresh_token else None
        ),
        oauth_token_endpoint=payload.token_endpoint or parsed.token_endpoint,
        oauth_client_id=payload.client_id or parsed.client_id,
        oauth_client_secret_encrypted=(
            encrypt(parsed.client_secret) if parsed.client_secret else None
        ),
        oauth_scope=parsed.scope,
        credential_lifetime_seconds=parsed.lifetime_seconds,
        credential_expires_at=parsed.expires_at,
    )
    session.add(account)
    await session.flush()
    await audit.record(
        session,
        action="account.imported",
        target=account.name,
        detail=f"plan={account.plan_type}",
        client_ip=client_ip(request),
    )
    return AccountOut.of(account)


@router.post("/{account_id}/reset-quota", response_model=AccountOut)
async def reset_account_quota(account_id: str, request: Request, session: SessionDep) -> AccountOut:
    """Clear stored 5h/7d quota blocks and cooldown for an account."""
    account = await session.get(Account, account_id)
    if account is None:
        raise HTTPException(404, "account not found")

    account.quota_status = "active"
    model_blocks.clear_blocks(account)
    account.primary_used_percent = None
    account.primary_reset_at = None
    account.secondary_used_percent = None
    account.secondary_reset_at = None
    account.unified_status = None
    account.cooldown_until = None
    await session.flush()
    await audit.record(
        session,
        action="account.quota_reset",
        target=account.name,
        client_ip=client_ip(request),
    )
    return AccountOut.of(account)
