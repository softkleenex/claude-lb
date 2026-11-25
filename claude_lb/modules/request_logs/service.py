"""Request-log queries for the dashboard: filtered pages, facet options, one row's detail."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import ColumnElement, Select, and_, case, false, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from claude_lb.core.pricing import cache_read_savings_usd
from claude_lb.db.models import Account, ApiKey, RequestLog

STATUS_CATEGORIES: tuple[str, ...] = (
    "ok",
    "aborted",
    "rate_limited",
    "overloaded",
    "auth_error",
    "client_error",
    "server_error",
)
"""How a logged request ended. ``aborted`` is a successful response whose stream broke
off (usually the client hanging up); ``overloaded`` is Anthropic's 529."""


def status_category(status_code: int, error: str | None) -> str:
    if status_code == 429:
        return "rate_limited"
    if status_code == 529:
        return "overloaded"
    if status_code in (401, 403):
        return "auth_error"
    if 400 <= status_code < 500:
        return "client_error"
    if status_code >= 500 or status_code <= 0:
        return "server_error"
    return "aborted" if error else "ok"


def _category_condition(category: str) -> ColumnElement[bool]:
    code = RequestLog.status_code
    if category == "ok":
        return and_(code > 0, code < 400, RequestLog.error.is_(None))
    if category == "aborted":
        return and_(code > 0, code < 400, RequestLog.error.is_not(None))
    if category == "rate_limited":
        return code == 429
    if category == "overloaded":
        return code == 529
    if category == "auth_error":
        return code.in_((401, 403))
    if category == "client_error":
        return and_(code >= 400, code < 500, code.not_in((401, 403, 429)))
    if category == "server_error":
        return or_(and_(code >= 500, code != 529), code <= 0)
    return false()


@dataclass(slots=True)
class LogFilters:
    since: datetime | None = None
    until: datetime | None = None
    search: str | None = None
    account_ids: Sequence[str] = ()
    api_key_ids: Sequence[str] = ()
    models: Sequence[str] = ()
    statuses: Sequence[str] = ()
    session_key: str | None = None


def _escape_like(term: str) -> str:
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _apply(stmt: Select, filters: LogFilters) -> Select:
    if filters.since is not None:
        stmt = stmt.where(RequestLog.created_at >= filters.since)
    if filters.until is not None:
        stmt = stmt.where(RequestLog.created_at < filters.until)
    if filters.account_ids:
        stmt = stmt.where(RequestLog.account_id.in_(list(filters.account_ids)))
    if filters.api_key_ids:
        stmt = stmt.where(RequestLog.api_key_id.in_(list(filters.api_key_ids)))
    if filters.models:
        stmt = stmt.where(RequestLog.model.in_(list(filters.models)))
    if filters.statuses:
        stmt = stmt.where(or_(*(_category_condition(s) for s in filters.statuses)))
    if filters.session_key:
        stmt = stmt.where(RequestLog.session_key == filters.session_key)
    term = (filters.search or "").strip()
    if term:
        pattern = f"%{_escape_like(term)}%"
        stmt = stmt.where(
            or_(
                RequestLog.id.ilike(pattern, escape="\\"),
                RequestLog.model.ilike(pattern, escape="\\"),
                RequestLog.error.ilike(pattern, escape="\\"),
                RequestLog.session_key.ilike(pattern, escape="\\"),
                RequestLog.user_agent.ilike(pattern, escape="\\"),
                RequestLog.client_ip.ilike(pattern, escape="\\"),
                RequestLog.path.ilike(pattern, escape="\\"),
                Account.name.ilike(pattern, escape="\\"),
                ApiKey.name.ilike(pattern, escape="\\"),
            )
        )
    return stmt


def _base_select(*columns) -> Select:
    return (
        select(*columns)
        .select_from(RequestLog)
        .join(Account, Account.id == RequestLog.account_id, isouter=True)
        .join(ApiKey, ApiKey.id == RequestLog.api_key_id, isouter=True)
    )


