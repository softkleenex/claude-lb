"""Weekly (7-day window) pacing across the subscription pool.

Ported from codex-lb ``app/modules/dashboard/weekly_pace.py`` (MIT). Two signals:

* the schedule gap: how much of the pool is used now versus a linear schedule that
  would spend each account's weekly allowance evenly until its reset;
* the forecast: whether the recent burn rate drains the pool before the resets
  refill it, and by how much (the shortfall).

Differences from codex-lb: claude-lb only observes an account's quota when traffic
passes through it, so an idle account is not dropped as "stale" — its last reading
still holds. Staleness only lowers the confidence. Credits are claude-lb's plan
capacity credits (a Pro plan is 100).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from math import ceil
from typing import Literal

from claude_lb.db.models import Account, QuotaHistory
from claude_lb.modules.proxy import quota as quota_mod

RECENT_BURN_WINDOW = timedelta(hours=6)
STALE_AFTER = timedelta(hours=6)
SMOOTHING_WINDOW_MINUTES = 30
PRO_WEEKLY_CAPACITY_CREDITS = quota_mod.PLAN_CAPACITY_CREDITS["pro"]

PaceStatus = Literal["behind", "on_track", "ahead", "danger"]


@dataclass
class _PaceAccount:
    full_credits: float
    remaining_credits: float
    reset_at: float
    window: float


@dataclass
class _Projection:
    shortfall_credits: float
    depletion_hours: float | None
    minimum_remaining_credits: float


def is_subscription(account: Account) -> bool:
    return (account.plan_type or "api") != "api"


def build_weekly_pace(
    accounts: Sequence[Account],
    history: dict[str, list[QuotaHistory]],
    *,
    now: datetime,
) -> dict | None:
    now_s = now.timestamp()
    pace_accounts: list[_PaceAccount] = []
    stale = inactive = rate_samples = 0
    total_full = total_actual = total_smoothed = total_expected = 0.0
    scheduled_rate = forecast_rate_sum = 0.0

    for account in accounts:
        if not is_subscription(account):
            continue
        if not account.enabled:
            inactive += 1
            continue
        reset = quota_mod.as_aware(account.secondary_reset_at)
        used = quota_mod.effective_secondary_used(account, now=now)
        if reset is None or used is None:
            stale += 1
            continue
        window = float(account.secondary_window_minutes or quota_mod.DEFAULT_SECONDARY_WINDOW_MINUTES) * 60.0
        full = quota_mod.effective_capacity_credits(account)
        reset_s = _advance(reset.timestamp(), window, now_s)
        remaining = full * (1.0 - min(max(used, 0.0), 100.0) / 100.0)

        rows = history.get(account.id, [])
        observed = quota_mod.as_aware(account.quota_observed_at)
        if observed is None or now - observed > STALE_AFTER:
            stale += 1

        elapsed = _clamp(now_s - (reset_s - window), 0.0, window)
        expected = full * (1.0 - elapsed / window)
        rate = _recent_rate_credits_per_hour(rows, full, now)
        smoothed = _smoothed_remaining(rows, full, remaining, now)

        total_full += full
        total_actual += remaining
        total_smoothed += smoothed
        total_expected += expected
        scheduled_rate += full * 3600.0 / window
        if rate is not None:
            rate_samples += 1
            forecast_rate_sum += rate
        pace_accounts.append(_PaceAccount(full, remaining, reset_s, window))

    if not pace_accounts or total_full <= 0:
        return None

    actual_used = 100.0 * (total_full - total_actual) / total_full
    scheduled_used = 100.0 * (total_full - total_expected) / total_full
    smoothed_used = 100.0 * (total_full - total_smoothed) / total_full
    delta = actual_used - scheduled_used
    smoothed_delta = smoothed_used - scheduled_used
    gap = max(0.0, total_expected - total_actual)
    smoothed_gap = max(0.0, total_expected - total_smoothed)

    forecast_rate = forecast_rate_sum if rate_samples > 0 else None
    projection = _project(pace_accounts, now_s, forecast_rate)
    shortfall = projection.shortfall_credits
    pace_multiplier = (
        forecast_rate / scheduled_rate if forecast_rate is not None and scheduled_rate > 0 else None
    )
    pause_hours = shortfall / forecast_rate if forecast_rate and shortfall > 0 else None
    throttle_to = (
        _clamp(scheduled_rate / forecast_rate * 100.0, 0.0, 100.0)
        if forecast_rate and scheduled_rate > 0 and shortfall > 0
        else None
    )
    pro_equivalent = shortfall / PRO_WEEKLY_CAPACITY_CREDITS if shortfall > 0 else None

    return {
        "total_full_credits": round(total_full, 4),
        "total_actual_remaining_credits": round(total_actual, 4),
        "total_expected_remaining_credits": round(total_expected, 4),
        "actual_used_percent": round(actual_used, 4),
        "scheduled_used_percent": round(scheduled_used, 4),
        "delta_percent": round(delta, 4),
        "smoothed_delta_percent": round(smoothed_delta, 4),
        "schedule_gap_credits": round(gap, 4),
        "smoothed_schedule_gap_credits": round(smoothed_gap, 4),
        "smoothing_minutes": SMOOTHING_WINDOW_MINUTES,
        "projected_shortfall_credits": round(shortfall, 4),
        "projected_depletion_hours": projection.depletion_hours,
        "projected_minimum_remaining_credits": round(projection.minimum_remaining_credits, 4),
        "forecast_burn_rate_credits_per_hour": forecast_rate,
        "scheduled_burn_rate_credits_per_hour": round(scheduled_rate, 6),
        "pace_multiplier": pace_multiplier,
        "pause_for_break_even_hours": pause_hours,
        "throttle_to_percent": throttle_to,
        "reduce_by_percent": 100.0 - throttle_to if throttle_to is not None else None,
        "pro_account_equivalent": pro_equivalent,
        "pro_accounts_to_cover": ceil(pro_equivalent) if pro_equivalent is not None else None,
        "status": _status(smoothed_delta, shortfall),
        "account_count": len(pace_accounts),
        "stale_account_count": stale,
        "inactive_account_count": inactive,
        "confidence": _confidence(len(pace_accounts), rate_samples, stale),
    }


def _recent_rate_credits_per_hour(rows: list[QuotaHistory], full: float, now: datetime) -> float | None:
    start = now - RECENT_BURN_WINDOW
    recent = [
        r for r in rows if (rec := quota_mod.as_aware(r.recorded_at)) is not None and start <= rec <= now
    ]
    samples = quota_mod.history_samples(recent, window="secondary", now=now)
    if len(samples) < 2:
        return None
    rate = quota_mod.ewma_rate(samples)
    if rate is None:
        return None
    # percent per second -> credits per hour
    return max(0.0, rate * full * 36.0)


def _smoothed_remaining(rows: list[QuotaHistory], full: float, current: float, now: datetime) -> float:
    start = now - timedelta(minutes=SMOOTHING_WINDOW_MINUTES)
    latest = max(rows, key=lambda r: quota_mod.as_aware(r.recorded_at) or now, default=None)
    latest_reset = quota_mod.as_aware(latest.secondary_reset_at) if latest is not None else None
    values = [
        full * (1.0 - _clamp(float(r.secondary_used_percent), 0.0, 100.0) / 100.0)
        for r in rows
        if r.secondary_used_percent is not None
        and (rec := quota_mod.as_aware(r.recorded_at)) is not None
        and start <= rec <= now
        and (latest_reset is None or quota_mod.as_aware(r.secondary_reset_at) == latest_reset)
    ]
    if not values:
        return current
    return _clamp(sum(values) / len(values), 0.0, full)


def _project(accounts: list[_PaceAccount], now_s: float, rate_per_hour: float | None) -> _Projection:
    total = sum(a.remaining_credits for a in accounts)
    if rate_per_hour is None or rate_per_hour <= 0:
        return _Projection(0.0, None, total)

    per_second = rate_per_hour / 3600.0
    sim = [[a.full_credits, a.remaining_credits, a.reset_at, a.window] for a in accounts]
    horizon = now_s + max(a.window for a in accounts) * 2.0
    cursor = now_s
    minimum = total
    while cursor < horizon:
        sim.sort(key=lambda a: a[2])
        nxt = sim[0]
        event = min(nxt[2], horizon)
        burn = per_second * max(0.0, event - cursor)
        balance = sum(a[1] for a in sim)
        if burn > balance:
            wait = balance / per_second
            return _Projection(burn - balance, (cursor - now_s + wait) / 3600.0, 0.0)
        left = burn
        for a in sim:  # drain the soonest-resetting accounts first
            take = min(a[1], left)
            a[1] -= take
            left -= take
            if left <= 0:
                break
        minimum = min(minimum, sum(a[1] for a in sim))
        cursor = event
        if cursor >= horizon:
            break
        nxt[1] = nxt[0]
        nxt[2] += nxt[3]
    return _Projection(0.0, None, minimum)


def _advance(reset_s: float, window: float, now_s: float) -> float:
    if reset_s > now_s:
        return reset_s
    missed = int((now_s - reset_s) // window) + 1
    return reset_s + missed * window


def _status(delta: float, shortfall: float) -> PaceStatus:
    if shortfall > 0:
        return "danger"
    if delta < -5:
        return "behind"
    if delta > 5:
        return "ahead"
    return "on_track"


def _confidence(accounts: int, rate_samples: int, stale: int) -> Literal["high", "medium", "low"]:
    if rate_samples >= accounts and stale == 0:
        return "high"
    if rate_samples > 0:
        return "medium"
    return "low"


def _clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, value))
