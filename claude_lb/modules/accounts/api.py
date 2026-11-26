from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import delete, func, select

from claude_lb.core.crypto import encrypt, mask_secret
from claude_lb.db.models import Account, QuotaHistory, RequestLog, UsageDaily
from claude_lb.dependencies import ProxyServiceDep, SessionDep
from claude_lb.modules.accounts import importer
from claude_lb.modules.audit import service as audit
from claude_lb.modules.auth.dependencies import client_ip
from claude_lb.modules.health import service as health_service
from claude_lb.modules.proxy import model_blocks
from claude_lb.modules.proxy.load_balancer import (
    PAUSED_REASON,
    headroom,
    is_available,
    is_paused,
    spend_cap_reached,
)
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
    transport: Literal["http", "claude_code"] = "http"

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
    name: str | None = Field(default=None, min_length=1, max_length=128)
    api_key: str | None = Field(default=None, min_length=8)
    base_url: str | None = None
    transport: Literal["http", "claude_code"] | None = None
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


class ModelBlockOut(BaseModel):
    model: str
    until: datetime
    """When claude-lb tries this model on the account again."""


class AccountOut(BaseModel):
    id: str
    name: str
    provider: str
    credential_hint: str
    base_url: str | None
    transport: str
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
    model_blocks: list[ModelBlockOut]
    paused: bool
    """Switched off by the operator (as opposed to disabled by the circuit breaker)."""
    spend_cap_reached: bool
    consecutive_failures: int
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
            "model_blocks",
            "paused",
            "spend_cap_reached",
        }
        blocks = model_blocks.active_block_expiries(account)
        return cls(
            blocked_models=[model for model, _ in blocks],
            model_blocks=[
                ModelBlockOut(model=model, until=datetime.fromtimestamp(until, UTC))
                for model, until in blocks
            ],
            paused=is_paused(account),
            spend_cap_reached=spend_cap_reached(account),
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
        transport=payload.transport,
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

    if payload.name is not None and payload.name != account.name:
        taken = await session.execute(select(Account.id).where(Account.name == payload.name))
        if taken.scalar_one_or_none() is not None:
            raise HTTPException(409, f"an account named {payload.name!r} already exists")
        account.name = payload.name

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
    transport_changed = payload.transport is not None and payload.transport != account.transport
    for field in (
        "base_url",
        "transport",
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
    if transport_changed:
        model_blocks.clear_blocks(account)
    if "spend_cap_usd" in payload.model_fields_set:
        account.spend_cap_usd = payload.spend_cap_usd

    if payload.enabled:
        # Re-enabling is an explicit operator decision; clear the breaker with it.
        account.disabled_reason = None
        account.cooldown_until = None
        account.consecutive_failures = 0
        account.quota_status = "active"
    elif payload.enabled is False:
        # Marked so the health probe leaves it switched off.
        account.disabled_reason = PAUSED_REASON

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
async def delete_account(
    account_id: str,
    request: Request,
    session: SessionDep,
    delete_history: bool = Query(
        default=False, description="Also delete its request logs, daily rollups and quota history."
    ),
) -> None:
    account = await session.get(Account, account_id)
    if account is None:
        raise HTTPException(404, "account not found")
    await audit.record(
        session,
        action="account.deleted",
        target=account.name,
        detail="with history" if delete_history else "",
        client_ip=client_ip(request),
    )
    if delete_history:
        await session.execute(delete(RequestLog).where(RequestLog.account_id == account_id))
        await session.execute(delete(UsageDaily).where(UsageDaily.account_id == account_id))
    # Quota snapshots mean nothing without the account; SQLite does not enforce the
    # cascade, so remove them explicitly either way.
    await session.execute(delete(QuotaHistory).where(QuotaHistory.account_id == account_id))
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
    transport: Literal["http", "claude_code"] = "claude_code"

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
        transport=payload.transport,
        weight=payload.weight,
        priority=payload.priority,
        plan_type=payload.plan_type or parsed.plan_type,
        routing_policy=payload.routing_policy,
        oauth_refresh_token_encrypted=(encrypt(parsed.refresh_token) if parsed.refresh_token else None),
        oauth_token_endpoint=payload.token_endpoint or parsed.token_endpoint,
        oauth_client_id=payload.client_id or parsed.client_id,
        oauth_client_secret_encrypted=(encrypt(parsed.client_secret) if parsed.client_secret else None),
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


class ProbeResultOut(BaseModel):
    ok: bool
    status_code: int | None
    detail: str
    models: int


class AccountProbeOut(BaseModel):
    probe: ProbeResultOut
    account: AccountOut


@router.post("/{account_id}/probe", response_model=AccountProbeOut)
async def probe_account_now(
    account_id: str, request: Request, proxy: ProxyServiceDep, session: SessionDep
) -> AccountProbeOut:
    """Check this account's credential against upstream now (`GET /v1/models`, no token cost).

    A passing probe returns a breaker-disabled account to rotation; a paused account
    stays paused.
    """
    # The probe reads and writes through its own short sessions (it must not hold a
    # transaction open across the upstream call), so this session reads only afterwards.
    outcome = await health_service.probe_one(proxy._client, account_id)  # noqa: SLF001 - same app
    if outcome is None:
        raise HTTPException(404, "account not found")
    account = await session.get(Account, account_id)
    if account is None:
        raise HTTPException(404, "account not found")
    await audit.record(
        session,
        action="account.probed",
        target=account.name,
        detail="ok" if outcome.ok else outcome.detail[:200],
        ok=outcome.ok,
        client_ip=client_ip(request),
    )
    return AccountProbeOut(
        probe=ProbeResultOut(
            ok=outcome.ok, status_code=outcome.status_code, detail=outcome.detail, models=len(outcome.models)
        ),
        account=AccountOut.of(account),
    )


@router.delete("/{account_id}/model-blocks", response_model=AccountOut)
async def clear_model_blocks(
    account_id: str,
    request: Request,
    session: SessionDep,
    model: str | None = Query(default=None, description="Lift only this model; omit to lift all."),
) -> AccountOut:
    """Retry temporarily unavailable account-model routes before their 12 h expiry."""
    account = await session.get(Account, account_id)
    if account is None:
        raise HTTPException(404, "account not found")
    if model is None:
        model_blocks.clear_blocks(account)
    elif not model_blocks.remove_block(account, model):
        raise HTTPException(404, f"{model!r} is not blocked on this account")
    await session.flush()
    await audit.record(
        session,
        action="account.model_blocks_cleared",
        target=account.name,
        detail=model or "all",
        client_ip=client_ip(request),
    )
    return AccountOut.of(account)


class QuotaTrendPoint(BaseModel):
    t: datetime
    """Start of the hour this point summarizes."""
    primary_used_percent: float | None
    secondary_used_percent: float | None


class UsageTrendDay(BaseModel):
    day: str
    requests: int
    errors: int
    input_tokens: int
    output_tokens: int
    cost_usd: float


class UsageWindowTotals(BaseModel):
    requests: int
    errors: int
    input_tokens: int
    output_tokens: int
    cost_usd: float


class AccountTrendsOut(BaseModel):
    account_id: str
    days: int
    quota: list[QuotaTrendPoint]
    usage: list[UsageTrendDay]
    totals: UsageWindowTotals


@router.get("/{account_id}/trends", response_model=AccountTrendsOut)
async def account_trends(
    account_id: str,
    session: SessionDep,
    days: int = Query(default=7, ge=1, le=90),
) -> AccountTrendsOut:
    """5h/7d utilization (hourly, from quota snapshots) and daily usage for one account.

    Quota points take the highest reading within each hour, so a short spike is not
    averaged away. Daily usage comes from rollups and survives request-log retention.
    """
    if await session.get(Account, account_id) is None:
        raise HTTPException(404, "account not found")
    now = datetime.now(UTC)
    since = now - timedelta(days=days)

    rows = (
        await session.execute(
            select(
                QuotaHistory.recorded_at,
                QuotaHistory.primary_used_percent,
                QuotaHistory.secondary_used_percent,
            )
            .where(QuotaHistory.account_id == account_id, QuotaHistory.recorded_at >= since)
            .order_by(QuotaHistory.recorded_at)
        )
    ).all()
    hourly: dict[datetime, list[float | None]] = {}
    for recorded_at, primary, secondary in rows:
        moment = recorded_at if recorded_at.tzinfo else recorded_at.replace(tzinfo=UTC)
        bucket = moment.replace(minute=0, second=0, microsecond=0)
        slot = hourly.setdefault(bucket, [None, None])
        if primary is not None:
            slot[0] = primary if slot[0] is None else max(slot[0], primary)
        if secondary is not None:
            slot[1] = secondary if slot[1] is None else max(slot[1], secondary)
    quota = [
        QuotaTrendPoint(t=bucket, primary_used_percent=values[0], secondary_used_percent=values[1])
        for bucket, values in sorted(hourly.items())
    ]

    start_day = (now.date() - timedelta(days=days - 1)).isoformat()
    usage_rows = (
        await session.execute(
            select(
                UsageDaily.day,
                func.sum(UsageDaily.requests),
                func.sum(UsageDaily.errors),
                func.sum(UsageDaily.input_tokens),
                func.sum(UsageDaily.output_tokens),
                func.sum(UsageDaily.cost_usd),
            )
            .where(UsageDaily.account_id == account_id, UsageDaily.day >= start_day)
            .group_by(UsageDaily.day)
        )
    ).all()
    by_day = {row[0]: row[1:] for row in usage_rows}
    usage: list[UsageTrendDay] = []
    for offset in range(days - 1, -1, -1):
        day = (now.date() - timedelta(days=offset)).isoformat()
        req, err, inp, out, cost = by_day.get(day, (0, 0, 0, 0, 0.0))
        usage.append(
            UsageTrendDay(
                day=day,
                requests=req or 0,
                errors=err or 0,
                input_tokens=inp or 0,
                output_tokens=out or 0,
                cost_usd=round(cost or 0.0, 6),
            )
        )
    totals = UsageWindowTotals(
        requests=sum(d.requests for d in usage),
        errors=sum(d.errors for d in usage),
        input_tokens=sum(d.input_tokens for d in usage),
        output_tokens=sum(d.output_tokens for d in usage),
        cost_usd=round(sum(d.cost_usd for d in usage), 6),
    )
    return AccountTrendsOut(account_id=account_id, days=days, quota=quota, usage=usage, totals=totals)
