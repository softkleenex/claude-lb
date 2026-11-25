"""Request logs for the dashboard: server-side paging, filters, facet options, detail."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from claude_lb.core.pricing import cost_breakdown_usd
from claude_lb.dependencies import SessionDep
from claude_lb.modules.dashboard.timeframes import TIMEFRAMES
from claude_lb.modules.request_logs import service
from claude_lb.modules.request_logs.service import STATUS_CATEGORIES, LogFilters

router = APIRouter(prefix="/api/request-logs", tags=["request-logs"])
_STATUS_HELP = " | ".join(STATUS_CATEGORIES)


class RequestLogItem(BaseModel):
    id: str
    created_at: datetime
    account_id: str | None
    account_name: str | None
    plan_type: str | None
    api_key_id: str | None
    api_key_name: str | None
    path: str
    model: str | None
    status_code: int
    status: str
    streaming: bool
    duration_ms: int
    ttft_ms: int | None
    attempts: int
    input_tokens: int
    output_tokens: int
    cache_read_input_tokens: int
    cache_creation_input_tokens: int
    total_tokens: int
    cost_usd: float
    cache_savings_usd: float
    error: str | None
    session_key: str | None
    user_agent: str | None
    client_ip: str | None


class RequestLogPage(BaseModel):
    requests: list[RequestLogItem]
    total: int
    limit: int
    offset: int
    has_more: bool


class CostBreakdown(BaseModel):
    input_usd: float
    cache_write_usd: float
    cache_read_usd: float
    output_usd: float


class ConversationSummary(BaseModel):
    requests: int
    cost_usd: float
    first_at: datetime | None
    last_at: datetime | None


class RequestLogDetail(RequestLogItem):
    cost_breakdown: CostBreakdown
    conversation: ConversationSummary | None


class AccountOption(BaseModel):
    id: str
    name: str


class ApiKeyOption(BaseModel):
    id: str
    name: str
    key_hint: str


class FilterOptions(BaseModel):
    accounts: list[AccountOption]
    api_keys: list[ApiKeyOption]
    models: list[str]
    statuses: list[str]


def _since(timeframe: str | None, since: datetime | None) -> datetime | None:
    if since is not None:
        return since if since.tzinfo else since.replace(tzinfo=UTC)
    if not timeframe or timeframe == "all":
        return None
    frame = TIMEFRAMES.get(timeframe)
    if frame is None:
        raise HTTPException(422, f"timeframe must be one of all, {', '.join(TIMEFRAMES)}")
    return datetime.now(UTC) - frame.window


@router.get("", response_model=RequestLogPage)
async def list_request_logs(
    session: SessionDep,
    limit: int = Query(default=25, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    search: str | None = Query(default=None, max_length=200),
    timeframe: str | None = Query(default=None, description="all | 1h | 24h | 7d | 30d"),
    since: datetime | None = None,
    until: datetime | None = None,
    account_id: Annotated[list[str] | None, Query()] = None,
    api_key_id: Annotated[list[str] | None, Query()] = None,
    model: Annotated[list[str] | None, Query()] = None,
    status: Annotated[list[str] | None, Query(description=_STATUS_HELP)] = None,
    session_key: str | None = Query(default=None, max_length=64),
) -> RequestLogPage:
    status = status or []
    unknown = [s for s in status if s not in STATUS_CATEGORIES]
    if unknown:
        raise HTTPException(422, f"unknown status: {', '.join(unknown)}")
    filters = LogFilters(
        since=_since(timeframe, since),
        until=until if until is None or until.tzinfo else until.replace(tzinfo=UTC),
        search=search,
        account_ids=account_id or (),
        api_key_ids=api_key_id or (),
        models=model or (),
        statuses=status,
        session_key=session_key,
    )
    items, total = await service.list_page(session, filters, limit=limit, offset=offset)
    return RequestLogPage(
        requests=[RequestLogItem(**item) for item in items],
        total=total,
        limit=limit,
        offset=offset,
        has_more=offset + len(items) < total,
    )


@router.get("/options", response_model=FilterOptions)
async def request_log_options(
    session: SessionDep,
    timeframe: str | None = Query(default=None),
    since: datetime | None = None,
) -> FilterOptions:
    return FilterOptions(**await service.filter_options(session, since=_since(timeframe, since)))


@router.get("/{request_id}", response_model=RequestLogDetail)
async def request_log_detail(request_id: str, session: SessionDep) -> RequestLogDetail:
    item = await service.get_one(session, request_id)
    if item is None:
        raise HTTPException(404, "request log not found")
    breakdown = cost_breakdown_usd(
        item["model"],
        input_tokens=item["input_tokens"],
        output_tokens=item["output_tokens"],
        cache_creation_input_tokens=item["cache_creation_input_tokens"],
        cache_read_input_tokens=item["cache_read_input_tokens"],
    )
    return RequestLogDetail(**item, cost_breakdown=CostBreakdown(**breakdown))
