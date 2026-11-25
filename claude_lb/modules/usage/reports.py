"""Date-range cost reports, for chargeback and billing reconciliation.

Built on the daily rollups rather than the request log, so a report can cover a range
longer than `request_log_retention_days`. Grouping is chosen by the caller: `day`,
`account`, `api_key`, `model`, or `user_agent`.

The user agent is only recorded on request logs (rollups have no such dimension), so a
report that groups or filters by it is read from the logs and is limited by retention.
"""

from __future__ import annotations

import csv
import io
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta

from sqlalchemy import ColumnElement, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from claude_lb.core.pricing import cache_read_savings_usd
from claude_lb.db.models import Account, ApiKey, RequestLog, UsageDaily
from claude_lb.modules.dashboard.overview import _bucket_index

GROUPINGS = ("day", "account", "api_key", "model", "user_agent")
MAX_RANGE_DAYS = 366
UNKNOWN_USER_AGENT = "(unknown)"

CSV_COLUMNS = (
    "group",
    "label",
    "requests",
    "errors",
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "cache_savings_usd",
    "cost_usd",
)
"""``cost_usd`` stays the last column: spreadsheets built on the original export read it there."""

_COUNTERS = (
    "requests",
    "errors",
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
)


@dataclass(slots=True)
class ReportFilters:
    """Multi-value filters; an empty sequence means "no filter on this dimension"."""

    account_ids: Sequence[str] = ()
    api_key_ids: Sequence[str] = ()
    models: Sequence[str] = ()
    user_agents: Sequence[str] = ()
    """User-agent *families* (the product token before the first ``/``)."""

    @property
    def needs_logs(self) -> bool:
        return bool(self.user_agents)


@dataclass(slots=True)
class Fact:
    """One aggregated cell: a day x account x key x model (x user agent) total."""

    day: str
    account_id: str | None
    api_key_id: str | None
    model: str | None
    user_agent: str | None = None
    requests: int = 0
    errors: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0
    cost_usd: float = 0.0

    @property
    def cache_savings_usd(self) -> float:
        return cache_read_savings_usd(self.model, self.cache_read_input_tokens)


@dataclass
class ReportRow:
    key: str | None
    label: str
    requests: int = 0
    errors: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0
    cost_usd: float = 0.0
    cache_savings_usd: float = 0.0

    @property
    def total_tokens(self) -> int:
        return (
            self.input_tokens
            + self.output_tokens
            + self.cache_creation_input_tokens
            + self.cache_read_input_tokens
        )

    def add(self, fact: Fact) -> None:
        for name in _COUNTERS:
            setattr(self, name, getattr(self, name) + getattr(fact, name))
        self.cost_usd += fact.cost_usd
        self.cache_savings_usd += fact.cache_savings_usd

    def rounded(self) -> ReportRow:
        self.cost_usd = round(self.cost_usd, 6)
        self.cache_savings_usd = round(self.cache_savings_usd, 6)
        return self

    def as_dict(self) -> dict:
        return {
            "key": self.key,
            "label": self.label,
            "requests": self.requests,
            "errors": self.errors,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cache_creation_input_tokens": self.cache_creation_input_tokens,
            "cache_read_input_tokens": self.cache_read_input_tokens,
            "total_tokens": self.total_tokens,
            "cost_usd": self.cost_usd,
            "cache_savings_usd": self.cache_savings_usd,
        }


@dataclass
class Report:
    group_by: str
    start: str
    end: str
    rows: list[ReportRow]
    source: str = "rollups"
    filters: ReportFilters = field(default_factory=ReportFilters)

    @property
    def total_cost_usd(self) -> float:
        return round(sum(r.cost_usd for r in self.rows), 6)

    @property
    def total_requests(self) -> int:
        return sum(r.requests for r in self.rows)

    def total_row(self) -> ReportRow:
        total = ReportRow(key=None, label="TOTAL")
        for row in self.rows:
            for name in _COUNTERS:
                setattr(total, name, getattr(total, name) + getattr(row, name))
            total.cost_usd += row.cost_usd
            total.cache_savings_usd += row.cache_savings_usd
        return total.rounded()


def default_range(days: int = 30) -> tuple[str, str]:
    end = datetime.now(UTC).date()
    return (end - timedelta(days=days - 1)).isoformat(), end.isoformat()


def normalize_range(start: str | None, end: str | None) -> tuple[str, str]:
    """Validate an inclusive ISO date range, defaulting to the last 30 days."""
    fallback_start, fallback_end = default_range()
    start = start or fallback_start
    end = end or fallback_end
    try:
        start_date, end_date = date.fromisoformat(start), date.fromisoformat(end)
    except ValueError as exc:
        raise ValueError("dates must be ISO YYYY-MM-DD") from exc
    if start_date > end_date:
        raise ValueError("start must not be after end")
    if (end_date - start_date).days + 1 > MAX_RANGE_DAYS:
        raise ValueError(f"the range must be {MAX_RANGE_DAYS} days or less")
    return start_date.isoformat(), end_date.isoformat()


