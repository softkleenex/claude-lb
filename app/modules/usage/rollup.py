"""Daily usage rollups.

Every proxied request increments the matching `usage_daily` row as it is logged, so
the long-range trend does not depend on request logs that get pruned. Writes are
upserts keyed on (day, account, model); they are small and bounded by
``days x accounts x models``.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import RequestLog, UsageDaily
from app.modules.proxy.usage_parser import Usage


def day_key(moment: datetime | None = None) -> str:
    return (moment or datetime.now(UTC)).astimezone(UTC).date().isoformat()


async def apply(
    session: AsyncSession,
    *,
    account_id: str | None,
    api_key_id: str | None,
    model: str | None,
    usage: Usage,
    cost_usd: float,
    is_error: bool,
    moment: datetime | None = None,
) -> None:
    """Fold one request into its daily bucket."""
    key = day_key(moment)
    result = await session.execute(
        select(UsageDaily).where(
            UsageDaily.day == key,
            UsageDaily.account_id == account_id,
            UsageDaily.api_key_id == api_key_id,
            UsageDaily.model == model,
        )
    )
    row = result.scalar_one_or_none()
    if row is None:
        # Column defaults are applied at INSERT, so a freshly constructed row still has
        # `None` counters — seed them explicitly before the accumulate below.
        row = UsageDaily(
            day=key,
            account_id=account_id,
            api_key_id=api_key_id,
            model=model,
            requests=0,
            errors=0,
            input_tokens=0,
            output_tokens=0,
            cache_creation_input_tokens=0,
            cache_read_input_tokens=0,
            cost_usd=0.0,
        )
        session.add(row)

    row.requests += 1
    row.errors += 1 if is_error else 0
    row.input_tokens += usage.input_tokens
    row.output_tokens += usage.output_tokens
    row.cache_creation_input_tokens += usage.cache_creation_input_tokens
    row.cache_read_input_tokens += usage.cache_read_input_tokens
    row.cost_usd += cost_usd


async def trend(session: AsyncSession, *, days: int = 28) -> list[dict]:
    """One entry per day, oldest first, with zero-filled gaps.

    Gaps are filled so a chart renders a flat line for a quiet day rather than
    silently compressing the x-axis.
    """
    from sqlalchemy import func

    today = datetime.now(UTC).date()
    start = today - timedelta(days=days - 1)

    result = await session.execute(
        select(
            UsageDaily.day,
            func.sum(UsageDaily.requests),
            func.sum(UsageDaily.errors),
            func.sum(UsageDaily.input_tokens),
            func.sum(UsageDaily.output_tokens),
            func.sum(UsageDaily.cache_read_input_tokens),
            func.sum(UsageDaily.cost_usd),
        )
        .where(UsageDaily.day >= start.isoformat())
        .group_by(UsageDaily.day)
    )
    by_day = {
        row[0]: {
            "requests": row[1] or 0,
            "errors": row[2] or 0,
            "input_tokens": row[3] or 0,
            "output_tokens": row[4] or 0,
            "cache_read_input_tokens": row[5] or 0,
            "cost_usd": round(row[6] or 0.0, 6),
        }
        for row in result
    }

    empty = {
        "requests": 0,
        "errors": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_input_tokens": 0,
        "cost_usd": 0.0,
    }
    return [
        {
            "day": (start + timedelta(days=offset)).isoformat(),
            **by_day.get((start + timedelta(days=offset)).isoformat(), empty),
        }
        for offset in range(days)
    ]


async def backfill(session: AsyncSession, *, days: int = 28) -> int:
    """Rebuild rollups from the surviving request logs.

    For upgrading an instance that has request history but no rollups yet. Only
    touches days the logs still cover, so it cannot clobber older rollup rows.
    """
    from sqlalchemy import delete, func

    cutoff = datetime.now(UTC) - timedelta(days=days)
    day_expr = func.strftime("%Y-%m-%d", RequestLog.created_at)
    if session.bind and session.bind.dialect.name != "sqlite":
        day_expr = func.to_char(RequestLog.created_at, "YYYY-MM-DD")

    result = await session.execute(
        select(
            day_expr,
            RequestLog.account_id,
            RequestLog.api_key_id,
            RequestLog.model,
            func.count(RequestLog.id),
            func.sum(func.coalesce(RequestLog.input_tokens, 0)),
            func.sum(func.coalesce(RequestLog.output_tokens, 0)),
            func.sum(func.coalesce(RequestLog.cache_creation_input_tokens, 0)),
            func.sum(func.coalesce(RequestLog.cache_read_input_tokens, 0)),
            func.sum(func.coalesce(RequestLog.cost_usd, 0.0)),
        )
        .where(RequestLog.created_at >= cutoff)
        .group_by(day_expr, RequestLog.account_id, RequestLog.api_key_id, RequestLog.model)
    )
    rows = list(result)
    if not rows:
        return 0

    covered_days = {row[0] for row in rows}
    await session.execute(delete(UsageDaily).where(UsageDaily.day.in_(covered_days)))

    for day, account_id, api_key_id, model, requests, inp, out, cache_write, cache_read, cost in rows:
        session.add(
            UsageDaily(
                day=day,
                account_id=account_id,
                api_key_id=api_key_id,
                model=model,
                requests=requests,
                input_tokens=inp or 0,
                output_tokens=out or 0,
                cache_creation_input_tokens=cache_write or 0,
                cache_read_input_tokens=cache_read or 0,
                cost_usd=cost or 0.0,
            )
        )
    return len(rows)


def today() -> date:
    return datetime.now(UTC).date()
