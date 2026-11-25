"""Account selection.

Selection is pure with respect to the account rows handed in: `select_account` never
touches the DB, which keeps it trivially testable. Callers load the candidate set,
select, then record the outcome via `record_success` / `record_failure`.
"""

from __future__ import annotations

import itertools
import random
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

from claude_lb.db.models import Account
from claude_lb.modules.proxy.quota import (
    apply_unified_quota,
    as_aware,
    effective_capacity_credits,
    effective_primary_used,
    effective_secondary_used,
)

STRATEGIES = (
    "capacity_weighted",
    "relative_availability",
    "usage_weighted",
    "reset_drain",
    "sequential_drain",
    "round_robin",
    "least_used",
    "fill_first",
    "single_account",
)

# Relative availability constants (matching codex-lb)
RELATIVE_AVAILABILITY_MIN_DIVISOR_SECONDS = 5 * 60
UNKNOWN_RESET_FALLBACK_SECONDS = 7 * 24 * 60 * 60
RELATIVE_AVAILABILITY_POWER = 2.0
RELATIVE_AVAILABILITY_MIN_WEIGHT_FRACTION = 0.1
RELATIVE_AVAILABILITY_TOP_K = 5

# Failures needed before an account is taken out of rotation.
FAILURE_THRESHOLD = 3
# Backoff applied per consecutive failure, capped.
FAILURE_BACKOFF_SECONDS = 30
MAX_BACKOFF_SECONDS = 900

_round_robin_counter = itertools.count()


