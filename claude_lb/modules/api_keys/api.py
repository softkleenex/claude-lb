from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Body, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from claude_lb.db.models import Account, ApiKey, UsageDaily
from claude_lb.dependencies import SessionDep
from claude_lb.modules.api_keys import limits
from claude_lb.modules.api_keys.service import (
    LimitRuleInput,
    create_api_key,
    regenerate_api_key,
    replace_limit_rules,
)
from claude_lb.modules.audit import service as audit
from claude_lb.modules.auth.dependencies import client_ip

router = APIRouter(prefix="/api/keys", tags=["api-keys"])

MAX_LIMIT_RULES = 20
MAX_MODEL_ENTRIES = 64

Metric = Literal["requests", "total_tokens", "input_tokens", "output_tokens", "cost_usd"]
Window = Literal["5h", "7d", "daily", "weekly", "monthly", "custom"]


# ---- input --------------------------------------------------------------------------


class LimitRuleIn(BaseModel):
    metric: Metric
    window: Window
    max_value: float = Field(gt=0)
    window_seconds: int | None = Field(
        default=None,
        ge=limits.MIN_CUSTOM_WINDOW_SECONDS,
        le=limits.MAX_CUSTOM_WINDOW_SECONDS,
        description="Required for a custom window; ignored otherwise.",
    )
    model_filter: str | None = Field(default=None, max_length=128)

    @field_validator("model_filter")
    @classmethod
    def _strip(cls, value: str | None) -> str | None:
        return (value or "").strip() or None

    @model_validator(mode="after")
    def _custom_needs_seconds(self) -> LimitRuleIn:
        if self.window == "custom" and self.window_seconds is None:
            raise ValueError("a custom window needs window_seconds")
        return self

    def to_input(self) -> LimitRuleInput:
        return LimitRuleInput(
            metric=self.metric,
            window=self.window,
            max_value=self.max_value,
            window_seconds=self.window_seconds if self.window == "custom" else None,
            model_filter=self.model_filter,
        )


def _clean_models(value: list[str] | None) -> list[str] | None:
    """Trim, drop blanks and duplicates. An empty list means "no restriction"."""
    if value is None:
        return None
    seen: list[str] = []
    for item in value:
        item = item.strip()
        if item and item not in seen:
            seen.append(item[:128])
    if len(seen) > MAX_MODEL_ENTRIES:
        raise ValueError(f"at most {MAX_MODEL_ENTRIES} models")
    return seen or None


