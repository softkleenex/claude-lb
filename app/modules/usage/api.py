from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import case, delete, func, select

from app.core.config import get_settings
from app.db.models import Account, RequestLog
from app.dependencies import SessionDep
from app.modules.usage import rollup

router = APIRouter(prefix="/api/usage", tags=["usage"])


class UsageTotals(BaseModel):
    requests: int = 0
    errors: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cost_usd: float = 0.0


class AccountUsage(UsageTotals):
    account_id: str | None
    account_name: str


class ModelUsage(UsageTotals):
    model: str | None


class UsageSummary(BaseModel):
    window_hours: int
    since: datetime
    totals: UsageTotals
    by_account: list[AccountUsage]
    by_model: list[ModelUsage]


class RequestLogOut(BaseModel):
    id: str
    created_at: datetime
    account_id: str | None
    api_key_id: str | None
    path: str
    model: str | None
    status_code: int
    streaming: bool
    duration_ms: int
    attempts: int
    input_tokens: int
    output_tokens: int
    cost_usd: float
    error: str | None


_SUM_COLUMNS = (
    func.count(RequestLog.id),
    func.coalesce(func.sum(case((RequestLog.status_code >= 400, 1), else_=0)), 0),
    func.coalesce(func.sum(RequestLog.input_tokens), 0),
    func.coalesce(func.sum(RequestLog.output_tokens), 0),
    func.coalesce(func.sum(RequestLog.cache_read_input_tokens), 0),
    func.coalesce(func.sum(RequestLog.cache_creation_input_tokens), 0),
    func.coalesce(func.sum(RequestLog.cost_usd), 0.0),
)


def _totals(row) -> dict:
    requests, errors, inp, out, cache_read, cache_write, cost = row
    return {
        "requests": requests,
        "errors": errors,
        "input_tokens": inp,
        "output_tokens": out,
        "cache_read_input_tokens": cache_read,
        "cache_creation_input_tokens": cache_write,
        "cost_usd": round(cost, 6),
    }


@router.get("/summary", response_model=UsageSummary)
async def usage_summary(
    session: SessionDep,
    window_hours: int = Query(default=24, ge=1, le=24 * 90),
) -> UsageSummary:
    since = datetime.now(UTC) - timedelta(hours=window_hours)

    overall = (await session.execute(select(*_SUM_COLUMNS).where(RequestLog.created_at >= since))).one()

    per_account = await session.execute(
        select(RequestLog.account_id, Account.name, *_SUM_COLUMNS)
        .join(Account, Account.id == RequestLog.account_id, isouter=True)
        .where(RequestLog.created_at >= since)
        .group_by(RequestLog.account_id, Account.name)
        .order_by(func.sum(RequestLog.cost_usd).desc())
    )
    per_model = await session.execute(
        select(RequestLog.model, *_SUM_COLUMNS)
        .where(RequestLog.created_at >= since)
        .group_by(RequestLog.model)
        .order_by(func.sum(RequestLog.cost_usd).desc())
    )

    return UsageSummary(
        window_hours=window_hours,
        since=since,
        totals=UsageTotals(**_totals(overall)),
        by_account=[
            AccountUsage(account_id=row[0], account_name=row[1] or "(deleted)", **_totals(row[2:]))
            for row in per_account
        ],
        by_model=[ModelUsage(model=row[0], **_totals(row[1:])) for row in per_model],
    )


@router.get("/requests", response_model=list[RequestLogOut])
async def list_requests(
    session: SessionDep,
    limit: int = Query(default=100, ge=1, le=1000),
    account_id: str | None = None,
    status_min: int | None = Query(default=None, description="Only rows with status >= this"),
) -> list[RequestLogOut]:
    stmt = select(RequestLog).order_by(RequestLog.created_at.desc()).limit(limit)
    if account_id:
        stmt = stmt.where(RequestLog.account_id == account_id)
    if status_min is not None:
        stmt = stmt.where(RequestLog.status_code >= status_min)
    result = await session.execute(stmt)
    return [RequestLogOut.model_validate(row, from_attributes=True) for row in result.scalars()]


async def prune_request_logs(session: SessionDep) -> int:
    """Delete logs past the retention window. Called from the startup task."""
    days = get_settings().request_log_retention_days
    cutoff = datetime.now(UTC) - timedelta(days=days)
    result = await session.execute(delete(RequestLog).where(RequestLog.created_at < cutoff))
    return result.rowcount or 0


class TrendPoint(BaseModel):
    day: str
    requests: int
    errors: int
    input_tokens: int
    output_tokens: int
    cache_read_input_tokens: int
    cost_usd: float


@router.get("/trend", response_model=list[TrendPoint])
async def usage_trend(
    session: SessionDep,
    days: int = Query(default=28, ge=1, le=365),
) -> list[TrendPoint]:
    """Daily totals, oldest first, with quiet days zero-filled.

    Backed by rollups rather than request logs, so the window is not truncated by
    log retention.
    """
    return [TrendPoint(**point) for point in await rollup.trend(session, days=days)]


@router.post("/rollups/backfill", response_model=dict[str, int])
async def backfill_rollups(
    session: SessionDep,
    days: int = Query(default=28, ge=1, le=365),
) -> dict[str, int]:
    """Rebuild rollups from surviving request logs (for upgrading an old instance)."""
    return {"rows": await rollup.backfill(session, days=days)}