class NoAccountAvailable(RuntimeError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _as_aware(value: datetime | None) -> datetime | None:
    """SQLite hands back naive datetimes even for timezone=True columns."""
    return as_aware(value)


def top_policy_tier(available: list[Account]) -> list[Account]:
    """The accounts of the highest routing_policy tier present (burn_first > normal > preserve)."""
    for policy in ("burn_first", "normal", "preserve"):
        tier = [a for a in available if (getattr(a, "routing_policy", None) or "normal") == policy]
        if tier:
            return tier
    return available


PAUSED_REASON = "paused by operator"
"""`disabled_reason` of an account the operator switched off.

Kept distinct from breaker-disabled accounts so the health probe does not quietly
put a paused account back into rotation.
"""


def is_paused(account: Account) -> bool:
    return not account.enabled and account.disabled_reason == PAUSED_REASON


def spend_cap_reached(account: Account) -> bool:
    cap = getattr(account, "spend_cap_usd", None)
    return cap is not None and (account.total_cost_usd or 0.0) >= cap


def is_available(account: Account, *, now: datetime | None = None) -> bool:
    now = now or datetime.now(UTC)
    if not account.enabled:
        return False
    if spend_cap_reached(account):
        return False

    quota_status = getattr(account, "quota_status", "active") or "active"
    if quota_status == "rate_limited":
        pri_reset = _as_aware(getattr(account, "primary_reset_at", None))
        if pri_reset is None or pri_reset > now:
            return False
    elif quota_status == "quota_exceeded":
        sec_reset = _as_aware(getattr(account, "secondary_reset_at", None))
        if sec_reset is None or sec_reset > now:
            return False

    cooldown = _as_aware(account.cooldown_until)
    if cooldown is not None and cooldown > now:
        # If quota_status already expired above, don't let a stale quota cooldown block it.
        if quota_status == "active":
            return False
        if quota_status == "rate_limited":
            pri_reset = _as_aware(getattr(account, "primary_reset_at", None))
            if pri_reset is None or pri_reset > now:
                return False
        elif quota_status == "quota_exceeded":
            sec_reset = _as_aware(getattr(account, "secondary_reset_at", None))
            if sec_reset is None or sec_reset > now:
                return False
    return True


def headroom(account: Account, *, now: datetime | None = None) -> float:
    """Fraction of the account's rate-limit budget believed to remain, in ``[0, 1]``.

    Considers both standard ``anthropic-ratelimit-*`` buckets and subscription
    dual-window (5h primary / 7d secondary) utilization. Accounts never called
    return 1.0 so a fresh pool spreads out instead of piling onto the first key.
    """
    now = now or datetime.now(UTC)
    fractions: list[float] = []

    reset_at = _as_aware(account.rl_reset_at)
    if reset_at is None or reset_at > now:
        if account.rl_requests_limit:
            fractions.append((account.rl_requests_remaining or 0) / account.rl_requests_limit)
        if account.rl_tokens_limit:
            fractions.append((account.rl_tokens_remaining or 0) / account.rl_tokens_limit)

    pri_used = effective_primary_used(account, now=now)
    if pri_used is not None:
        fractions.append(1.0 - pri_used / 100.0)
    sec_used = effective_secondary_used(account, now=now)
    if sec_used is not None:
        fractions.append(1.0 - sec_used / 100.0)

    if not fractions:
        return 1.0
    return max(0.0, min(1.0, min(fractions)))


def select_account(
    accounts: Sequence[Account],
    *,
    strategy: str = "capacity_weighted",
    exclude_ids: Sequence[str] = (),
    pinned_account_id: str | None = None,
    preferred_account_id: str | None = None,
    now: datetime | None = None,
) -> Account:
    """Pick one account, or raise :class:`NoAccountAvailable`.

    ``pinned_account_id`` is a hard constraint (an API key bound to one account): if it
    cannot be served, the request fails. ``preferred_account_id`` is a soft hint from
    session affinity: honoured when usable, silently ignored otherwise.
    """
    now = now or datetime.now(UTC)
    excluded = set(exclude_ids)

    if not accounts:
        raise NoAccountAvailable("no accounts configured")

    pool = [a for a in accounts if a.id not in excluded]
    if not pool:
        raise NoAccountAvailable("every account was already tried for this request")

    if pinned_account_id is not None:
        for account in pool:
            if account.id == pinned_account_id:
                if not is_available(account, now=now):
                    raise NoAccountAvailable(f"pinned account {account.name} is unavailable")
                return account
        raise NoAccountAvailable("pinned account not found or already tried")

    available = [a for a in pool if is_available(a, now=now)]
    if not available:
        raise NoAccountAvailable("all accounts are disabled or cooling down")

    if preferred_account_id is not None:
        # `single_account` exists to force every request onto one account, so affinity
        # must not override it; every other strategy defers to the warm cache.
        if strategy != "single_account":
            for account in available:
                if account.id == preferred_account_id:
                    return account

    if strategy == "single_account":
        # Deterministic: the highest-priority enabled account, no spreading.
        return max(available, key=lambda a: (a.priority, a.name))

    effective_pool = top_policy_tier(available)

    if strategy == "round_robin":
        return effective_pool[next(_round_robin_counter) % len(effective_pool)]

    if strategy == "least_used":
        return min(effective_pool, key=lambda a: (a.total_requests, a.name))

    if strategy == "fill_first":
        # Drain the highest-priority account while it still has headroom.
        ordered = sorted(effective_pool, key=lambda a: (-a.priority, a.name))
        for account in ordered:
            if headroom(account, now=now) > 0.05:
                return account
        return ordered[0]

    if strategy == "sequential_drain":
        ordered = sorted(effective_pool, key=lambda a: (a.priority, a.name))
        for account in ordered:
            if headroom(account, now=now) > 0.05:
                return account
        return ordered[0]

    if strategy == "usage_weighted":
        return min(
            effective_pool,
            key=lambda a: (
                effective_secondary_used(a, now=now) or 0.0,
                effective_primary_used(a, now=now) or 0.0,
                (_as_aware(a.last_used_at) or datetime.min.replace(tzinfo=UTC)),
                a.name,
            ),
        )

    if strategy == "reset_drain":
        def _reset_drain_key(a: Account) -> tuple[int, float, float, str]:
            sec_reset = _as_aware(getattr(a, "secondary_reset_at", None))
            pri_reset = _as_aware(getattr(a, "primary_reset_at", None))
            reset = sec_reset or pri_reset or _as_aware(a.rl_reset_at)
            has_reset = 0 if (reset is not None and reset > now) else 1
            remaining_sec = (
                (reset - now).total_seconds() if (reset is not None and reset > now) else float("inf")
            )
            used = effective_secondary_used(a, now=now) or effective_primary_used(a, now=now) or 0.0
            return (has_reset, remaining_sec, used, a.name)

        return min(effective_pool, key=_reset_drain_key)

    if strategy == "relative_availability":
        return _select_relative_availability(effective_pool, now=now)

    # capacity_weighted (default): weighted random over remaining headroom * capacity/weight.
    weights = [
        max(a.weight if a.weight is not None else 1.0, 0.0)
        * (effective_capacity_credits(a) / 100.0)
        * headroom(a, now=now)
        for a in effective_pool
    ]
    total = sum(weights)
    if total <= 0:
        # Everything is reportedly exhausted; fall back to the one that resets soonest.
        return min(
            effective_pool,
            key=lambda a: (
                _as_aware(getattr(a, "primary_reset_at", None))
                or _as_aware(getattr(a, "secondary_reset_at", None))
                or _as_aware(a.rl_reset_at)
                or now + timedelta(days=1),
                a.name,
            ),
        )
    return random.choices(effective_pool, weights=weights, k=1)[0]


def _select_relative_availability(available: list[Account], *, now: datetime) -> Account:
    """codex-lb style relative availability: remaining_credits / time_until_reset."""
    raw_scores: list[tuple[Account, float]] = []
    for account in available:
        cap = effective_capacity_credits(account) * max(
            account.weight if account.weight is not None else 1.0, 0.0
        )
        sec_used = effective_secondary_used(account, now=now)
        pri_used = effective_primary_used(account, now=now)
        used = sec_used if sec_used is not None else (pri_used if pri_used is not None else 0.0)
        remaining_credits = max(0.0, cap * (1.0 - min(used, 100.0) / 100.0))
        if pri_used is not None and pri_used >= 100.0:
            remaining_credits = 0.0

        reset_at = _as_aware(getattr(account, "secondary_reset_at", None)) or _as_aware(
            getattr(account, "primary_reset_at", None)
        )
        if reset_at is None:
            remaining_seconds = float(UNKNOWN_RESET_FALLBACK_SECONDS)
        else:
            remaining_seconds = max(0.0, (reset_at - now).total_seconds())
        divisor = max(remaining_seconds, float(RELATIVE_AVAILABILITY_MIN_DIVISOR_SECONDS))
        raw_scores.append((account, remaining_credits / divisor if remaining_credits > 0 else 0.0))

    best = max((score for _, score in raw_scores), default=0.0)
    if best <= 0.0:
        return min(
            available,
            key=lambda a: (
                effective_secondary_used(a, now=now) or 0.0,
                effective_primary_used(a, now=now) or 0.0,
                a.name,
            ),
        )

    weighted: list[tuple[Account, float, float]] = []
    for account, raw in raw_scores:
        weight = (raw / best) ** RELATIVE_AVAILABILITY_POWER
        if weight >= RELATIVE_AVAILABILITY_MIN_WEIGHT_FRACTION:
            weighted.append((account, weight, raw))

    if not weighted:
        return available[0]

    weighted.sort(
        key=lambda item: (
            -item[1],
            -item[2],
            effective_secondary_used(item[0], now=now) or 0.0,
            item[0].name,
        )
    )
    top_k = weighted[:RELATIVE_AVAILABILITY_TOP_K]
    candidates = [item[0] for item in top_k]
    weights = [item[1] for item in top_k]
    return random.choices(candidates, weights=weights, k=1)[0]


def apply_rate_limit_headers(account: Account, headers: dict[str, str]) -> None:
    """Fold Anthropic's ``anthropic-ratelimit-*`` response headers into the account row."""
    lowered = {k.lower(): v for k, v in headers.items()}

    def _int(name: str) -> int | None:
        raw = lowered.get(name)
        if raw is None:
            return None
        try:
            return int(raw)
        except ValueError:
            return None

    requests_limit = _int("anthropic-ratelimit-requests-limit")
    requests_remaining = _int("anthropic-ratelimit-requests-remaining")

    # Prefer the combined token bucket; fall back to summing input+output buckets.
    tokens_limit = _int("anthropic-ratelimit-tokens-limit")
    tokens_remaining = _int("anthropic-ratelimit-tokens-remaining")
    if tokens_limit is None:
        input_limit = _int("anthropic-ratelimit-input-tokens-limit")
        output_limit = _int("anthropic-ratelimit-output-tokens-limit")
        if input_limit is not None or output_limit is not None:
            tokens_limit = (input_limit or 0) + (output_limit or 0)
            tokens_remaining = (_int("anthropic-ratelimit-input-tokens-remaining") or 0) + (
                _int("anthropic-ratelimit-output-tokens-remaining") or 0
            )

    if requests_limit is not None:
        account.rl_requests_limit = requests_limit
        account.rl_requests_remaining = requests_remaining
    if tokens_limit is not None:
        account.rl_tokens_limit = tokens_limit
        account.rl_tokens_remaining = tokens_remaining

    reset_raw = (
        lowered.get("anthropic-ratelimit-tokens-reset")
        or lowered.get("anthropic-ratelimit-requests-reset")
        or lowered.get("anthropic-ratelimit-input-tokens-reset")
    )
    if reset_raw:
        try:
            account.rl_reset_at = datetime.fromisoformat(reset_raw.replace("Z", "+00:00"))
        except ValueError:
            pass

    if requests_limit is not None or tokens_limit is not None or reset_raw:
        account.rl_observed_at = datetime.now(UTC)

    apply_unified_quota(account, headers)


def record_success(account: Account) -> None:
    account.consecutive_failures = 0
    account.disabled_reason = None
    if (getattr(account, "quota_status", None) or "active") == "active":
        account.cooldown_until = None
    account.last_used_at = datetime.now(UTC)


def record_failure(
    account: Account,
    *,
    status_code: int | None,
    retry_after_seconds: float | None = None,
    reason: str = "",
) -> None:
    """Update circuit-breaker state after a failed upstream attempt.

    Auth failures disable the account outright — retrying a revoked key just burns
    requests. Rate limits cool down until the window resets. Everything else backs off
    and only trips the breaker after `FAILURE_THRESHOLD` consecutive failures.
    """
    now = datetime.now(UTC)

    if status_code in (401, 402, 403):
        account.enabled = False
        account.disabled_reason = reason or f"upstream returned {status_code}"
        account.cooldown_until = None
        return

    if status_code == 429:
        existing_quota_status = getattr(account, "quota_status", "active")
        existing_cooldown = _as_aware(account.cooldown_until)
        if existing_quota_status in ("rate_limited", "quota_exceeded") and (
            existing_cooldown is not None and existing_cooldown > now
        ):
            # Preserve unified 5h/7d reset window set by apply_unified_quota.
            return
        wait = retry_after_seconds
        if wait is None:
            reset_at = _as_aware(account.rl_reset_at)
            wait = (reset_at - now).total_seconds() if reset_at and reset_at > now else 60.0
        account.cooldown_until = now + timedelta(seconds=max(1.0, min(wait, MAX_BACKOFF_SECONDS)))
        account.rl_requests_remaining = 0
        account.rl_tokens_remaining = 0
        return

    account.consecutive_failures += 1
    if account.consecutive_failures >= FAILURE_THRESHOLD:
        backoff = min(
            FAILURE_BACKOFF_SECONDS * account.consecutive_failures,
            MAX_BACKOFF_SECONDS,
        )
        account.cooldown_until = now + timedelta(seconds=backoff)
        account.disabled_reason = reason or f"{account.consecutive_failures} consecutive failures"
