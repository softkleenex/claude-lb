"""Dashboard overview (window totals, deltas, sparklines) and subscription projections."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import Integer, case, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from claude_lb import __version__
from claude_lb.core.pricing import cache_read_savings_usd
from claude_lb.db.models import Account, QuotaHistory, RequestLog
from claude_lb.modules.dashboard import pace
from claude_lb.modules.dashboard.timeframes import Timeframe
from claude_lb.modules.proxy import load_balancer as lb
from claude_lb.modules.proxy import quota as quota_mod
from claude_lb.modules.settings import service as settings_service

_SUMS = (
    func.count(RequestLog.id),
    func.coalesce(func.sum(case((RequestLog.status_code >= 400, 1), else_=0)), 0),
    func.coalesce(func.sum(RequestLog.input_tokens), 0),
    func.coalesce(func.sum(RequestLog.output_tokens), 0),
    func.coalesce(func.sum(RequestLog.cache_read_input_tokens), 0),
    func.coalesce(func.sum(RequestLog.cache_creation_input_tokens), 0),
    func.coalesce(func.sum(RequestLog.cost_usd), 0.0),
)
_FIELDS = (
    "requests",
    "errors",
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "cost_usd",
)


def _empty() -> dict:
    return dict.fromkeys(_FIELDS, 0) | {"cost_usd": 0.0, "cache_savings_usd": 0.0}


def _add(target: dict, model: str | None, values) -> None:
    for name, value in zip(_FIELDS, values, strict=True):
        target[name] += value or 0
    target["cache_savings_usd"] += cache_read_savings_usd(model, int(values[4] or 0))


def _finish(acc: dict) -> dict:
    prompt = acc["input_tokens"] + acc["cache_read_input_tokens"] + acc["cache_creation_input_tokens"]
    out = dict(acc)
    out["total_tokens"] = prompt + acc["output_tokens"]
    out["cache_hit_rate"] = round(acc["cache_read_input_tokens"] / prompt, 4) if prompt else 0.0
    out["error_rate"] = round(acc["errors"] / acc["requests"], 4) if acc["requests"] else 0.0
    out["cost_usd"] = round(acc["cost_usd"], 6)
    out["cache_savings_usd"] = round(acc["cache_savings_usd"], 6)
    return out


def _epoch_seconds(dialect: str):
    if dialect == "sqlite":
        # SQLite stores naive UTC text; julianday() reads it, 2440587.5 is the Unix epoch.
        return (func.julianday(RequestLog.created_at) - 2440587.5) * 86400.0
    return func.extract("epoch", RequestLog.created_at)


def _bucket_index(dialect: str, since: datetime, bucket_seconds: int):
    offset = (_epoch_seconds(dialect) - since.timestamp()) / bucket_seconds
    # CAST truncates in SQLite (values here are >= 0); Postgres would round, so floor first.
    return cast(offset if dialect == "sqlite" else func.floor(offset), Integer)


async def _window_metrics(session: AsyncSession, since: datetime, until: datetime) -> dict:
    window = (RequestLog.created_at >= since, RequestLog.created_at < until)
    acc = _empty()
    for row in await session.execute(
        select(RequestLog.model, *_SUMS).where(*window).group_by(RequestLog.model)
    ):
        _add(acc, row[0], row[1:])
    metrics = _finish(acc)

    conversations, avg_duration, avg_ttft = (
        await session.execute(
            select(
                func.count(func.distinct(RequestLog.session_key)),
                func.avg(RequestLog.duration_ms),
                func.avg(RequestLog.ttft_ms),
            ).where(*window)
        )
    ).one()
    metrics["conversations"] = int(conversations or 0)
    metrics["avg_duration_ms"] = round(float(avg_duration), 1) if avg_duration is not None else None
    metrics["avg_ttft_ms"] = round(float(avg_ttft), 1) if avg_ttft is not None else None

    top = (
        await session.execute(
            select(RequestLog.status_code, RequestLog.error, func.count(RequestLog.id).label("n"))
            .where(*window, RequestLog.status_code >= 400)
            .group_by(RequestLog.status_code, RequestLog.error)
            .order_by(func.count(RequestLog.id).desc())
            .limit(1)
        )
    ).first()
    metrics["top_error"] = (top[1] or f"HTTP {top[0]}") if top else None
    metrics["top_error_count"] = int(top[2]) if top else 0
    return metrics


async def build_overview(session: AsyncSession, frame: Timeframe, *, now: datetime | None = None) -> dict:
    now = now or datetime.now(UTC)
    since = now - frame.window
    previous_since = since - frame.window
    bucket_seconds = int(frame.bucket.total_seconds())
    dialect = session.get_bind().dialect.name

    current = await _window_metrics(session, since, now + timedelta(seconds=1))
    previous = await _window_metrics(session, previous_since, since)

    bucket = _bucket_index(dialect, since, bucket_seconds).label("bucket")
    window = (RequestLog.created_at >= since, RequestLog.created_at <= now)
    buckets = [_empty() for _ in range(frame.bucket_count)]
    by_model: dict[str | None, dict] = {}
    rows = await session.execute(
        select(bucket, RequestLog.model, *_SUMS).where(*window).group_by(bucket, RequestLog.model)
    )
    for row in rows:
        index = min(max(int(row[0] or 0), 0), frame.bucket_count - 1)
        _add(buckets[index], row[1], row[2:])
        _add(by_model.setdefault(row[1], _empty()), row[1], row[2:])

    conversation_buckets = [0] * frame.bucket_count
    for index, count in await session.execute(
        select(bucket, func.count(func.distinct(RequestLog.session_key))).where(*window).group_by(bucket)
    ):
        conversation_buckets[min(max(int(index or 0), 0), frame.bucket_count - 1)] += int(count or 0)

    trends = []
    for index, acc in enumerate(buckets):
        point = _finish(acc)
        trends.append(
            {
                "t": since + frame.bucket * index,
                "requests": point["requests"],
                "tokens": point["total_tokens"],
                "cost_usd": point["cost_usd"],
                "cache_savings_usd": point["cache_savings_usd"],
                "cache_hit_rate": point["cache_hit_rate"],
                "error_rate": point["error_rate"],
                "conversations": conversation_buckets[index],
            }
        )

    models = [{"model": model, **_finish(acc)} for model, acc in by_model.items()]
    models.sort(key=lambda m: (-m["cost_usd"], -m["requests"]))

    runtime = await settings_service.load(session)
    last_request_at = (await session.execute(select(func.max(RequestLog.created_at)))).scalar_one()
    return {
        "generated_at": now,
        "timeframe": {
            "key": frame.key,
            "window_minutes": int(frame.window.total_seconds() // 60),
            "bucket_seconds": bucket_seconds,
            "bucket_count": frame.bucket_count,
        },
        "since": since,
        "current": current,
        "previous": previous,
        "can_compare": previous["requests"] > 0,
        "trends": trends,
        "by_model": models,
        "meta": {
            "version": __version__,
            **await _pool_meta(session, now),
            "routing_strategy": runtime.routing_strategy,
            "sticky_sessions_enabled": runtime.sticky_sessions_enabled,
            "request_log_retention_days": runtime.request_log_retention_days,
            "last_request_at": last_request_at,
        },
    }


async def _pool_meta(session: AsyncSession, now: datetime) -> dict:
    """Account counts and the pool's remaining capacity, as `/api/usage/quota` computes it."""
    accounts = list((await session.execute(select(Account))).scalars())
    total_cap = remaining = 0.0
    for account in accounts:
        cap = quota_mod.effective_capacity_credits(account)
        pri = quota_mod.effective_primary_used(account, now=now)
        sec = quota_mod.effective_secondary_used(account, now=now)
        used = sec if sec is not None else (pri if pri is not None else 0.0)
        total_cap += cap
        if account.enabled:
            remaining += max(0.0, cap * (1.0 - min(used, 100.0) / 100.0))
    return {
        "accounts_total": len(accounts),
        "accounts_available": sum(1 for a in accounts if lb.is_available(a, now=now)),
        "pool_remaining_percent": round(remaining / total_cap * 100.0, 2) if total_cap > 0 else 100.0,
    }


