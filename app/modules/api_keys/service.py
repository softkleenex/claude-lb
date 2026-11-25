"""Authentication and per-key budgets for locally issued proxy keys."""

from __future__ import annotations

import asyncio
import itertools
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.crypto import (
    generate_local_api_key,
    hash_local_api_key,
)
from app.db.models import ApiKey, RequestLog


class AuthError(Exception):
    def __init__(self, message: str, status_code: int = 401) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


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
    )
    session.add(record)
    await session.flush()
    return IssuedKey(record=record, plaintext=plaintext)


# ---- in-flight accounting ---------------------------------------------------------
#
# A budget check that only counts *logged* requests lets a burst through: none of the
# concurrent requests has been logged yet when the others check, and a stream is not
# logged until it ends. So every admitted request holds a slot until its log row is
# written, and the request cap counts those slots too. Check-and-take is serialized
# per key, or two checks could both see the last free slot.
#
# This is per process. With several workers each enforces the cap on its own share.

_inflight: dict[str, dict[int, float]] = {}
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


def inflight_count(key_id: str) -> int:
    slots = _inflight.get(key_id)
    if not slots:
        return 0
    cutoff = time.monotonic() - INFLIGHT_STALE_SECONDS
    for ticket in [t for t, started in slots.items() if started < cutoff]:
        del slots[ticket]
    return len(slots)


def _take_slot(key_id: str) -> int:
    ticket = next(_tickets)
    _inflight.setdefault(key_id, {})[ticket] = time.monotonic()
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
    """Held until the request is logged; ``None`` when the key has no budget."""

    def release(self) -> None:
        if self.ticket is not None:
            release_slot(self.key.id, self.ticket)
            self.ticket = None


async def admit(session: AsyncSession, presented_key: str) -> Admission:
    """Authenticate a key and, if it has a budget, reserve an in-flight slot.

    The caller must call :meth:`Admission.release` once the request has been logged.
    """
    record = await _resolve(session, presented_key)
    if not _has_budget(record):
        return Admission(record, None)
    async with _key_lock(record.id):
        await _enforce_window_budget(session, record, inflight=inflight_count(record.id))
        return Admission(record, _take_slot(record.id))


def _has_budget(key: ApiKey) -> bool:
    return any(
        limit is not None
        for limit in (key.max_requests_per_window, key.max_tokens_per_window, key.max_cost_usd_per_window)
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


async def _enforce_window_budget(session: AsyncSession, key: ApiKey, *, inflight: int = 0) -> None:
    """Refuse the request if the key's rolling window is spent.

    The request cap counts in-flight requests as well as logged ones. Token and spend
    caps can only count what has been logged — an in-flight request's size is not
    known until it finishes — so they may be overshot by whatever is in flight.
    """
    if not _has_budget(key):
        return

    since = datetime.now(UTC) - timedelta(seconds=key.window_seconds)
    result = await session.execute(
        select(
            func.count(RequestLog.id),
            # Every token the key caused to be processed, cache traffic included.
            func.coalesce(
                func.sum(
                    RequestLog.input_tokens
                    + RequestLog.output_tokens
                    + RequestLog.cache_creation_input_tokens
                    + RequestLog.cache_read_input_tokens
                ),
                0,
            ),
            func.coalesce(func.sum(RequestLog.cost_usd), 0.0),
        ).where(RequestLog.api_key_id == key.id, RequestLog.created_at >= since)
    )
    requests, tokens, cost = result.one()

    window = f"{key.window_seconds}s window"
    if key.max_requests_per_window is not None and requests + inflight >= key.max_requests_per_window:
        raise AuthError(
            f"request limit reached for this key ({key.max_requests_per_window} per {window})",
            status_code=429,
        )
    if key.max_tokens_per_window is not None and tokens >= key.max_tokens_per_window:
        raise AuthError(
            f"token limit reached for this key ({key.max_tokens_per_window} per {window})",
            status_code=429,
        )
    if key.max_cost_usd_per_window is not None and cost >= key.max_cost_usd_per_window:
        raise AuthError(
            f"spend limit reached for this key (${key.max_cost_usd_per_window:.2f} per {window})",
            status_code=429,
        )