def serialize(row: RequestLog, account: tuple[str | None, str | None], key_name: str | None) -> dict:
    prompt_tokens = row.input_tokens + row.cache_read_input_tokens + row.cache_creation_input_tokens
    account_name, plan_type = account
    return {
        "id": row.id,
        "created_at": row.created_at,
        "account_id": row.account_id,
        "account_name": account_name,
        "plan_type": plan_type,
        "api_key_id": row.api_key_id,
        "api_key_name": key_name,
        "path": row.path,
        "model": row.model,
        "status_code": row.status_code,
        "status": status_category(row.status_code, row.error),
        "streaming": row.streaming,
        "duration_ms": row.duration_ms,
        "ttft_ms": row.ttft_ms,
        "attempts": row.attempts,
        "input_tokens": row.input_tokens,
        "output_tokens": row.output_tokens,
        "cache_read_input_tokens": row.cache_read_input_tokens,
        "cache_creation_input_tokens": row.cache_creation_input_tokens,
        "total_tokens": prompt_tokens + row.output_tokens,
        "cost_usd": round(row.cost_usd, 8),
        "cache_savings_usd": round(
            cache_read_savings_usd(row.model, row.cache_read_input_tokens, prompt_tokens), 8
        ),
        "error": row.error,
        "session_key": row.session_key,
        "user_agent": row.user_agent,
        "client_ip": row.client_ip,
    }


async def list_page(
    session: AsyncSession, filters: LogFilters, *, limit: int, offset: int
) -> tuple[list[dict], int]:
    total = (await session.execute(_apply(_base_select(func.count(RequestLog.id)), filters))).scalar_one()
    rows = await session.execute(
        _apply(_base_select(RequestLog, Account.name, Account.plan_type, ApiKey.name), filters)
        .order_by(RequestLog.created_at.desc(), RequestLog.id.desc())
        .limit(limit)
        .offset(offset)
    )
    items = [serialize(log, (name, plan), key_name) for log, name, plan, key_name in rows]
    return items, int(total)


async def get_one(session: AsyncSession, request_id: str) -> dict | None:
    row = (
        await session.execute(
            _base_select(RequestLog, Account.name, Account.plan_type, ApiKey.name).where(
                RequestLog.id == request_id
            )
        )
    ).first()
    if row is None:
        return None
    log, name, plan, key_name = row
    item = serialize(log, (name, plan), key_name)
    item["conversation"] = await conversation_summary(session, log.session_key)
    return item


async def conversation_summary(session: AsyncSession, session_key: str | None) -> dict | None:
    if not session_key:
        return None
    count, cost, first, last = (
        await session.execute(
            select(
                func.count(RequestLog.id),
                func.coalesce(func.sum(RequestLog.cost_usd), 0.0),
                func.min(RequestLog.created_at),
                func.max(RequestLog.created_at),
            ).where(RequestLog.session_key == session_key)
        )
    ).one()
    return {
        "requests": int(count),
        "cost_usd": round(float(cost), 8),
        "first_at": first,
        "last_at": last,
    }


async def filter_options(session: AsyncSession, *, since: datetime | None) -> dict:
    window = [RequestLog.created_at >= since] if since is not None else []

    accounts = await session.execute(
        select(RequestLog.account_id, Account.name)
        .join(Account, Account.id == RequestLog.account_id, isouter=True)
        .where(RequestLog.account_id.is_not(None), *window)
        .group_by(RequestLog.account_id, Account.name)
        .order_by(Account.name)
    )
    keys = await session.execute(
        select(RequestLog.api_key_id, ApiKey.name, ApiKey.key_hint)
        .join(ApiKey, ApiKey.id == RequestLog.api_key_id, isouter=True)
        .where(RequestLog.api_key_id.is_not(None), *window)
        .group_by(RequestLog.api_key_id, ApiKey.name, ApiKey.key_hint)
        .order_by(ApiKey.name)
    )
    models = await session.execute(
        select(RequestLog.model)
        .where(RequestLog.model.is_not(None), *window)
        .group_by(RequestLog.model)
        .order_by(RequestLog.model)
    )
    status_rows = await session.execute(
        select(
            RequestLog.status_code,
            case((RequestLog.error.is_(None), 0), else_=1).label("has_error"),
        )
        .where(*window)
        .group_by(RequestLog.status_code, "has_error")
    )
    present = {status_category(code, "x" if has_error else None) for code, has_error in status_rows}
    return {
        "accounts": [{"id": aid, "name": name or "(deleted)"} for aid, name in accounts],
        "api_keys": [
            {"id": kid, "name": name or "(deleted)", "key_hint": hint or ""} for kid, name, hint in keys
        ],
        "models": [model for (model,) in models],
        "statuses": [s for s in STATUS_CATEGORIES if s in present],
    }