# ---- projections ------------------------------------------------------------------


def _window_view(
    accounts: list[Account],
    history: dict[str, list[QuotaHistory]],
    *,
    window: str,
    now: datetime,
) -> dict | None:
    items = []
    for account in accounts:
        if window == "primary":
            used = quota_mod.effective_primary_used(account, now=now)
            reset = quota_mod.as_aware(account.primary_reset_at)
            minutes = account.primary_window_minutes or quota_mod.DEFAULT_PRIMARY_WINDOW_MINUTES
        else:
            used = quota_mod.effective_secondary_used(account, now=now)
            reset = quota_mod.as_aware(account.secondary_reset_at)
            minutes = account.secondary_window_minutes or quota_mod.DEFAULT_SECONDARY_WINDOW_MINUTES
        if reset is not None and reset <= now:
            reset = None  # the window rolled over; used already reads 0
        cap = quota_mod.effective_capacity_credits(account)
        remaining = cap * (1.0 - (used or 0.0) / 100.0)
        window_seconds = minutes * 60.0
        safe = (
            quota_mod.compute_safe_usage_percent(
                window_seconds - (reset - now).total_seconds(), window_seconds
            )
            if reset is not None
            else None
        )
        samples = quota_mod.history_samples(history.get(account.id, []), window=window, now=now)
        risk = quota_mod.window_risk(samples, current_used=used, reset_at=reset, now=now)
        rate = quota_mod.ewma_rate(samples)
        burn = rate * cap * 36.0 if rate and reset is not None else 0.0  # credits / hour
        items.append(
            {
                "account_id": account.id,
                "account_name": account.name,
                "plan_type": account.plan_type,
                "capacity_credits": cap,
                "used_percent": used,
                "remaining_credits": round(remaining, 4),
                "reset_at": reset,
                "window_minutes": minutes,
                "safe_used_percent": round(safe, 2) if safe is not None else None,
                "risk": round(risk, 4),
                "risk_level": quota_mod.classify_risk(risk),
                "burn_rate_credits_per_hour": round(burn, 4),
                "observed_at": account.quota_observed_at,
            }
        )
    if not items:
        return None

    capacity = sum(i["capacity_credits"] for i in items)
    remaining = sum(i["remaining_credits"] for i in items)
    timed = [i for i in items if i["safe_used_percent"] is not None]
    timed_cap = sum(i["capacity_credits"] for i in timed)
    safe = (
        sum(i["safe_used_percent"] * i["capacity_credits"] for i in timed) / timed_cap if timed_cap else None
    )
    risk = sum(i["risk"] * i["capacity_credits"] for i in items) / capacity if capacity else 0.0
    burn = sum(i["burn_rate_credits_per_hour"] for i in items)
    hours_left = remaining / burn if burn > 0 else None
    resets = [i["reset_at"] for i in items if i["reset_at"] is not None]
    return {
        "capacity_credits": round(capacity, 4),
        "remaining_credits": round(remaining, 4),
        "remaining_percent": round(remaining / capacity * 100.0, 2) if capacity else 100.0,
        "safe_used_percent": round(safe, 2) if safe is not None else None,
        "risk": round(risk, 4),
        "risk_level": quota_mod.classify_risk(risk),
        "burn_rate_credits_per_hour": round(burn, 4),
        "projected_exhaustion_at": now + timedelta(hours=hours_left) if hours_left is not None else None,
        "next_reset_at": min(resets) if resets else None,
        "accounts": items,
    }


