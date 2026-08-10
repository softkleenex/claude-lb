"""Date-range cost reports, for chargeback and billing reconciliation.

Built on the daily rollups rather than the request log, so a report can cover a range
longer than `request_log_retention_days`. Grouping is chosen by the caller: `day`,
`account`, `api_key`, or `model`.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Account, ApiKey, UsageDaily

GROUPINGS = ("day", "account", "api_key", "model")

_METRICS = (
    func.coalesce(func.sum(UsageDaily.requests), 0),
    func.coalesce(func.sum(UsageDaily.errors), 0),
    func.coalesce(func.sum(UsageDaily.input_tokens), 0),
    func.coalesce(func.sum(UsageDaily.output_tokens), 0),
    func.coalesce(func.sum(UsageDaily.cache_creation_input_tokens), 0),
    func.coalesce(func.sum(UsageDaily.cache_read_input_tokens), 0),
    func.coalesce(func.sum(UsageDaily.cost_usd), 0.0),
)

CSV_COLUMNS = (
    "group",
    "label",
    "requests",
    "errors",
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "cost_usd",
)


@dataclass
class ReportRow:
    key: str | None
    label: str
    requests: int
    errors: int
    input_tokens: int
    output_tokens: int
    cache_creation_input_tokens: int
    cache_read_input_tokens: int
    cost_usd: float

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
            "cost_usd": self.cost_usd,
        }


@dataclass
class Report:
    group_by: str
    start: str
    end: str
    rows: list[ReportRow]

    @property
    def total_cost_usd(self) -> float:
        return round(sum(r.cost_usd for r in self.rows), 6)

    @property
    def total_requests(self) -> int:
        return sum(r.requests for r in self.rows)


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
    return start_date.isoformat(), end_date.isoformat()


async def build(
    session: AsyncSession,
    *,
    group_by: str = "day",
    start: str | None = None,
    end: str | None = None,
) -> Report:
    if group_by not in GROUPINGS:
        raise ValueError(f"group_by must be one of {', '.join(GROUPINGS)}")
    start, end = normalize_range(start, end)

    # Range is inclusive at both ends; `day` is stored as ISO text so it compares
    # lexicographically in the same order as chronologically.
    window = (UsageDaily.day >= start, UsageDaily.day <= end)

    if group_by == "day":
        column = UsageDaily.day
    elif group_by == "account":
        column = UsageDaily.account_id
    elif group_by == "api_key":
        column = UsageDaily.api_key_id
    else:
        column = UsageDaily.model

    result = await session.execute(select(column, *_METRICS).where(*window).group_by(column).order_by(column))
    raw = list(result)

    labels = await _labels(session, group_by, [row[0] for row in raw])
    rows = [
        ReportRow(
            key=row[0],
            label=labels.get(row[0], _fallback_label(group_by, row[0])),
            requests=row[1],
            errors=row[2],
            input_tokens=row[3],
            output_tokens=row[4],
            cache_creation_input_tokens=row[5],
            cache_read_input_tokens=row[6],
            cost_usd=round(row[7], 6),
        )
        for row in raw
    ]
    # Costliest first for everything except a day series, which reads chronologically.
    if group_by != "day":
        rows.sort(key=lambda r: r.cost_usd, reverse=True)

    return Report(group_by=group_by, start=start, end=end, rows=rows)


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


def to_csv(report: Report) -> str:
    """Render a report as CSV, with a totals row so a spreadsheet reconciles."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(CSV_COLUMNS)
    for row in report.rows:
        writer.writerow(
            [
                report.group_by,
                row.label,
                row.requests,
                row.errors,
                row.input_tokens,
                row.output_tokens,
                row.cache_creation_input_tokens,
                row.cache_read_input_tokens,
                f"{row.cost_usd:.6f}",
            ]
        )
    writer.writerow(
        [
            report.group_by,
            "TOTAL",
            report.total_requests,
            sum(r.errors for r in report.rows),
            sum(r.input_tokens for r in report.rows),
            sum(r.output_tokens for r in report.rows),
            sum(r.cache_creation_input_tokens for r in report.rows),
            sum(r.cache_read_input_tokens for r in report.rows),
            f"{report.total_cost_usd:.6f}",
        ]
    )
    return buffer.getvalue()


def filename(report: Report) -> str:
    return f"claude-lb-{report.group_by}-{report.start}-to-{report.end}.csv"