def day_bounds(start: str, end: str) -> tuple[datetime, datetime]:
    """UTC instants covering the inclusive day range: [start 00:00, end + 1 day 00:00)."""
    since = datetime.combine(date.fromisoformat(start), time.min, tzinfo=UTC)
    until = datetime.combine(date.fromisoformat(end) + timedelta(days=1), time.min, tzinfo=UTC)
    return since, until


def user_agent_family(user_agent: str | None) -> str:
    """The product token of a User-Agent: ``claude-cli/2.1 (external)`` → ``claude-cli``."""
    family = (user_agent or "").split("/", 1)[0]
    return family[:64] if family else UNKNOWN_USER_AGENT


def _escape_like(term: str) -> str:
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def user_agent_condition(families: Iterable[str]) -> ColumnElement[bool]:
    """SQL twin of :func:`user_agent_family`: rows whose UA belongs to any family."""
    ua = RequestLog.user_agent
    clauses = []
    for family in families:
        if family == UNKNOWN_USER_AGENT:
            clauses += [ua.is_(None), ua == "", ua.like("/%")]
        else:
            clauses += [ua == family, ua.like(f"{_escape_like(family)}/%", escape="\\")]
    return or_(*clauses)


def log_conditions(since: datetime, until: datetime, filters: ReportFilters) -> list[ColumnElement[bool]]:
    """Request-log WHERE clauses for a report window and its filters."""
    conditions: list[ColumnElement[bool]] = [RequestLog.created_at >= since, RequestLog.created_at < until]
    if filters.account_ids:
        conditions.append(RequestLog.account_id.in_(list(filters.account_ids)))
    if filters.api_key_ids:
        conditions.append(RequestLog.api_key_id.in_(list(filters.api_key_ids)))
    if filters.models:
        conditions.append(RequestLog.model.in_(list(filters.models)))
    if filters.user_agents:
        conditions.append(user_agent_condition(filters.user_agents))
    return conditions


def day_column(dialect: str, since: datetime):
    """Integer day offset of a request log from ``since`` (portable SQLite/Postgres)."""
    return _bucket_index(dialect, since, 86400)


async def load_facts(
    session: AsyncSession,
    start: str,
    end: str,
    filters: ReportFilters,
    *,
    from_logs: bool = False,
) -> list[Fact]:
    """Aggregated cells for the range. Rollups unless ``from_logs`` or a UA filter is set."""
    if from_logs or filters.needs_logs:
        return await _log_facts(session, start, end, filters)
    return await _rollup_facts(session, start, end, filters)


async def _rollup_facts(session: AsyncSession, start: str, end: str, filters: ReportFilters) -> list[Fact]:
    # `day` is ISO text, so it compares lexicographically in chronological order.
    conditions = [UsageDaily.day >= start, UsageDaily.day <= end]
    if filters.account_ids:
        conditions.append(UsageDaily.account_id.in_(list(filters.account_ids)))
    if filters.api_key_ids:
        conditions.append(UsageDaily.api_key_id.in_(list(filters.api_key_ids)))
    if filters.models:
        conditions.append(UsageDaily.model.in_(list(filters.models)))
    dims = (UsageDaily.day, UsageDaily.account_id, UsageDaily.api_key_id, UsageDaily.model)
    result = await session.execute(
        select(
            *dims,
            func.coalesce(func.sum(UsageDaily.requests), 0),
            func.coalesce(func.sum(UsageDaily.errors), 0),
            func.coalesce(func.sum(UsageDaily.input_tokens), 0),
            func.coalesce(func.sum(UsageDaily.output_tokens), 0),
            func.coalesce(func.sum(UsageDaily.cache_creation_input_tokens), 0),
            func.coalesce(func.sum(UsageDaily.cache_read_input_tokens), 0),
            func.coalesce(func.sum(UsageDaily.cost_usd), 0.0),
        )
        .where(*conditions)
        .group_by(*dims)
    )
    return [_fact(row[0], row[1], row[2], row[3], None, row[4:]) for row in result]


async def _log_facts(session: AsyncSession, start: str, end: str, filters: ReportFilters) -> list[Fact]:
    since, until = day_bounds(start, end)
    day_index = day_column(session.get_bind().dialect.name, since).label("day_index")
    dims = (day_index, RequestLog.account_id, RequestLog.api_key_id, RequestLog.model, RequestLog.user_agent)
    result = await session.execute(
        select(
            *dims,
            func.count(RequestLog.id),
            func.coalesce(func.sum(case((RequestLog.status_code >= 400, 1), else_=0)), 0),
            func.coalesce(func.sum(RequestLog.input_tokens), 0),
            func.coalesce(func.sum(RequestLog.output_tokens), 0),
            func.coalesce(func.sum(RequestLog.cache_creation_input_tokens), 0),
            func.coalesce(func.sum(RequestLog.cache_read_input_tokens), 0),
            func.coalesce(func.sum(RequestLog.cost_usd), 0.0),
        )
        .where(*log_conditions(since, until, filters))
        .group_by(*dims)
    )
    start_date = since.date()
    last = (until - since).days - 1
    facts: dict[tuple, Fact] = {}
    for row in result:
        offset = min(max(int(row[0] or 0), 0), last)
        day = (start_date + timedelta(days=offset)).isoformat()
        family = user_agent_family(row[4])
        key = (day, row[1], row[2], row[3], family)
        fact = facts.get(key)
        incoming = _fact(day, row[1], row[2], row[3], family, row[5:])
        if fact is None:
            facts[key] = incoming
        else:
            for name in _COUNTERS:
                setattr(fact, name, getattr(fact, name) + getattr(incoming, name))
            fact.cost_usd += incoming.cost_usd
    return list(facts.values())


