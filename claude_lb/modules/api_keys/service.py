"""Authentication and per-key budgets for locally issued proxy keys."""

from __future__ import annotations

import asyncio
import itertools
import math
import time
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from claude_lb.core.crypto import (
    generate_local_api_key,
    hash_local_api_key,
)
from claude_lb.db.models import ApiKey, ApiKeyLimitRule
from claude_lb.modules.api_keys import limits as limits_mod


class AuthError(Exception):
    def __init__(
        self,
        message: str,
        status_code: int = 401,
        *,
        error_type: str | None = None,
        retry_after: int | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.error_type = error_type or ("rate_limit_error" if status_code == 429 else "authentication_error")
        self.retry_after = retry_after


@dataclass
class IssuedKey:
    record: ApiKey
    plaintext: str
    """Returned exactly once at creation; only the hash is stored."""


def _as_aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=UTC)


async def create_api_key(
    session: AsyncSession,
    *,
    name: str,
    expires_at: datetime | None = None,
    max_requests_per_window: int | None = None,
    max_tokens_per_window: int | None = None,
    max_cost_usd_per_window: float | None = None,
    window_seconds: int = 3600,
    pinned_account_id: str | None = None,
    allowed_models: list[str] | None = None,
    enforced_model: str | None = None,
    assigned_account_ids: list[str] | None = None,
    limits: list[LimitRuleInput] | None = None,
) -> IssuedKey:
    plaintext = generate_local_api_key()
    record = ApiKey(
        name=name,
        key_hash=hash_local_api_key(plaintext),
        key_hint=plaintext[-6:],
        expires_at=expires_at,
        max_requests_per_window=max_requests_per_window,
        max_tokens_per_window=max_tokens_per_window,
        max_cost_usd_per_window=max_cost_usd_per_window,
        window_seconds=window_seconds,
        pinned_account_id=pinned_account_id,
        enforced_model=enforced_model,
    )
    record.allowed_models = allowed_models
    record.assigned_account_ids = assigned_account_ids
    record.limit_rules = [rule.to_row(position) for position, rule in enumerate(limits or [])]
    session.add(record)
    await session.flush()
    return IssuedKey(record=record, plaintext=plaintext)


async def regenerate_api_key(session: AsyncSession, record: ApiKey) -> IssuedKey:
    """Issue a new secret for an existing key. The old secret stops working at once."""
    plaintext = generate_local_api_key()
    record.key_hash = hash_local_api_key(plaintext)
    record.key_hint = plaintext[-6:]
    await session.flush()
    return IssuedKey(record=record, plaintext=plaintext)


@dataclass(frozen=True)
class LimitRuleInput:
    metric: str
    window: str
    max_value: float
    window_seconds: int | None = None
    model_filter: str | None = None

    def to_row(self, position: int) -> ApiKeyLimitRule:
        return ApiKeyLimitRule(
            position=position,
            metric=self.metric,
            window=self.window,
            window_seconds=limits_mod.window_seconds_for(self.window, self.window_seconds),
            max_value=self.max_value,
            model_filter=self.model_filter or None,
        )


def replace_limit_rules(record: ApiKey, rules: list[LimitRuleInput]) -> None:
    """Make ``rules`` the key's complete set of limits.

    The key's original single budget is shown alongside its rules as ``legacy`` rules,
    so an editor that sends back everything it showed has already carried it over —
    the legacy fields are cleared here instead of being counted twice.
    """
    record.limit_rules = [rule.to_row(position) for position, rule in enumerate(rules)]
    record.max_requests_per_window = None
    record.max_tokens_per_window = None
    record.max_cost_usd_per_window = None


# ---- in-flight accounting ---------------------------------------------------------
#
# A budget check that only counts *logged* requests lets a burst through: none of the
# concurrent requests has been logged yet when the others check, and a stream is not
# logged until it ends. So every admitted request holds a slot until its log row is
# written, and the request cap counts those slots too. Check-and-take is serialized
# per key, or two checks could both see the last free slot.
#
# This is per process. With several workers each enforces the cap on its own share.

_inflight: dict[str, dict[int, tuple[float, str | None]]] = {}
_tickets = itertools.count()
_locks: dict[tuple[int, str], asyncio.Lock] = {}

# A slot whose request somehow never released it (a crash between admit and log)
# stops counting after this long, so a leak cannot lock a key out forever.
INFLIGHT_STALE_SECONDS = 15 * 60


def _key_lock(key_id: str) -> asyncio.Lock:
    loop_key = (id(asyncio.get_running_loop()), key_id)
    lock = _locks.get(loop_key)
    if lock is None:
        lock = _locks[loop_key] = asyncio.Lock()
    return lock


