"""Usage limits on API keys: what a rule counts, over which window, and how much is used.

Two sources of rules feed the same evaluation:

* rows in ``api_key_limit_rules`` (any number per key, all must pass), and
* the original single rolling budget on the key itself (``max_*_per_window`` +
  ``window_seconds``), still written by ``claude-lb key create`` / ``setup`` and by
  older API clients. It is presented as up to three ``legacy`` rules.

Usage is counted from request logs, so it is exact for everything that has finished.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from claude_lb.db.models import ApiKey, RequestLog

METRICS = ("requests", "total_tokens", "input_tokens", "output_tokens", "cost_usd")
ROLLING_WINDOWS = {"5h": 5 * 3600, "7d": 7 * 86400}
CALENDAR_WINDOWS = {"daily": 86400, "weekly": 7 * 86400, "monthly": 31 * 86400}
WINDOWS = (*ROLLING_WINDOWS, *CALENDAR_WINDOWS, "custom")
MIN_CUSTOM_WINDOW_SECONDS = 60
MAX_CUSTOM_WINDOW_SECONDS = 366 * 86400


@dataclass(frozen=True)
class RuleSpec:
    id: str
    metric: str
    window: str
    window_seconds: int
    max_value: float
    model_filter: str | None
    source: str
    """``rule`` for a stored rule, ``legacy`` for the key's original single budget."""


@dataclass(frozen=True)
class RuleUsage:
    spec: RuleSpec
    current_value: float
    window_start: datetime
    resets_at: datetime | None
    """Calendar windows: the next boundary. Rolling windows: when the oldest counted
    request leaves the window (usage first drops), or None when nothing is counted."""


def window_seconds_for(window: str, custom_seconds: int | None) -> int:
    if window in ROLLING_WINDOWS:
        return ROLLING_WINDOWS[window]
    if window in CALENDAR_WINDOWS:
        return CALENDAR_WINDOWS[window]
    if custom_seconds is None:
        raise ValueError("a custom window needs window_seconds")
    return custom_seconds


def calendar_bounds(window: str, now: datetime) -> tuple[datetime, datetime]:
    """The UTC calendar period containing ``now``: [start, next start)."""
    day = now.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    if window == "daily":
        return day, day + timedelta(days=1)
    if window == "weekly":
        start = day - timedelta(days=day.weekday())  # Monday
        return start, start + timedelta(days=7)
    start = day.replace(day=1)
    if start.month == 12:
        return start, start.replace(year=start.year + 1, month=1)
    return start, start.replace(month=start.month + 1)


def window_start(spec: RuleSpec, now: datetime) -> datetime:
    if spec.window in CALENDAR_WINDOWS:
        return calendar_bounds(spec.window, now)[0]
    return now - timedelta(seconds=spec.window_seconds)


def model_matches(model_filter: str | None, model: str | None) -> bool:
    """Exact id, or a family prefix: ``claude-sonnet-4-5`` covers ``claude-sonnet-4-5-20250929``."""
    if model_filter is None:
        return True
    if model is None:
        return False
    return model == model_filter or model.startswith(model_filter + "-")


def _model_condition(model_filter: str):
    escaped = model_filter.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return or_(RequestLog.model == model_filter, RequestLog.model.like(escaped + "-%", escape="\\"))


def key_rules(key: ApiKey) -> list[RuleSpec]:
    specs = [
        RuleSpec(
            id=rule.id,
            metric=rule.metric,
            window=rule.window,
            window_seconds=rule.window_seconds,
            max_value=rule.max_value,
            model_filter=rule.model_filter,
            source="rule",
        )
        for rule in key.limit_rules
    ]
    seconds = key.window_seconds
    window = next((name for name, length in ROLLING_WINDOWS.items() if length == seconds), "custom")
    for metric, limit in (
        ("requests", key.max_requests_per_window),
        ("total_tokens", key.max_tokens_per_window),
        ("cost_usd", key.max_cost_usd_per_window),
    ):
        if limit is not None:
            specs.append(
                RuleSpec(
                    id=f"legacy-{metric}",
                    metric=metric,
                    window=window,
                    window_seconds=seconds,
                    max_value=float(limit),
                    model_filter=None,
                    source="legacy",
                )
            )
    return specs


async def measure(
    session: AsyncSession, key_id: str, specs: Iterable[RuleSpec], *, now: datetime | None = None
) -> list[RuleUsage]:
    """Current usage for each rule. One query per distinct (window start, model filter)."""
    now = now or datetime.now(UTC)
    specs = list(specs)
    totals: dict[tuple[datetime, str | None], tuple] = {}
    out: list[RuleUsage] = []
    for spec in specs:
        since = window_start(spec, now)
        group = (since, spec.model_filter)
        if group not in totals:
            conditions = [RequestLog.api_key_id == key_id, RequestLog.created_at >= since]
            if spec.model_filter is not None:
                conditions.append(_model_condition(spec.model_filter))
            totals[group] = (
                await session.execute(
                    select(
                        func.count(RequestLog.id),
                        # Prompt tokens include cache reads and writes: every token the
                        # key caused to be processed counts, as in the original budget.
                        func.coalesce(
                            func.sum(
                                RequestLog.input_tokens
                                + RequestLog.cache_creation_input_tokens
                                + RequestLog.cache_read_input_tokens
                            ),
                            0,
                        ),
                        func.coalesce(func.sum(RequestLog.output_tokens), 0),
                        func.coalesce(func.sum(RequestLog.cost_usd), 0.0),
                        func.min(RequestLog.created_at),
                    ).where(*conditions)
                )
            ).one()
        requests, prompt, output, cost, oldest = totals[group]
        value = {
            "requests": requests,
            "input_tokens": prompt,
            "output_tokens": output,
            "total_tokens": prompt + output,
            "cost_usd": cost,
        }[spec.metric]
        if spec.window in CALENDAR_WINDOWS:
            resets_at: datetime | None = calendar_bounds(spec.window, now)[1]
        elif oldest is not None:
            oldest = oldest if oldest.tzinfo else oldest.replace(tzinfo=UTC)
            resets_at = oldest + timedelta(seconds=spec.window_seconds)
        else:
            resets_at = None
        out.append(RuleUsage(spec=spec, current_value=float(value), window_start=since, resets_at=resets_at))
    return out


def describe(spec: RuleSpec) -> str:
    """Human wording for a rule, used in the 429 a client sees."""
    if spec.metric == "cost_usd":
        amount = f"${spec.max_value:.2f}"
    elif spec.metric == "requests":
        amount = f"{spec.max_value:g} requests"
    else:
        amount = f"{spec.max_value:g} {spec.metric.replace('_', ' ')}"
    if spec.window in CALENDAR_WINDOWS:
        per = {"daily": "UTC day", "weekly": "UTC week", "monthly": "UTC month"}[spec.window]
    elif spec.window in ROLLING_WINDOWS:
        per = f"rolling {spec.window}"
    else:
        per = f"rolling {spec.window_seconds}s"
    scope = f" of {spec.model_filter}" if spec.model_filter else ""
    return f"{amount}{scope} per {per}"
