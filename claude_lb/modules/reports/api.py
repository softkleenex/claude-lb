"""`/api/reports`: the Reports page payload and its filter options."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from claude_lb.dependencies import SessionDep
from claude_lb.modules.reports import service
from claude_lb.modules.usage.reports import GROUPINGS, ReportFilters

router = APIRouter(prefix="/api/reports", tags=["reports"])
_GROUP_HELP = " | ".join(GROUPINGS)


class Coverage(BaseModel):
    retention_days: int
    logs_from: str
    """First day for which request-log metrics (TTFT, TPS, aborted, conversations, user
    agents) are complete."""
    logs_truncated: bool
    """True when the range starts before ``logs_from``."""


class Summary(BaseModel):
    total_cost_usd: float
    avg_cost_per_day: float
    requests: int
    avg_requests_per_day: float
    errors: int
    error_rate: float
    aborted: int
    accounts_used: int
    conversations: int
    input_tokens: int
    output_tokens: int
    cache_read_input_tokens: int
    cache_creation_input_tokens: int
    total_tokens: int
    cache_savings_usd: float
    cache_hit_rate: float
    median_ttft_ms: float | None
    median_tps: float | None


class Previous(BaseModel):
    start: str
    end: str
    can_compare: bool
    total_cost_usd: float
    requests: int
    total_tokens: int
    errors: int
    cache_savings_usd: float


class Totals(BaseModel):
    requests: int
    errors: int
    input_tokens: int
    output_tokens: int
    cache_creation_input_tokens: int
    cache_read_input_tokens: int
    total_tokens: int
    cost_usd: float
    cache_savings_usd: float


class DailyPoint(Totals):
    day: str
    aborted: int
    conversations: int
    median_ttft_ms: float | None
    median_tps: float | None


class DistributionEntry(BaseModel):
    key: str | None
    label: str
    cost_usd: float
    total_tokens: int
    requests: int


class BreakdownRow(Totals):
    key: str | None
    label: str
    cache_hit_rate: float


class BreakdownTotal(Totals):
    cache_hit_rate: float


class ReportOut(BaseModel):
    start: str
    end: str
    days: int
    group_by: str
    source: str
    """``rollups`` normally; ``request_logs`` when a user-agent filter forces it."""
    coverage: Coverage
    summary: Summary
    previous: Previous
    daily: list[DailyPoint]
    by_model: list[DistributionEntry]
    by_user_agent: list[DistributionEntry]
    breakdown: list[BreakdownRow]
    breakdown_total: BreakdownTotal


class AccountOption(BaseModel):
    id: str
    name: str


class ApiKeyOption(BaseModel):
    id: str
    name: str
    key_hint: str


class ReportOptions(BaseModel):
    accounts: list[AccountOption]
    api_keys: list[ApiKeyOption]
    models: list[str]
    user_agents: list[str]


def report_filters(
    account_id: list[str] | None,
    api_key_id: list[str] | None,
    model: list[str] | None,
    user_agent: list[str] | None,
) -> ReportFilters:
    return ReportFilters(
        account_ids=account_id or (),
        api_key_ids=api_key_id or (),
        models=model or (),
        user_agents=user_agent or (),
    )


@router.get("", response_model=ReportOut)
async def get_report(
    session: SessionDep,
    start: str | None = Query(default=None, description="Inclusive ISO date (UTC). Defaults to 30 days ago."),
    end: str | None = Query(default=None, description="Inclusive ISO date (UTC). Defaults to today."),
    group_by: str = Query(default="day", description=_GROUP_HELP),
    account_id: Annotated[list[str] | None, Query()] = None,
    api_key_id: Annotated[list[str] | None, Query()] = None,
    model: Annotated[list[str] | None, Query()] = None,
    user_agent: Annotated[list[str] | None, Query(description="User-agent family, e.g. claude-cli")] = None,
) -> ReportOut:
    try:
        payload = await service.build_report(
            session,
            start=start,
            end=end,
            group_by=group_by,
            filters=report_filters(account_id, api_key_id, model, user_agent),
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return ReportOut(**payload)


@router.get("/options", response_model=ReportOptions)
async def get_report_options(
    session: SessionDep,
    start: str | None = None,
    end: str | None = None,
) -> ReportOptions:
    try:
        return ReportOptions(**await service.filter_options(session, start=start, end=end))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