def inflight_count(key_id: str, model_filter: str | None = None) -> int:
    """Admitted-but-unlogged requests for a key, optionally only those for a model."""
    slots = _inflight.get(key_id)
    if not slots:
        return 0
    cutoff = time.monotonic() - INFLIGHT_STALE_SECONDS
    for ticket in [t for t, (started, _) in slots.items() if started < cutoff]:
        del slots[ticket]
    if model_filter is None:
        return len(slots)
    return sum(1 for _, model in slots.values() if limits_mod.model_matches(model_filter, model))


def _take_slot(key_id: str, model: str | None = None) -> int:
    ticket = next(_tickets)
    _inflight.setdefault(key_id, {})[ticket] = (time.monotonic(), model)
    return ticket


def release_slot(key_id: str, ticket: int) -> None:
    slots = _inflight.get(key_id)
    if slots is not None:
        slots.pop(ticket, None)
        if not slots:
            _inflight.pop(key_id, None)


@dataclass
class Admission:
    key: ApiKey
    ticket: int | None
    """Held until the request is logged; ``None`` when the key has no limits."""
    model: str | None = None
    """The model the request will actually use (the key's enforced model, if any)."""

    def release(self) -> None:
        if self.ticket is not None:
            release_slot(self.key.id, self.ticket)
            self.ticket = None


async def admit(session: AsyncSession, presented_key: str, model: str | None = None) -> Admission:
    """Authenticate a key, apply its model policy and, if it has limits, reserve an
    in-flight slot.

    ``model`` is the model named in the request body, if any. The caller must call
    :meth:`Admission.release` once the request has been logged.
    """
    record = await _resolve(session, presented_key)
    effective = effective_model(record, model)
    check_model_allowed(record, effective)
    specs = [s for s in limits_mod.key_rules(record) if limits_mod.model_matches(s.model_filter, effective)]
    if not specs:
        return Admission(record, None, effective)
    async with _key_lock(record.id):
        await _enforce_limits(session, record, specs, model=effective)
        return Admission(record, _take_slot(record.id, effective), effective)


def effective_model(key: ApiKey, requested: str | None) -> str | None:
    """The model a request will run on: the key's enforced model replaces the client's."""
    if key.enforced_model and requested is not None:
        return key.enforced_model
    return requested


def check_model_allowed(key: ApiKey, model: str | None) -> None:
    """Refuse a model outside the key's allowlist. Requests that name no model (model
    listing, files) are not model requests and pass."""
    allowed = key.allowed_models
    if allowed is None or model is None:
        return
    if any(limits_mod.model_matches(entry, model) for entry in allowed):
        return
    raise AuthError(
        f"this API key is not allowed to use model {model!r} (allowed: {', '.join(allowed) or 'none'})",
        status_code=403,
        error_type="permission_error",
    )


async def _resolve(session: AsyncSession, presented_key: str) -> ApiKey:
    """Resolve a presented key, or raise :class:`AuthError`."""
    result = await session.execute(select(ApiKey).where(ApiKey.key_hash == hash_local_api_key(presented_key)))
    record = result.scalar_one_or_none()
    if record is None:
        raise AuthError("invalid API key")
    if not record.enabled:
        raise AuthError("API key is disabled", status_code=403)

    expires_at = _as_aware(record.expires_at)
    if expires_at is not None and expires_at <= datetime.now(UTC):
        raise AuthError("API key has expired", status_code=403)

    record.last_used_at = datetime.now(UTC)
    return record


async def _enforce_limits(
    session: AsyncSession, key: ApiKey, specs: list[limits_mod.RuleSpec], *, model: str | None
) -> None:
    """Refuse the request if any applicable rule is used up.

    Request rules count in-flight requests as well as logged ones. Token and spend
    rules can only count what has been logged — an in-flight request's size is not
    known until it finishes — so they may be overshot by whatever is in flight.
    """
    now = datetime.now(UTC)
    for usage in await limits_mod.measure(session, key.id, specs, now=now):
        spec = usage.spec
        value = usage.current_value
        if spec.metric == "requests":
            value += inflight_count(key.id, spec.model_filter)
        if value < spec.max_value:
            continue
        retry_after = None
        message = f"limit reached for this key: {limits_mod.describe(spec)}"
        if usage.resets_at is not None:
            retry_after = max(1, math.ceil((usage.resets_at - now).total_seconds()))
            message += f"; usage frees up at {usage.resets_at.strftime('%Y-%m-%dT%H:%M:%SZ')}"
        raise AuthError(message, status_code=429, retry_after=retry_after)
