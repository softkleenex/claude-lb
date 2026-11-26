"""JSON endpoints behind the dashboard's overview page."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from claude_lb.dependencies import SessionDep
from claude_lb.modules.dashboard import overview
from claude_lb.modules.dashboard.timeframes import DEFAULT_TIMEFRAME, TIMEFRAMES

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


class TimeframeOut(BaseModel):
    key: str
    window_minutes: int
    bucket_seconds: int
    bucket_count: int


class Metrics(BaseModel):
    requests: int
    errors: int
    error_rate: float
    top_error: str | None
    top_error_count: int
    input_tokens: int
    output_tokens: int
    cache_read_input_tokens: int
    cache_creation_input_tokens: int
    total_tokens: int
    cost_usd: float
    cache_savings_usd: float
    cache_hit_rate: float
    conversations: int
    avg_duration_ms: float | None
    avg_ttft_ms: float | None


class TrendBucket(BaseModel):
    t: datetime
    requests: int
    tokens: int
    cost_usd: float
    cache_savings_usd: float
    cache_hit_rate: float
    error_rate: float
    conversations: int


class ModelRow(BaseModel):
    model: str | None
    requests: int
    errors: int
    error_rate: float
    input_tokens: int
    output_tokens: int
    cache_read_input_tokens: int
    cache_creation_input_tokens: int
    total_tokens: int
    cost_usd: float
    cache_savings_usd: float
    cache_hit_rate: float


class OverviewMeta(BaseModel):
    version: str
    accounts_total: int
    accounts_available: int
    pool_remaining_percent: float
    routing_strategy: str
    sticky_sessions_enabled: bool
    request_log_retention_days: int
    last_request_at: datetime | None


class OverviewOut(BaseModel):
    generated_at: datetime
    timeframe: TimeframeOut
    since: datetime
    current: Metrics
    previous: Metrics
    can_compare: bool
    trends: list[TrendBucket]
    by_model: list[ModelRow]
    meta: OverviewMeta


class WindowAccount(BaseModel):
    account_id: str
    account_name: str
    plan_type: str
    capacity_credits: float
    used_percent: float | None
    remaining_credits: float
    reset_at: datetime | None
    window_minutes: int
    safe_used_percent: float | None
    risk: float
    risk_level: str
    burn_rate_credits_per_hour: float
    observed_at: datetime | None


class WindowCapacity(BaseModel):
    capacity_credits: float
    remaining_credits: float
    remaining_percent: float
    safe_used_percent: float | None
    risk: float
    risk_level: str
    burn_rate_credits_per_hour: float
    projected_exhaustion_at: datetime | None
    next_reset_at: datetime | None
    accounts: list[WindowAccount]


class WeeklyPace(BaseModel):
    total_full_credits: float
    total_actual_remaining_credits: float
    total_expected_remaining_credits: float
    actual_used_percent: float
    scheduled_used_percent: float
    delta_percent: float
    smoothed_delta_percent: float
    schedule_gap_credits: float
    smoothed_schedule_gap_credits: float
    smoothing_minutes: int
    projected_shortfall_credits: float
    projected_depletion_hours: float | None
    projected_minimum_remaining_credits: float
    forecast_burn_rate_credits_per_hour: float | None
    scheduled_burn_rate_credits_per_hour: float
    pace_multiplier: float | None
    pause_for_break_even_hours: float | None
    throttle_to_percent: float | None
    reduce_by_percent: float | None
    pro_account_equivalent: float | None
    pro_accounts_to_cover: int | None
    status: str
    account_count: int
    stale_account_count: int
    inactive_account_count: int
    confidence: str


class ApiAccountSpend(BaseModel):
    account_id: str
    account_name: str
    enabled: bool
    available: bool
    spend_usd: float
    spend_cap_usd: float | None
    cap_used_percent: float | None


class ProjectionsOut(BaseModel):
    generated_at: datetime
    subscription_accounts: int
    primary: WindowCapacity | None
    secondary: WindowCapacity | None
    weekly_pace: WeeklyPace | None
    api_accounts: list[ApiAccountSpend]


@router.get("/overview", response_model=OverviewOut)
async def dashboard_overview(
    session: SessionDep,
    timeframe: str = Query(default=DEFAULT_TIMEFRAME, description="1h | 24h | 7d | 30d"),
) -> OverviewOut:
    frame = TIMEFRAMES.get(timeframe)
    if frame is None:
        raise HTTPException(422, f"timeframe must be one of {', '.join(TIMEFRAMES)}")
    return OverviewOut(**await overview.build_overview(session, frame))


@router.get("/projections", response_model=ProjectionsOut)
async def dashboard_projections(session: SessionDep) -> ProjectionsOut:
    """5h / 7d capacity across subscription accounts, weekly pacing, and API-key spend caps."""
    return ProjectionsOut(**await overview.build_projections(session))
