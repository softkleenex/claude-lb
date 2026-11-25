"""The Reports page payload: summary, daily series, distributions, grouped breakdown.

Spend, tokens, requests and errors come from the daily rollups (kept indefinitely), so
they cover the whole range. Everything that needs individual requests — latency medians,
aborted streams, conversations, user agents — comes from request logs and is limited to
`request_log_retention_days`; ``coverage`` tells the UI from which day those are complete.
A user-agent filter or grouping moves the whole report onto request logs.
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from claude_lb.db.models import Account, ApiKey, RequestLog, UsageDaily
from claude_lb.modules.request_logs.service import _category_condition
from claude_lb.modules.settings import service as settings_service
from claude_lb.modules.usage import reports
from claude_lb.modules.usage.reports import Fact, ReportFilters, ReportRow


def _total(facts: list[Fact]) -> ReportRow:
    total = ReportRow(key=None, label="TOTAL")
    for fact in facts:
        total.add(fact)
    return total.rounded()


def _days(start: str, end: str) -> list[str]:
    first, last = date.fromisoformat(start), date.fromisoformat(end)
    return [(first + timedelta(days=i)).isoformat() for i in range((last - first).days + 1)]


def _median(values: list[float]) -> float | None:
    return round(statistics.median(values), 2) if values else None


def _as_utc(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def _distribution(rows: list[ReportRow]) -> list[dict]:
    return [
        {
            "key": row.key,
            "label": row.label,
            "cost_usd": row.cost_usd,
            "total_tokens": row.total_tokens,
            "requests": row.requests,
        }
        for row in rows
    ]


async def _log_metrics(
    session: AsyncSession, start: str, end: str, filters: ReportFilters
) -> tuple[dict[str, dict], dict]:
    """Per-day and whole-range figures that only request logs can answer."""
    since, until = reports.day_bounds(start, end)
    conditions = reports.log_conditions(since, until, filters)
    day_index = reports.day_column(session.get_bind().dialect.name, since).label("day_index")
    start_date, last = since.date(), (until - since).days - 1

    def day_of(index) -> str:
        return (start_date + timedelta(days=min(max(int(index or 0), 0), last))).isoformat()

    aborted = func.coalesce(func.sum(case((_category_condition("aborted"), 1), else_=0)), 0)
    daily: dict[str, dict] = defaultdict(lambda: {"aborted": 0, "conversations": 0, "ttft": [], "tps": []})
    for index, conversations, aborted_count in await session.execute(
        select(day_index, func.count(func.distinct(RequestLog.session_key)), aborted)
        .where(*conditions)
        .group_by(day_index)
    ):
        bucket = daily[day_of(index)]
        bucket["conversations"] += int(conversations or 0)
        bucket["aborted"] += int(aborted_count or 0)

    # Medians need the individual values; the rows are bounded by the window and retention.
    for index, ttft, duration, output in await session.execute(
        select(day_index, RequestLog.ttft_ms, RequestLog.duration_ms, RequestLog.output_tokens).where(
            *conditions, RequestLog.streaming.is_(True), RequestLog.ttft_ms.is_not(None)
        )
    ):
        bucket = daily[day_of(index)]
        bucket["ttft"].append(float(ttft))
        generating_ms = (duration or 0) - ttft
        if output and generating_ms > 0:
            bucket["tps"].append(output / (generating_ms / 1000))

    conversations, aborted_total = (
        await session.execute(
            select(func.count(func.distinct(RequestLog.session_key)), aborted).where(*conditions)
        )
    ).one()
    all_ttft = [v for bucket in daily.values() for v in bucket["ttft"]]
    all_tps = [v for bucket in daily.values() for v in bucket["tps"]]
    totals = {
        "conversations": int(conversations or 0),
        "aborted": int(aborted_total or 0),
        "median_ttft_ms": _median(all_ttft),
        "median_tps": _median(all_tps),
    }
    return daily, totals


async def _earliest_day(session: AsyncSession, from_logs: bool) -> str | None:
    if from_logs:
        first = (await session.execute(select(func.min(RequestLog.created_at)))).scalar_one_or_none()
        return _as_utc(first).date().isoformat() if first else None
    return (await session.execute(select(func.min(UsageDaily.day)))).scalar_one_or_none()


async def build_report(
    session: AsyncSession,
    *,
    start: str | None,
    end: str | None,
    group_by: str = "day",
    filters: ReportFilters | None = None,
    now: datetime | None = None,
) -> dict:
    if group_by not in reports.GROUPINGS:
        raise ValueError(f"group_by must be one of {', '.join(reports.GROUPINGS)}")
    start, end = reports.normalize_range(start, end)
    filters = filters or ReportFilters()
    now = now or datetime.now(UTC)
    days = _days(start, end)

    from_logs = filters.needs_logs
    facts = await reports.load_facts(session, start, end, filters)
    log_facts = facts if from_logs else await reports.load_facts(session, start, end, filters, from_logs=True)

    breakdown_facts = log_facts if group_by == "user_agent" else facts
    breakdown_rows = await reports.group_facts(session, breakdown_facts, group_by)
    breakdown_total = _total(breakdown_facts)
    by_model = await reports.group_facts(session, facts, "model")
    by_user_agent = await reports.group_facts(session, log_facts, "user_agent")
    total = _total(facts)

    daily_log, log_totals = await _log_metrics(session, start, end, filters)
    per_day: dict[str, ReportRow] = {day: ReportRow(key=day, label=day) for day in days}
    for fact in facts:
        if fact.day in per_day:
            per_day[fact.day].add(fact)
    daily = []
    for day in days:
        row = per_day[day].rounded()
        extra = daily_log.get(day)
        daily.append(
            row.as_dict()
            | {
                "day": day,
                "aborted": extra["aborted"] if extra else 0,
                "conversations": extra["conversations"] if extra else 0,
                "median_ttft_ms": _median(extra["ttft"]) if extra else None,
                "median_tps": _median(extra["tps"]) if extra else None,
            }
        )

    # The same-length window just before this one, for deltas on the summary cards.
    first = date.fromisoformat(start)
    previous_end = first - timedelta(days=1)
    previous_start = previous_end - timedelta(days=len(days) - 1)
    previous = _total(
        await reports.load_facts(session, previous_start.isoformat(), previous_end.isoformat(), filters)
    )
    earliest = await _earliest_day(session, from_logs)

    retention_days = (await settings_service.load(session)).request_log_retention_days
    # Logs older than the cutoff are pruned; its day is partial, so coverage starts the day after.
    cutoff_day = (now - timedelta(days=retention_days)).date()
    logs_from = max(first, cutoff_day + timedelta(days=1))
    accounts_used = len({f.account_id for f in facts if f.account_id and f.requests})

    return {
        "start": start,
        "end": end,
        "days": len(days),
        "group_by": group_by,
        "source": "request_logs" if from_logs else "rollups",
        "coverage": {
            "retention_days": retention_days,
            "logs_from": logs_from.isoformat(),
            "logs_truncated": first <= cutoff_day,
        },
        "summary": {
            "total_cost_usd": total.cost_usd,
            "avg_cost_per_day": round(total.cost_usd / len(days), 6),
            "requests": total.requests,
            "avg_requests_per_day": round(total.requests / len(days), 2),
            "errors": total.errors,
            "error_rate": round(total.errors / total.requests, 4) if total.requests else 0.0,
            "aborted": log_totals["aborted"],
            "accounts_used": accounts_used,
            "conversations": log_totals["conversations"],
            "input_tokens": total.input_tokens,
            "output_tokens": total.output_tokens,
            "cache_read_input_tokens": total.cache_read_input_tokens,
            "cache_creation_input_tokens": total.cache_creation_input_tokens,
            "total_tokens": total.total_tokens,
            "cache_savings_usd": total.cache_savings_usd,
            "cache_hit_rate": _hit_rate(total),
            "median_ttft_ms": log_totals["median_ttft_ms"],
            "median_tps": log_totals["median_tps"],
        },
        "previous": {
            "start": previous_start.isoformat(),
            "end": previous_end.isoformat(),
            "can_compare": earliest is not None and earliest <= previous_start.isoformat(),
            "total_cost_usd": previous.cost_usd,
            "requests": previous.requests,
            "total_tokens": previous.total_tokens,
            "errors": previous.errors,
            "cache_savings_usd": previous.cache_savings_usd,
        },
        "daily": daily,
        "by_model": _distribution(by_model),
        "by_user_agent": _distribution(by_user_agent),
        "breakdown": [row.as_dict() | {"cache_hit_rate": _hit_rate(row)} for row in breakdown_rows],
        "breakdown_total": breakdown_total.as_dict() | {"cache_hit_rate": _hit_rate(breakdown_total)},
    }


def _hit_rate(row: ReportRow) -> float:
    prompt = row.input_tokens + row.cache_read_input_tokens + row.cache_creation_input_tokens
    return round(row.cache_read_input_tokens / prompt, 4) if prompt else 0.0


async def filter_options(session: AsyncSession, *, start: str | None, end: str | None) -> dict:
    """Choices for the report filters: every live account/key plus anything seen in range."""
    start, end = reports.normalize_range(start, end)
    window = (UsageDaily.day >= start, UsageDaily.day <= end)

    account_names = {aid: name for aid, name in await session.execute(select(Account.id, Account.name))}
    key_rows = {
        kid: (name, hint)
        for kid, name, hint in await session.execute(select(ApiKey.id, ApiKey.name, ApiKey.key_hint))
    }
    seen_accounts = (
        await session.execute(
            select(UsageDaily.account_id).where(*window, UsageDaily.account_id.is_not(None)).distinct()
        )
    ).scalars()
    seen_keys = (
        await session.execute(
            select(UsageDaily.api_key_id).where(*window, UsageDaily.api_key_id.is_not(None)).distinct()
        )
    ).scalars()
    for aid in seen_accounts:
        account_names.setdefault(aid, f"(deleted: {aid[:8]})")
    for kid in seen_keys:
        key_rows.setdefault(kid, (f"(deleted: {kid[:8]})", ""))

    models = (
        await session.execute(
            select(UsageDaily.model)
            .where(*window, UsageDaily.model.is_not(None))
            .distinct()
            .order_by(UsageDaily.model)
        )
    ).scalars()
    since, until = reports.day_bounds(start, end)
    agents = (
        await session.execute(
            select(RequestLog.user_agent)
            .where(RequestLog.created_at >= since, RequestLog.created_at < until)
            .distinct()
        )
    ).scalars()

    return {
        "accounts": sorted(
            ({"id": aid, "name": name} for aid, name in account_names.items()),
            key=lambda a: a["name"].lower(),
        ),
        "api_keys": sorted(
            ({"id": kid, "name": name, "key_hint": hint or ""} for kid, (name, hint) in key_rows.items()),
            key=lambda k: k["name"].lower(),
        ),
        "models": list(models),
        "user_agents": sorted({reports.user_agent_family(ua) for ua in agents}),
    }