async def build_projections(session: AsyncSession, *, now: datetime | None = None) -> dict:
    now = now or datetime.now(UTC)
    accounts = list((await session.execute(select(Account).order_by(Account.name))).scalars())
    rows = (
        await session.execute(
            select(QuotaHistory)
            .where(QuotaHistory.recorded_at >= now - timedelta(days=7))
            .order_by(QuotaHistory.recorded_at)
        )
    ).scalars()
    history: dict[str, list[QuotaHistory]] = {}
    for row in rows:
        history.setdefault(row.account_id, []).append(row)

    subscriptions = [a for a in accounts if pace.is_subscription(a) and a.enabled]
    api_accounts = [a for a in accounts if not pace.is_subscription(a)]
    return {
        "generated_at": now,
        "subscription_accounts": len(subscriptions),
        "primary": _window_view(subscriptions, history, window="primary", now=now),
        "secondary": _window_view(subscriptions, history, window="secondary", now=now),
        "weekly_pace": pace.build_weekly_pace(accounts, history, now=now),
        "api_accounts": [
            {
                "account_id": a.id,
                "account_name": a.name,
                "enabled": a.enabled,
                "available": lb.is_available(a, now=now),
                "spend_usd": round(a.total_cost_usd or 0.0, 6),
                "spend_cap_usd": a.spend_cap_usd,
                "cap_used_percent": (
                    round(min((a.total_cost_usd or 0.0) / a.spend_cap_usd * 100.0, 100.0), 2)
                    if a.spend_cap_usd
                    else None
                ),
            }
            for a in api_accounts
        ],
    }