class _KeyPolicyIn(BaseModel):
    allowed_models: list[str] | None = None
    enforced_model: str | None = Field(default=None, max_length=128)
    assigned_account_ids: list[str] | None = None
    limits: list[LimitRuleIn] | None = Field(default=None, max_length=MAX_LIMIT_RULES)

    @field_validator("allowed_models")
    @classmethod
    def _models(cls, value: list[str] | None) -> list[str] | None:
        return _clean_models(value)

    @field_validator("enforced_model")
    @classmethod
    def _enforced(cls, value: str | None) -> str | None:
        return (value or "").strip() or None

    @field_validator("assigned_account_ids")
    @classmethod
    def _accounts(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        return list(dict.fromkeys(v for v in value if v)) or None


class ApiKeyCreate(_KeyPolicyIn):
    name: str = Field(min_length=1, max_length=128)
    expires_at: datetime | None = None
    max_requests_per_window: int | None = Field(default=None, ge=1)
    max_tokens_per_window: int | None = Field(default=None, ge=1)
    max_cost_usd_per_window: float | None = Field(default=None, gt=0)
    window_seconds: int = Field(default=3600, ge=60)
    pinned_account_id: str | None = None


class ApiKeyUpdate(_KeyPolicyIn):
    """Only the fields that are sent change. ``limits`` replaces the whole rule set."""

    name: str | None = Field(default=None, min_length=1, max_length=128)
    enabled: bool | None = None
    expires_at: datetime | None = None
    pinned_account_id: str | None = None
    max_requests_per_window: int | None = Field(default=None, ge=1)
    max_tokens_per_window: int | None = Field(default=None, ge=1)
    max_cost_usd_per_window: float | None = Field(default=None, gt=0)
    window_seconds: int | None = Field(default=None, ge=60)


# ---- output -------------------------------------------------------------------------


class LimitUsageOut(BaseModel):
    id: str
    source: Literal["rule", "legacy"]
    metric: str
    window: str
    window_seconds: int
    max_value: float
    model_filter: str | None
    current_value: float
    remaining: float
    used_percent: float
    window_start: datetime
    resets_at: datetime | None


class ApiKeyOut(BaseModel):
    id: str
    name: str
    key_hint: str
    enabled: bool
    status: Literal["active", "disabled", "expired"]
    expires_at: datetime | None
    max_requests_per_window: int | None
    max_tokens_per_window: int | None
    max_cost_usd_per_window: float | None
    window_seconds: int
    pinned_account_id: str | None
    allowed_models: list[str] | None
    enforced_model: str | None
    assigned_account_ids: list[str] | None
    limits: list[LimitUsageOut]
    total_requests: int
    total_cost_usd: float
    total_tokens: int
    """Lifetime tokens from the daily rollups (input + output + cache)."""
    lifetime_requests: int
    lifetime_cost_usd: float
    """Lifetime requests and cost from the daily rollups. ``total_requests`` /
    ``total_cost_usd`` are the key's own counters and miss imported or seeded history."""
    last_used_at: datetime | None
    created_at: datetime


class ApiKeyCreated(ApiKeyOut):
    api_key: str = Field(description="Shown once. Only a hash is stored.")


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def key_status(key: ApiKey, now: datetime) -> Literal["active", "disabled", "expired"]:
    if not key.enabled:
        return "disabled"
    expires_at = _aware(key.expires_at)
    if expires_at is not None and expires_at <= now:
        return "expired"
    return "active"


_TOKENS = (
    UsageDaily.input_tokens
    + UsageDaily.output_tokens
    + UsageDaily.cache_creation_input_tokens
    + UsageDaily.cache_read_input_tokens
)


_NO_USAGE = (0, 0, 0.0)


async def _lifetime(
    session: AsyncSession, key_ids: list[str] | None = None
) -> dict[str, tuple[int, int, float]]:
    """(requests, tokens, cost) per key from the daily rollups; all keys when ``key_ids`` is None."""
    query = select(
        UsageDaily.api_key_id,
        func.coalesce(func.sum(UsageDaily.requests), 0),
        func.coalesce(func.sum(_TOKENS), 0),
        func.coalesce(func.sum(UsageDaily.cost_usd), 0.0),
    ).group_by(UsageDaily.api_key_id)
    if key_ids is not None:
        if not key_ids:
            return {}
        query = query.where(UsageDaily.api_key_id.in_(key_ids))
    else:
        query = query.where(UsageDaily.api_key_id.is_not(None))
    return {kid: (int(r), int(t), float(c)) for kid, r, t, c in await session.execute(query)}


async def _to_out(
    session: AsyncSession, key: ApiKey, *, lifetime: tuple[int, int, float], now: datetime
) -> ApiKeyOut:
    usage = await limits.measure(session, key.id, limits.key_rules(key), now=now)
    return ApiKeyOut(
        id=key.id,
        name=key.name,
        key_hint=key.key_hint,
        enabled=key.enabled,
        status=key_status(key, now),
        expires_at=key.expires_at,
        max_requests_per_window=key.max_requests_per_window,
        max_tokens_per_window=key.max_tokens_per_window,
        max_cost_usd_per_window=key.max_cost_usd_per_window,
        window_seconds=key.window_seconds,
        pinned_account_id=key.pinned_account_id,
        allowed_models=key.allowed_models,
        enforced_model=key.enforced_model,
        assigned_account_ids=key.assigned_account_ids,
        limits=[
            LimitUsageOut(
                id=u.spec.id,
                source=u.spec.source,
                metric=u.spec.metric,
                window=u.spec.window,
                window_seconds=u.spec.window_seconds,
                max_value=u.spec.max_value,
                model_filter=u.spec.model_filter,
                current_value=u.current_value,
                remaining=max(0.0, u.spec.max_value - u.current_value),
                used_percent=min(100.0, u.current_value / u.spec.max_value * 100),
                window_start=u.window_start,
                resets_at=u.resets_at,
            )
            for u in usage
        ],
        total_requests=key.total_requests,
        total_cost_usd=key.total_cost_usd,
        total_tokens=lifetime[1],
        lifetime_requests=lifetime[0],
        lifetime_cost_usd=lifetime[2],
        last_used_at=key.last_used_at,
        created_at=key.created_at,
    )


async def _out(session: AsyncSession, key: ApiKey) -> ApiKeyOut:
    lifetime = (await _lifetime(session, [key.id])).get(key.id, _NO_USAGE)
    return await _to_out(session, key, lifetime=lifetime, now=datetime.now(UTC))


async def _get_key(session: AsyncSession, key_id: str) -> ApiKey:
    key = await session.get(ApiKey, key_id)
    if key is None:
        raise HTTPException(404, "API key not found")
    return key


async def _check_accounts(session: AsyncSession, account_ids: list[str] | None) -> None:
    if not account_ids:
        return
    found = set((await session.execute(select(Account.id).where(Account.id.in_(account_ids)))).scalars())
    missing = [a for a in account_ids if a not in found]
    if missing:
        raise HTTPException(422, f"unknown account id(s): {', '.join(missing)}")


async def _check_name_free(session: AsyncSession, name: str, *, except_id: str | None = None) -> None:
    existing = (await session.execute(select(ApiKey).where(ApiKey.name == name))).scalar_one_or_none()
    if existing is not None and existing.id != except_id:
        raise HTTPException(409, f"a key named {name!r} already exists")


# ---- routes -------------------------------------------------------------------------


@router.get("", response_model=list[ApiKeyOut])
async def list_keys(session: SessionDep) -> list[ApiKeyOut]:
    keys = list((await session.execute(select(ApiKey).order_by(ApiKey.name))).scalars())
    lifetime = await _lifetime(session, [k.id for k in keys])
    now = datetime.now(UTC)
    return [await _to_out(session, k, lifetime=lifetime.get(k.id, _NO_USAGE), now=now) for k in keys]


class KeyUsageRow(BaseModel):
    id: str
    name: str
    key_hint: str
    requests: int
    total_tokens: int
    cost_usd: float


class KeysOverviewOut(BaseModel):
    total: int
    active: int
    disabled: int
    expired: int
    idle: int
    """Active keys with no request in the last 7 days (or never used)."""
    used_last_7d: int
    lifetime_requests: int
    lifetime_cost_usd: float
    lifetime_tokens: int
    by_key: list[KeyUsageRow]
    """Lifetime usage per live key from the daily rollups, highest cost first. The
    lifetime totals above are sums of these rows."""


@router.get("/overview", response_model=KeysOverviewOut)
async def keys_overview(session: SessionDep) -> KeysOverviewOut:
    keys = list((await session.execute(select(ApiKey))).scalars())
    now = datetime.now(UTC)
    idle_cutoff = now - timedelta(days=7)
    statuses = [key_status(k, now) for k in keys]
    recent = [(_aware(k.last_used_at) or datetime.min.replace(tzinfo=UTC)) >= idle_cutoff for k in keys]

    rollups = await _lifetime(session)
    by_key = sorted(
        (
            KeyUsageRow(
                id=k.id,
                name=k.name,
                key_hint=k.key_hint,
                requests=rollups.get(k.id, _NO_USAGE)[0],
                total_tokens=rollups.get(k.id, _NO_USAGE)[1],
                cost_usd=rollups.get(k.id, _NO_USAGE)[2],
            )
            for k in keys
        ),
        key=lambda row: (-row.cost_usd, -row.total_tokens, row.name),
    )
    return KeysOverviewOut(
        total=len(keys),
        active=statuses.count("active"),
        disabled=statuses.count("disabled"),
        expired=statuses.count("expired"),
        idle=sum(1 for s, r in zip(statuses, recent, strict=True) if s == "active" and not r),
        used_last_7d=sum(recent),
        lifetime_requests=sum(row.requests for row in by_key),
        lifetime_cost_usd=sum(row.cost_usd for row in by_key),
        lifetime_tokens=sum(row.total_tokens for row in by_key),
        by_key=by_key,
    )


@router.post("", response_model=ApiKeyCreated, status_code=201)
async def create_key(payload: ApiKeyCreate, request: Request, session: SessionDep) -> ApiKeyCreated:
    await _check_name_free(session, payload.name)
    await _check_accounts(session, payload.assigned_account_ids)

    fields = payload.model_dump(exclude={"limits"})
    issued = await create_api_key(
        session, **fields, limits=[rule.to_input() for rule in payload.limits or []]
    )
    await audit.record(
        session,
        action="api_key.created",
        target=issued.record.name,
        detail=f"hint …{issued.record.key_hint}",
        client_ip=client_ip(request),
    )
    out = await _out(session, issued.record)
    return ApiKeyCreated(api_key=issued.plaintext, **out.model_dump())


@router.get("/{key_id}", response_model=ApiKeyOut)
async def get_key(key_id: str, session: SessionDep) -> ApiKeyOut:
    return await _out(session, await _get_key(session, key_id))


@router.patch("/{key_id}", response_model=ApiKeyOut)
async def update_key(
    key_id: str,
    request: Request,
    session: SessionDep,
    enabled: bool | None = Query(default=None, description="Legacy form: ?enabled=true|false."),
    payload: Annotated[ApiKeyUpdate | None, Body()] = None,
) -> ApiKeyOut:
    key = await _get_key(session, key_id)
    payload = payload or ApiKeyUpdate()
    sent = set(payload.model_fields_set)
    if enabled is not None and "enabled" not in sent:
        payload.enabled = enabled
        sent.add("enabled")
    if not sent:
        raise HTTPException(422, "nothing to update")

    changed: list[str] = []
    if "name" in sent and payload.name is not None and payload.name != key.name:
        await _check_name_free(session, payload.name, except_id=key.id)
        key.name = payload.name
        changed.append("name")
    if "expires_at" in sent:
        key.expires_at = payload.expires_at
        changed.append("expires_at")
    if "allowed_models" in sent:
        key.allowed_models = payload.allowed_models
        changed.append("allowed_models")
    if "enforced_model" in sent:
        key.enforced_model = payload.enforced_model
        changed.append("enforced_model")
    if "assigned_account_ids" in sent:
        await _check_accounts(session, payload.assigned_account_ids)
        key.assigned_account_ids = payload.assigned_account_ids
        changed.append("assigned_account_ids")
    if "pinned_account_id" in sent:
        key.pinned_account_id = payload.pinned_account_id
        changed.append("pinned_account_id")
    for field in ("max_requests_per_window", "max_tokens_per_window", "max_cost_usd_per_window"):
        if field in sent:
            setattr(key, field, getattr(payload, field))
            changed.append(field)
    if "window_seconds" in sent and payload.window_seconds is not None:
        key.window_seconds = payload.window_seconds
        changed.append("window_seconds")
    if "limits" in sent:
        replace_limit_rules(key, [rule.to_input() for rule in payload.limits or []])
        changed.append("limits")

    toggled = "enabled" in sent and payload.enabled is not None and payload.enabled != key.enabled
    if "enabled" in sent and payload.enabled is not None:
        key.enabled = payload.enabled
    await session.flush()

    ip = client_ip(request)
    if toggled or (sent == {"enabled"}):
        await audit.record(
            session,
            action="api_key.enabled" if key.enabled else "api_key.disabled",
            target=key.name,
            client_ip=ip,
        )
    if changed:
        await audit.record(
            session, action="api_key.updated", target=key.name, detail=", ".join(changed), client_ip=ip
        )
    # Re-read so the rule rows come back with their ids.
    await session.refresh(key, attribute_names=["limit_rules"])
    return await _out(session, key)


@router.post("/{key_id}/regenerate", response_model=ApiKeyCreated)
async def regenerate_key(key_id: str, request: Request, session: SessionDep) -> ApiKeyCreated:
    """New secret, same key: limits, history and settings stay. The old secret stops working."""
    key = await _get_key(session, key_id)
    issued = await regenerate_api_key(session, key)
    await audit.record(
        session,
        action="api_key.regenerated",
        target=key.name,
        detail=f"hint …{key.key_hint}",
        client_ip=client_ip(request),
    )
    out = await _out(session, issued.record)
    return ApiKeyCreated(api_key=issued.plaintext, **out.model_dump())


class KeyTrendDay(BaseModel):
    day: str
    requests: int
    errors: int
    input_tokens: int
    output_tokens: int
    cache_read_input_tokens: int
    cache_creation_input_tokens: int
    total_tokens: int
    cost_usd: float


class KeyTrendTotals(BaseModel):
    requests: int
    errors: int
    input_tokens: int
    output_tokens: int
    cache_read_input_tokens: int
    cache_creation_input_tokens: int
    total_tokens: int
    cost_usd: float


class KeyAccountCost(BaseModel):
    account_id: str | None
    account_name: str | None
    plan_type: str | None
    deleted: bool
    requests: int
    total_tokens: int
    cost_usd: float


class KeyModelUsage(BaseModel):
    model: str | None
    requests: int
    total_tokens: int
    cost_usd: float


class KeyTrendsOut(BaseModel):
    key_id: str
    days: int
    usage: list[KeyTrendDay]
    totals: KeyTrendTotals
    by_account: list[KeyAccountCost]
    by_model: list[KeyModelUsage]


@router.get("/{key_id}/trends", response_model=KeyTrendsOut)
async def key_trends(
    key_id: str, session: SessionDep, days: int = Query(default=7, ge=1, le=90)
) -> KeyTrendsOut:
    """Daily usage, cost by account and by model for one key, from the daily rollups
    (UTC days, zero-filled; not limited by request-log retention)."""
    await _get_key(session, key_id)
    today = datetime.now(UTC).date()
    start_day = (today - timedelta(days=days - 1)).isoformat()
    where = (UsageDaily.api_key_id == key_id, UsageDaily.day >= start_day)
    sums = (
        func.coalesce(func.sum(UsageDaily.requests), 0),
        func.coalesce(func.sum(UsageDaily.errors), 0),
        func.coalesce(func.sum(UsageDaily.input_tokens), 0),
        func.coalesce(func.sum(UsageDaily.output_tokens), 0),
        func.coalesce(func.sum(UsageDaily.cache_read_input_tokens), 0),
        func.coalesce(func.sum(UsageDaily.cache_creation_input_tokens), 0),
        func.coalesce(func.sum(UsageDaily.cost_usd), 0.0),
    )

    def _day(values) -> dict:
        req, err, inp, out, cread, cwrite, cost = values
        return {
            "requests": int(req),
            "errors": int(err),
            "input_tokens": int(inp),
            "output_tokens": int(out),
            "cache_read_input_tokens": int(cread),
            "cache_creation_input_tokens": int(cwrite),
            "total_tokens": int(inp + out + cread + cwrite),
            "cost_usd": float(cost),
        }

    by_day = {
        row[0]: _day(row[1:])
        for row in await session.execute(select(UsageDaily.day, *sums).where(*where).group_by(UsageDaily.day))
    }
    zero = _day((0, 0, 0, 0, 0, 0, 0.0))
    usage = [
        KeyTrendDay(day=day, **by_day.get(day, zero))
        for day in ((today - timedelta(days=offset)).isoformat() for offset in range(days - 1, -1, -1))
    ]
    totals = KeyTrendTotals(
        **{field: sum(getattr(d, field) for d in usage) for field in KeyTrendTotals.model_fields}
    )

    accounts = {
        a.id: a for a in (await session.execute(select(Account))).scalars()
    }
    by_account = [
        KeyAccountCost(
            account_id=account_id,
            account_name=accounts[account_id].name if account_id in accounts else None,
            plan_type=accounts[account_id].plan_type if account_id in accounts else None,
            deleted=account_id is not None and account_id not in accounts,
            requests=int(req),
            total_tokens=int(tokens),
            cost_usd=float(cost),
        )
        for account_id, req, tokens, cost in await session.execute(
            select(
                UsageDaily.account_id,
                func.coalesce(func.sum(UsageDaily.requests), 0),
                func.coalesce(func.sum(_TOKENS), 0),
                func.coalesce(func.sum(UsageDaily.cost_usd), 0.0),
            )
            .where(*where)
            .group_by(UsageDaily.account_id)
        )
    ]
    by_account.sort(key=lambda row: (-row.cost_usd, -row.requests))
    by_model = sorted(
        (
            KeyModelUsage(model=model, requests=int(req), total_tokens=int(tokens), cost_usd=float(cost))
            for model, req, tokens, cost in await session.execute(
                select(
                    UsageDaily.model,
                    func.coalesce(func.sum(UsageDaily.requests), 0),
                    func.coalesce(func.sum(_TOKENS), 0),
                    func.coalesce(func.sum(UsageDaily.cost_usd), 0.0),
                )
                .where(*where)
                .group_by(UsageDaily.model)
            )
        ),
        key=lambda row: (-row.cost_usd, -row.requests),
    )
    return KeyTrendsOut(
        key_id=key_id, days=days, usage=usage, totals=totals, by_account=by_account, by_model=by_model
    )


@router.delete("/{key_id}", status_code=204)
async def delete_key(key_id: str, request: Request, session: SessionDep) -> None:
    key = await _get_key(session, key_id)
    await audit.record(session, action="api_key.deleted", target=key.name, client_ip=client_ip(request))
    await session.delete(key)
