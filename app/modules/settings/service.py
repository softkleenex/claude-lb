"""Runtime configuration.

Env vars set the defaults; anything stored in the ``settings`` table overrides them
and takes effect on the next request — no restart. Reads go through a process-local
cache invalidated on write, so the hot proxy path does not hit the DB for config.

Note the cache is per-process: with multiple workers, a change made on one worker is
picked up by the others within ``_CACHE_TTL_SECONDS``.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.models import Setting
from app.modules.proxy.load_balancer import STRATEGIES

logger = logging.getLogger(__name__)

_CACHE_TTL_SECONDS = 5.0
_cache: RuntimeSettings | None = None
_cached_at: float = 0.0


class RuntimeSettings(BaseModel):
    """The subset of configuration an operator can change while the server runs.

    Deliberately excluded: bind address, data directory, secret key, and
    `require_api_key` — flipping those from a web form would either not take effect
    or would silently drop the proxy's authentication.
    """

    routing_strategy: str = "capacity_weighted"
    max_attempts: int = Field(default=3, ge=1, le=10)

    sticky_sessions_enabled: bool = True
    sticky_ttl_seconds: int = Field(default=900, ge=0, le=24 * 3600)

    health_probe_enabled: bool = True
    health_probe_interval_seconds: int = Field(default=120, ge=30, le=3600)

    model_sync_enabled: bool = True
    model_sync_interval_seconds: int = Field(default=3600, ge=300, le=24 * 3600)

    request_log_retention_days: int = Field(default=30, ge=1, le=3650)

    @field_validator("routing_strategy")
    @classmethod
    def _known_strategy(cls, value: str) -> str:
        if value not in STRATEGIES:
            raise ValueError(f"unknown routing strategy {value!r}; expected one of {', '.join(STRATEGIES)}")
        return value


def _defaults_from_env() -> RuntimeSettings:
    env = get_settings()
    return RuntimeSettings(
        routing_strategy=env.routing_strategy,
        max_attempts=env.max_attempts,
        request_log_retention_days=env.request_log_retention_days,
    )


async def load(session: AsyncSession, *, use_cache: bool = True) -> RuntimeSettings:
    global _cache, _cached_at

    if use_cache and _cache is not None and (time.monotonic() - _cached_at) < _CACHE_TTL_SECONDS:
        return _cache

    result = await session.execute(select(Setting))
    stored: dict[str, Any] = {}
    for row in result.scalars():
        try:
            stored[row.key] = json.loads(row.value_json)
        except ValueError:
            logger.warning("ignoring unparseable setting %r", row.key)

    known = {k: v for k, v in stored.items() if k in RuntimeSettings.model_fields}
    try:
        settings = _defaults_from_env().model_copy(update=known)
        # Re-validate: a value written before a validator tightened would otherwise slip through.
        settings = RuntimeSettings.model_validate(settings.model_dump())
    except ValueError as exc:
        logger.error("stored settings are invalid (%s); falling back to env defaults", exc)
        settings = _defaults_from_env()

    _cache, _cached_at = settings, time.monotonic()
    return settings


async def update(session: AsyncSession, changes: dict[str, Any]) -> RuntimeSettings:
    """Validate and persist a partial update. Returns the new effective settings."""
    unknown = set(changes) - set(RuntimeSettings.model_fields)
    if unknown:
        raise ValueError(f"unknown setting(s): {', '.join(sorted(unknown))}")

    current = await load(session, use_cache=False)
    # Validate the merged result so cross-field rules apply, not just the delta.
    merged = RuntimeSettings.model_validate({**current.model_dump(), **changes})

    for key in changes:
        # Persist the validated/coerced value from `merged`, not the raw input.
        encoded = json.dumps(getattr(merged, key))
        existing = await session.get(Setting, key)
        if existing is None:
            session.add(Setting(key=key, value_json=encoded))
        else:
            existing.value_json = encoded

    await session.flush()
    invalidate()
    logger.info("runtime settings updated: %s", ", ".join(sorted(changes)))
    return merged


async def reset(session: AsyncSession) -> RuntimeSettings:
    """Drop all overrides and fall back to the env defaults."""
    result = await session.execute(select(Setting))
    for row in result.scalars():
        await session.delete(row)
    await session.flush()
    invalidate()
    return _defaults_from_env()


def invalidate() -> None:
    global _cache, _cached_at
    _cache, _cached_at = None, 0.0