def _fact(day, account_id, api_key_id, model, user_agent, values) -> Fact:
    requests, errors, inp, out, cache_write, cache_read, cost = values
    return Fact(
        day=day,
        account_id=account_id,
        api_key_id=api_key_id,
        model=model,
        user_agent=user_agent,
        requests=int(requests or 0),
        errors=int(errors or 0),
        input_tokens=int(inp or 0),
        output_tokens=int(out or 0),
        cache_creation_input_tokens=int(cache_write or 0),
        cache_read_input_tokens=int(cache_read or 0),
        cost_usd=float(cost or 0.0),
    )


def _group_key(fact: Fact, group_by: str) -> str | None:
    if group_by == "day":
        return fact.day
    if group_by == "account":
        return fact.account_id
    if group_by == "api_key":
        return fact.api_key_id
    if group_by == "model":
        return fact.model
    return fact.user_agent


async def group_facts(session: AsyncSession, facts: Iterable[Fact], group_by: str) -> list[ReportRow]:
    """Fold facts into labelled rows: chronological for days, costliest first otherwise."""
    grouped: dict[str | None, ReportRow] = {}
    for fact in facts:
        key = _group_key(fact, group_by)
        row = grouped.get(key)
        if row is None:
            row = grouped[key] = ReportRow(key=key, label="")
        row.add(fact)
    labels: dict[str | None, str] = dict(await _labels(session, group_by, list(grouped)))
    rows = []
    for key, row in grouped.items():
        row.label = labels.get(key) or _fallback_label(group_by, key)
        rows.append(row.rounded())
    if group_by == "day":
        rows.sort(key=lambda r: r.key or "")
    else:
        rows.sort(key=lambda r: (-r.cost_usd, -r.requests, r.label))
    return rows


async def build(
    session: AsyncSession,
    *,
    group_by: str = "day",
    start: str | None = None,
    end: str | None = None,
    filters: ReportFilters | None = None,
) -> Report:
    if group_by not in GROUPINGS:
        raise ValueError(f"group_by must be one of {', '.join(GROUPINGS)}")
    start, end = normalize_range(start, end)
    filters = filters or ReportFilters()
    from_logs = group_by == "user_agent" or filters.needs_logs
    facts = await load_facts(session, start, end, filters, from_logs=from_logs)
    rows = await group_facts(session, facts, group_by)
    return Report(
        group_by=group_by,
        start=start,
        end=end,
        rows=rows,
        source="request_logs" if from_logs else "rollups",
        filters=filters,
    )


def _fallback_label(group_by: str, key: str | None) -> str:
    """Name a group whose row has no live record behind it.

    Two different situations, and conflating them misleads: a NULL key means the
    spend was never attributed (requests made without a client key, or rollups
    written before the dimension existed), whereas a key that is present but no
    longer resolves means the account or key was deleted after the fact.
    """
    if key is None:
        return "(unattributed)"
    if group_by in ("account", "api_key"):
        return f"(deleted: {key[:8]})"
    return key


async def _labels(session: AsyncSession, group_by: str, keys: list[str | None]) -> dict[str, str]:
    present = [k for k in keys if k]
    if not present:
        return {}
    if group_by == "account":
        result = await session.execute(select(Account.id, Account.name).where(Account.id.in_(present)))
    elif group_by == "api_key":
        result = await session.execute(select(ApiKey.id, ApiKey.name).where(ApiKey.id.in_(present)))
    else:
        return {}
    return {row[0]: row[1] for row in result}


_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def _cell(value: str) -> str:
    """Neutralize a text cell a spreadsheet would evaluate as a formula.

    Labels are operator-chosen names and, for the model grouping, whatever model
    string a client sent — so ``=HYPERLINK(...)`` must open as text, not run.
    """
    return "'" + value if value.startswith(_FORMULA_PREFIXES) else value


def _csv_values(group_by: str, row: ReportRow) -> list:
    return [
        group_by,
        _cell(row.label),
        row.requests,
        row.errors,
        row.input_tokens,
        row.output_tokens,
        row.cache_creation_input_tokens,
        row.cache_read_input_tokens,
        f"{row.cache_savings_usd:.6f}",
        f"{row.cost_usd:.6f}",
    ]


def to_csv(report: Report) -> str:
    """Render a report as CSV, with a totals row so a spreadsheet reconciles."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(CSV_COLUMNS)
    for row in report.rows:
        writer.writerow(_csv_values(report.group_by, row))
    writer.writerow(_csv_values(report.group_by, report.total_row()))
    return buffer.getvalue()


def filename(report: Report) -> str:
    return f"claude-lb-{report.group_by}-{report.start}-to-{report.end}.csv"
