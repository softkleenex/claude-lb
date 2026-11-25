"""Models an upstream refuses for one account, learned from live traffic.

A subscription (bearer) token called from outside Claude Code can be refused for some
models while others work. The refusal is a 429 with none of the
``anthropic-ratelimit-unified-*`` headers a real quota rejection carries. Treating it as a
rate limit cooled the whole account down, so one Sonnet request knocked out an account
that was still serving Haiku. Instead we remember the (account, model) pair and route
that model elsewhere for a while.
"""

from __future__ import annotations

import json
import time

from claude_lb.db.models import Account

BLOCK_TTL_SECONDS = 12 * 3600
"""Re-test a blocked model after this long, in case the upstream policy changed."""


def is_model_refusal(account: Account, status_code: int, headers: dict[str, str]) -> bool:
    if status_code != 429 or (account.plan_type or "api") == "api":
        return False
    lowered = {k.lower() for k in headers}
    return "anthropic-ratelimit-unified-status" not in lowered


def _load(account: Account) -> dict[str, float]:
    try:
        raw = json.loads(account.model_blocks_json or "{}")
    except ValueError:
        return {}
    return {str(k): float(v) for k, v in raw.items()} if isinstance(raw, dict) else {}


def active_blocks(account: Account, *, now: float | None = None) -> list[str]:
    now = now if now is not None else time.time()
    return sorted(model for model, until in _load(account).items() if until > now)


def active_block_expiries(account: Account, *, now: float | None = None) -> list[tuple[str, float]]:
    """Active blocks with the unix time each one lifts, sorted by model."""
    now = now if now is not None else time.time()
    return sorted((model, until) for model, until in _load(account).items() if until > now)


def remove_block(account: Account, model: str) -> bool:
    """Lift one model's block. Returns whether it was blocked."""
    blocks = _load(account)
    if model not in blocks:
        return False
    del blocks[model]
    account.model_blocks_json = json.dumps(blocks)
    return True


def is_blocked(account: Account, model: str | None, *, now: float | None = None) -> bool:
    return bool(model) and model in active_blocks(account, now=now)


def add_block(account: Account, model: str, *, now: float | None = None) -> None:
    now = now if now is not None else time.time()
    blocks = {m: until for m, until in _load(account).items() if until > now}
    blocks[model] = now + BLOCK_TTL_SECONDS
    account.model_blocks_json = json.dumps(blocks)


def clear_blocks(account: Account) -> None:
    account.model_blocks_json = "{}"
