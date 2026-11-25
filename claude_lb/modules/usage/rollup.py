"""Daily usage rollups.

Every proxied request increments the matching `usage_daily` row as it is logged, so
the long-range trend does not depend on request logs that get pruned. Writes are
upserts keyed on (day, account, model); they are small and bounded by
``days x accounts x models``.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from claude_lb.db.models import RequestLog, UsageDaily, utcnow
from claude_lb.modules.proxy.usage_parser import Usage


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
    """Fold one request into its daily bucket.

    The counters are bumped with ``SET col = col + :n`` rather than read-modify-write,
    so concurrent requests cannot overwrite each other's increments on a database that
    runs them in parallel (Postgres).

    The unique index on the bucket key does not constrain rows whose key has a NULL
    (no client key, unknown model), so two first-of-the-day requests can each insert a
    row. That is harmless as long as later requests add to exactly one of them and
    readers sum — which is why the bump targets a single row id, never the key.
    """
    key = day_key(moment)
    deltas = {
        "requests": 1,
        "errors": 1 if is_error else 0,
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "cache_creation_input_tokens": usage.cache_creation_input_tokens,
        "cache_read_input_tokens": usage.cache_read_input_tokens,
        "cost_usd": cost_usd,
    }

    row_id = await _find_bucket(session, key, account_id, api_key_id, model)
    if row_id is None:
        try:
            async with session.begin_nested():
                session.add(
                    UsageDaily(day=key, account_id=account_id, api_key_id=api_key_id, model=model, **deltas)
                )
            return
        except IntegrityError:
            # Another request created the bucket between our read and our insert.
            row_id = await _find_bucket(session, key, account_id, api_key_id, model)
            if row_id is None:  # pragma: no cover - the conflicting row must exist
                raise

    columns = UsageDaily.__table__.c
    await session.execute(
        update(UsageDaily)
        .where(UsageDaily.id == row_id)
        .values({name: columns[name] + delta for name, delta in deltas.items()} | {"updated_at": utcnow()})
    )


def _matches(column, value):
    return column.is_(None) if value is None else column == value


async def _find_bucket(
    session: AsyncSession, key: str, account_id: str | None, api_key_id: str | None, model: str | None
) -> str | None:
    result = await session.execute(
        select(UsageDaily.id)
        .where(
            UsageDaily.day == key,
            _matches(UsageDaily.account_id, account_id),
            _matches(UsageDaily.api_key_id, api_key_id),
            _matches(UsageDaily.model, model),
        )
        .order_by(UsageDaily.id)
        .limit(1)
    )
    return result.scalar_one_or_none()


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
