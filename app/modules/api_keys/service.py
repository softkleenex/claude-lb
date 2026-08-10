"""Authentication and per-key budgets for locally issued proxy keys."""

from __future__ import annotations

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


async def authenticate(session: AsyncSession, presented_key: str) -> ApiKey:
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

    await _enforce_window_budget(session, record)

    record.last_used_at = datetime.now(UTC)
    return record


async def _enforce_window_budget(session: AsyncSession, key: ApiKey) -> None:
    limits = (key.max_requests_per_window, key.max_tokens_per_window, key.max_cost_usd_per_window)
    if not any(limit is not None for limit in limits):
        return

    since = datetime.now(UTC) - timedelta(seconds=key.window_seconds)
    result = await session.execute(
        select(
            func.count(RequestLog.id),
            func.coalesce(func.sum(RequestLog.input_tokens + RequestLog.output_tokens), 0),
            func.coalesce(func.sum(RequestLog.cost_usd), 0.0),
        ).where(RequestLog.api_key_id == key.id, RequestLog.created_at >= since)
    )
    requests, tokens, cost = result.one()

    window = f"{key.window_seconds}s window"
    if key.max_requests_per_window is not None and requests >= key.max_requests_per_window:
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
