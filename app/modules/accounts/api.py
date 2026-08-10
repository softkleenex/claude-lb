from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.core.crypto import encrypt, mask_secret
from app.db.models import Account
from app.dependencies import SessionDep
from app.modules.audit import service as audit
from app.modules.auth.dependencies import client_ip
from app.modules.proxy.load_balancer import headroom, is_available

router = APIRouter(prefix="/api/accounts", tags=["accounts"])


class AccountCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    api_key: str = Field(min_length=8, description="Anthropic API key (sk-ant-...)")
    base_url: str | None = None
    weight: float = 1.0
    priority: int = 0
    enabled: bool = True


class AccountUpdate(BaseModel):
    api_key: str | None = Field(default=None, min_length=8)
    base_url: str | None = None
    weight: float | None = None
    priority: int | None = None
    enabled: bool | None = None


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
        encrypted_credential=encrypt(payload.api_key),
        credential_hint=mask_secret(payload.api_key),
        base_url=payload.base_url,
        weight=payload.weight,
        priority=payload.priority,
        enabled=payload.enabled,
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
    for field in ("base_url", "weight", "priority", "enabled"):
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
