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

from app.db.models import Account

STRATEGIES = (
    "capacity_weighted",
    "round_robin",
    "least_used",
    "fill_first",
    "single_account",
)

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
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value


def is_available(account: Account, *, now: datetime | None = None) -> bool:
    now = now or datetime.now(UTC)
    if not account.enabled:
        return False
    cooldown = _as_aware(account.cooldown_until)
    if cooldown is not None and cooldown > now:
        return False
    return True


def headroom(account: Account, *, now: datetime | None = None) -> float:
    """Fraction of the account's rate-limit budget believed to remain, in ``[0, 1]``.

    Accounts we have never called return 1.0 so a fresh pool spreads out instead of
    piling onto whichever account happens to be first.
    """
    now = now or datetime.now(UTC)

    reset_at = _as_aware(account.rl_reset_at)
    if reset_at is not None and reset_at <= now:
        # The window rolled over; last-seen remaining values are stale.
        return 1.0

    fractions: list[float] = []
    if account.rl_requests_limit:
        fractions.append((account.rl_requests_remaining or 0) / account.rl_requests_limit)
    if account.rl_tokens_limit:
        fractions.append((account.rl_tokens_remaining or 0) / account.rl_tokens_limit)

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

    if strategy == "round_robin":
        return available[next(_round_robin_counter) % len(available)]

    if strategy == "least_used":
        return min(available, key=lambda a: (a.total_requests, a.name))

    if strategy == "fill_first":
        # Drain the highest-priority account while it still has headroom.
        ordered = sorted(available, key=lambda a: (-a.priority, a.name))
        for account in ordered:
            if headroom(account, now=now) > 0.05:
                return account
        return ordered[0]

    # capacity_weighted (default): weighted random over remaining headroom.
    weights = [max(a.weight, 0.0) * headroom(a, now=now) for a in available]
    total = sum(weights)
    if total <= 0:
        # Everything is reportedly exhausted; fall back to the one that resets soonest.
        return min(
            available,
            key=lambda a: (_as_aware(a.rl_reset_at) or now + timedelta(days=1), a.name),
        )
    return random.choices(available, weights=weights, k=1)[0]


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


def record_success(account: Account) -> None:
    account.consecutive_failures = 0
    account.disabled_reason = None
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

    if status_code in (401, 403):
        account.enabled = False
        account.disabled_reason = reason or f"upstream returned {status_code}"
        account.cooldown_until = None
        return

    if status_code == 429:
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
