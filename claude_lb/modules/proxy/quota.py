"""Subscription plan metadata, Anthropic unified quota headers, and depletion pacing.

Mirrors codex-lb's dual-window (5h primary / 7d secondary) quota model and EWMA
depletion risk math for Claude Pro / Max / Team / Enterprise subscription pooling.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal

from claude_lb.db.models import Account, QuotaHistory

PLAN_TYPES: tuple[str, ...] = (
    "api",
    "free",
    "pro",
    "max",
    "max_5x",
    "max_20x",
    "team",
    "enterprise",
)

PLAN_CAPACITY_CREDITS: dict[str, float] = {
    "free": 10.0,
    "pro": 100.0,
    "api": 100.0,
    "team": 150.0,
    "enterprise": 300.0,
    "max": 500.0,
    "max_5x": 500.0,
    "max_20x": 2000.0,
}

ROUTING_POLICIES: tuple[str, ...] = ("normal", "burn_first", "preserve")
QUOTA_STATUSES: tuple[str, ...] = ("active", "rate_limited", "quota_exceeded")

DEFAULT_PRIMARY_WINDOW_MINUTES = 5 * 60
DEFAULT_SECONDARY_WINDOW_MINUTES = 7 * 24 * 60

RISK_WARNING = 0.60
RISK_DANGER = 0.80
RISK_CRITICAL = 0.95
DEFAULT_EWMA_ALPHA = 0.4


def as_aware(value: datetime | None) -> datetime | None:
    """Normalize SQLite naive datetimes to UTC-aware datetimes."""
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def normalize_plan_type(value: str | None, *, default: str = "api") -> str:
    if not value:
        return default
    cleaned = value.strip().lower()
    return cleaned if cleaned in PLAN_TYPES else default


def effective_capacity_credits(account: Account) -> float:
    if account.capacity_credits is not None and account.capacity_credits > 0:
        return float(account.capacity_credits)
    return PLAN_CAPACITY_CREDITS.get((account.plan_type or "api").lower(), 100.0)


def effective_primary_used(account: Account, *, now: datetime | None = None) -> float | None:
    """Return current 5h utilization %, or 0.0 if the window already reset."""
    if account.primary_used_percent is None:
        return None
    current = now or datetime.now(UTC)
    reset_at = as_aware(account.primary_reset_at)
    if reset_at is not None and reset_at <= current:
        return 0.0
    return max(0.0, min(100.0, float(account.primary_used_percent)))


def effective_secondary_used(account: Account, *, now: datetime | None = None) -> float | None:
    """Return current 7d utilization %, or 0.0 if the window already reset."""
    if account.secondary_used_percent is None:
        return None
    current = now or datetime.now(UTC)
    reset_at = as_aware(account.secondary_reset_at)
    if reset_at is not None and reset_at <= current:
        return 0.0
    return max(0.0, min(100.0, float(account.secondary_used_percent)))


@dataclass(frozen=True, slots=True)
class UnifiedRateLimitSample:
    primary_used_percent: float | None = None
    primary_reset_at: datetime | None = None
    primary_status: str | None = None
    secondary_used_percent: float | None = None
    secondary_reset_at: datetime | None = None
    secondary_status: str | None = None
    unified_status: str | None = None
    overage_status: str | None = None
    fallback_reset_at: datetime | None = None


def _parse_utilization(raw: str | None) -> float | None:
    if raw is None:
        return None
    try:
        val = float(raw.strip())
    except ValueError:
        return None
    if val < 0.0:
        return 0.0
    # Anthropic sends 0.0..1.0 fractions; tolerate 0..100 percentages if > 1.0.
    pct = val * 100.0 if val <= 1.0 else val
    return min(100.0, pct)


def _parse_reset_timestamp(raw: str | None) -> datetime | None:
    if not raw:
        return None
    text = raw.strip()
    try:
        epoch = float(text)
        return datetime.fromtimestamp(epoch, tz=UTC)
    except ValueError:
        pass
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=UTC)
    except ValueError:
        return None


def parse_unified_headers(headers: dict[str, str]) -> UnifiedRateLimitSample | None:
    """Extract ``anthropic-ratelimit-unified-*`` subscription quota headers."""
    lowered = {k.lower(): v for k, v in headers.items()}
    if not any(k.startswith("anthropic-ratelimit-unified-") for k in lowered):
        return None

    return UnifiedRateLimitSample(
        primary_used_percent=_parse_utilization(lowered.get("anthropic-ratelimit-unified-5h-utilization")),
        primary_reset_at=_parse_reset_timestamp(lowered.get("anthropic-ratelimit-unified-5h-reset")),
        primary_status=lowered.get("anthropic-ratelimit-unified-5h-status"),
        secondary_used_percent=_parse_utilization(lowered.get("anthropic-ratelimit-unified-7d-utilization")),
        secondary_reset_at=_parse_reset_timestamp(lowered.get("anthropic-ratelimit-unified-7d-reset")),
        secondary_status=lowered.get("anthropic-ratelimit-unified-7d-status"),
        unified_status=lowered.get("anthropic-ratelimit-unified-status"),
        overage_status=lowered.get("anthropic-ratelimit-unified-overage-status"),
        fallback_reset_at=_parse_reset_timestamp(lowered.get("anthropic-ratelimit-unified-reset")),
    )


def apply_unified_quota(
    account: Account,
    headers: dict[str, str],
    *,
    now: datetime | None = None,
) -> bool:
    """Fold ``anthropic-ratelimit-unified-*`` headers into ``account`` and update ``quota_status``.

    Returns ``True`` if unified headers were found and applied.
    """
    sample = parse_unified_headers(headers)
    if sample is None:
        return False

    current = now or datetime.now(UTC)

    if sample.primary_used_percent is not None:
        account.primary_used_percent = sample.primary_used_percent
        account.primary_window_minutes = account.primary_window_minutes or DEFAULT_PRIMARY_WINDOW_MINUTES
    if sample.primary_reset_at is not None:
        account.primary_reset_at = sample.primary_reset_at
    elif sample.fallback_reset_at is not None and account.primary_reset_at is None:
        account.primary_reset_at = sample.fallback_reset_at

    if sample.secondary_used_percent is not None:
        account.secondary_used_percent = sample.secondary_used_percent
        account.secondary_window_minutes = (
            account.secondary_window_minutes or DEFAULT_SECONDARY_WINDOW_MINUTES
        )
    if sample.secondary_reset_at is not None:
        account.secondary_reset_at = sample.secondary_reset_at

    if sample.unified_status is not None:
        account.unified_status = sample.unified_status.strip().lower()
    if sample.overage_status is not None:
        account.overage_status = sample.overage_status.strip().lower()
    account.quota_observed_at = current

    overage_allowed = (account.overage_status or "").lower() == "allowed"
    sec_used = effective_secondary_used(account, now=current)
    pri_used = effective_primary_used(account, now=current)

    sec_exhausted = (sec_used is not None and sec_used >= 100.0) or (
        (sample.secondary_status or "").lower() == "rejected"
    )
    pri_exhausted = (pri_used is not None and pri_used >= 100.0) or (
        (sample.primary_status or "").lower() == "rejected"
    )
    overall_rejected = (sample.unified_status or "").lower() == "rejected"

    if not overage_allowed and sec_exhausted:
        account.quota_status = "quota_exceeded"
        reset_at = as_aware(account.secondary_reset_at) or as_aware(sample.fallback_reset_at)
        if reset_at is not None and reset_at > current:
            account.cooldown_until = reset_at
        else:
            account.cooldown_until = current + timedelta(minutes=DEFAULT_SECONDARY_WINDOW_MINUTES)
    elif not overage_allowed and (pri_exhausted or overall_rejected):
        account.quota_status = "rate_limited"
        reset_at = (
            as_aware(account.primary_reset_at)
            or as_aware(sample.fallback_reset_at)
            or as_aware(account.secondary_reset_at)
        )
        if reset_at is not None and reset_at > current:
            account.cooldown_until = reset_at
        else:
            account.cooldown_until = current + timedelta(minutes=DEFAULT_PRIMARY_WINDOW_MINUTES)
    else:
        account.quota_status = "active"
        if account.cooldown_until is not None and (
            (pri_used is None or pri_used < 100.0) and (sec_used is None or sec_used < 100.0)
        ):
            # Clear quota-driven cooldown if fresh headers prove availability.
            account.cooldown_until = None

    return True


def reconcile_expired_quota(account: Account, *, now: datetime | None = None) -> None:
    """Clear stale quota blocks once their reset timestamp has passed."""
    current = now or datetime.now(UTC)
    if account.quota_status == "rate_limited":
        reset_at = as_aware(account.primary_reset_at)
        if reset_at is not None and reset_at <= current:
            account.quota_status = "active"
            account.primary_used_percent = 0.0
            account.cooldown_until = None
    elif account.quota_status == "quota_exceeded":
        reset_at = as_aware(account.secondary_reset_at)
        if reset_at is not None and reset_at <= current:
            account.quota_status = "active"
            account.secondary_used_percent = 0.0
            account.primary_used_percent = 0.0
            account.cooldown_until = None


# ---- EWMA burn rate & depletion risk (from codex-lb depletion.py) --------


@dataclass
class EWMAState:
    rate: float | None
    last_used_percent: float
    last_timestamp: float
    last_reset_at: float | None = None


def ewma_update(
    state: EWMAState | None,
    used_percent: float,
    timestamp: float,
    alpha: float = DEFAULT_EWMA_ALPHA,
    reset_at: float | None = None,
) -> EWMAState:
    if state is None:
        return EWMAState(
            rate=None,
            last_used_percent=used_percent,
            last_timestamp=timestamp,
            last_reset_at=reset_at,
        )

    dt = timestamp - state.last_timestamp
    if dt <= 0:
        return state

    window_changed = (
        reset_at is not None and state.last_reset_at is not None and reset_at != state.last_reset_at
    )
    drop = state.last_used_percent - used_percent
    if drop > 0 or window_changed:
        return EWMAState(
            rate=None,
            last_used_percent=used_percent,
            last_timestamp=timestamp,
            last_reset_at=reset_at,
        )

    delta_percent = used_percent - state.last_used_percent
    raw_rate = max(delta_percent / dt, 0.0)
    rate = raw_rate if state.rate is None else (alpha * raw_rate) + ((1.0 - alpha) * state.rate)
    return EWMAState(
        rate=rate,
        last_used_percent=used_percent,
        last_timestamp=timestamp,
        last_reset_at=reset_at,
    )


def compute_burn_rate(
    current_rate: float,
    remaining_percent: float,
    seconds_until_reset: float,
) -> float:
    if current_rate <= 0 or seconds_until_reset <= 0:
        return 0.0
    sustainable_rate = remaining_percent / seconds_until_reset
    if sustainable_rate <= 0:
        return 0.0
    return current_rate / sustainable_rate


def compute_depletion_risk(
    used_percent: float,
    rate_per_second: float,
    seconds_until_reset: float,
) -> float:
    effective_rate = max(0.0, rate_per_second)
    projected = used_percent + (effective_rate * max(0.0, seconds_until_reset))
    return max(0.0, min(projected / 100.0, 1.0))


def compute_safe_usage_percent(
    seconds_elapsed: float,
    total_window_seconds: float,
) -> float:
    if total_window_seconds <= 0:
        return 0.0
    progress = min(max(seconds_elapsed / total_window_seconds, 0.0), 1.0)
    return progress * 100.0


def classify_risk(risk: float) -> Literal["safe", "warning", "danger", "critical"]:
    if risk >= RISK_CRITICAL:
        return "critical"
    if risk >= RISK_DANGER:
        return "danger"
    if risk >= RISK_WARNING:
        return "warning"
    return "safe"


def _window_risk(
    samples: Sequence[tuple[float, float, float | None]],
    *,
    current_used: float | None,
    reset_at: datetime | None,
    now: datetime,
) -> float:
    if current_used is None:
        return 0.0
    if current_used >= 100.0:
        return 1.0

    state: EWMAState | None = None
    for ts, used, rst in samples:
        state = ewma_update(state, used, ts, reset_at=rst)

    reset_aware = as_aware(reset_at)
    if reset_aware is None:
        return min(current_used / 100.0, 1.0)

    seconds_left = max(0.0, (reset_aware - now).total_seconds())
    rate = state.rate if state and state.rate is not None else 0.0
    return compute_depletion_risk(current_used, rate, seconds_left)


def compute_account_risk(
    history: Sequence[QuotaHistory],
    account: Account,
    *,
    now: datetime | None = None,
) -> tuple[float, Literal["safe", "warning", "danger", "critical"]]:
    """Compute overall depletion risk [0..1] and risk level from QuotaHistory."""
    current = now or datetime.now(UTC)
    ordered = sorted(history, key=lambda h: as_aware(h.recorded_at) or current)

    pri_samples: list[tuple[float, float, float | None]] = []
    sec_samples: list[tuple[float, float, float | None]] = []
    for row in ordered:
        rec = as_aware(row.recorded_at)
        if rec is None:
            continue
        ts = rec.timestamp()
        if row.primary_used_percent is not None:
            pri_rst = as_aware(row.primary_reset_at)
            pri_samples.append((ts, row.primary_used_percent, pri_rst.timestamp() if pri_rst else None))
        if row.secondary_used_percent is not None:
            sec_rst = as_aware(row.secondary_reset_at)
            sec_samples.append((ts, row.secondary_used_percent, sec_rst.timestamp() if sec_rst else None))

    pri_risk = _window_risk(
        pri_samples,
        current_used=effective_primary_used(account, now=current),
        reset_at=account.primary_reset_at,
        now=current,
    )
    sec_risk = _window_risk(
        sec_samples,
        current_used=effective_secondary_used(account, now=current),
        reset_at=account.secondary_reset_at,
        now=current,
    )
    risk = max(pri_risk, sec_risk)
    return round(risk, 4), classify_risk(risk)
