"""Conversations: request logs grouped by the sticky-routing ``session_key``.

A conversation is every logged request that shares the hash of its cacheable prefix
(``proxy.sticky.session_key``). Aggregates cover the selected window only, so a long
conversation viewed through "last hour" shows just that hour's share of it.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime

from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from claude_lb.db.models import Account, ApiKey, RequestLog
from claude_lb.modules.request_logs.service import _escape_like, serialize
from claude_lb.modules.usage.reports import user_agent_family

TIMELINE_LIMIT = 200

_ERROR = case(
    (and_(RequestLog.status_code > 0, RequestLog.status_code < 400, RequestLog.error.is_(None)), 0),
    else_=1,
)


def _window(since: datetime | None, until: datetime | None) -> list:
    conditions = [RequestLog.session_key.is_not(None)]
    if since is not None:
        conditions.append(RequestLog.created_at >= since)
    if until is not None:
        conditions.append(RequestLog.created_at < until)
    return conditions


def _search_condition(term: str):
    """Conversations with at least one request matching the term."""
    pattern = f"%{_escape_like(term)}%"
    matching = (
        select(RequestLog.session_key)
        .select_from(RequestLog)
        .join(Account, Account.id == RequestLog.account_id, isouter=True)
        .join(ApiKey, ApiKey.id == RequestLog.api_key_id, isouter=True)
        .where(
            RequestLog.session_key.is_not(None),
            or_(
                RequestLog.session_key.ilike(pattern, escape="\\"),
                RequestLog.model.ilike(pattern, escape="\\"),
                RequestLog.user_agent.ilike(pattern, escape="\\"),
                RequestLog.client_ip.ilike(pattern, escape="\\"),
                Account.name.ilike(pattern, escape="\\"),
                ApiKey.name.ilike(pattern, escape="\\"),
            ),
        )
    )
    return RequestLog.session_key.in_(matching)


def _duration_ms(first: datetime | None, last: datetime | None) -> int:
    if first is None or last is None:
        return 0
    return max(0, int((last - first).total_seconds() * 1000))


def _ranked(counter: Counter) -> list:
    """Keys by request count, most used first (ties by name, for stable output)."""
    return [key for key, _ in sorted(counter.items(), key=lambda kv: (-kv[1], str(kv[0])))]


async def list_page(
    session: AsyncSession,
    *,
    since: datetime | None,
    until: datetime | None = None,
    search: str | None = None,
    limit: int = 25,
    offset: int = 0,
) -> tuple[list[dict], int]:
    conditions = _window(since, until)
    term = (search or "").strip()
    if term:
        conditions.append(_search_condition(term))

    total = (
        await session.execute(select(func.count(func.distinct(RequestLog.session_key))).where(*conditions))
    ).scalar_one()

    last_at = func.max(RequestLog.created_at)
    rows = (
        await session.execute(
            select(
                RequestLog.session_key,
                func.min(RequestLog.created_at),
                last_at,
                func.count(RequestLog.id),
                func.coalesce(func.sum(_ERROR), 0),
                func.coalesce(func.sum(RequestLog.input_tokens), 0),
                func.coalesce(func.sum(RequestLog.output_tokens), 0),
                func.coalesce(func.sum(RequestLog.cache_read_input_tokens), 0),
                func.coalesce(func.sum(RequestLog.cache_creation_input_tokens), 0),
                func.coalesce(func.sum(RequestLog.cost_usd), 0.0),
            )
            .where(*conditions)
            .group_by(RequestLog.session_key)
            .order_by(last_at.desc(), RequestLog.session_key)
            .limit(limit)
            .offset(offset)
        )
    ).all()
    keys = [row[0] for row in rows]
    facets = await _facets(session, keys, conditions)

    items = []
    for key, first, last, count, errors, inp, out, cache_read, cache_write, cost in rows:
        facet = facets.get(key, {})
        items.append(
            {
                "session_key": key,
                "first_at": first,
                "last_at": last,
                "duration_ms": _duration_ms(first, last),
                "requests": int(count),
                "errors": int(errors),
                "input_tokens": int(inp),
                "output_tokens": int(out),
                "cache_read_input_tokens": int(cache_read),
                "cache_creation_input_tokens": int(cache_write),
                "total_tokens": int(inp + out + cache_read + cache_write),
                "cost_usd": round(float(cost), 8),
                "accounts": facet.get("accounts", []),
                "api_keys": facet.get("api_keys", []),
                "models": facet.get("models", []),
            }
        )
    return items, int(total)


async def _facets(session: AsyncSession, keys: list[str], conditions: list) -> dict[str, dict]:
    """Accounts, API keys and models used by each conversation on the page."""
    if not keys:
        return {}
    rows = await session.execute(
        select(
            RequestLog.session_key,
            RequestLog.account_id,
            Account.name,
            RequestLog.api_key_id,
            ApiKey.name,
            RequestLog.model,
            func.count(RequestLog.id),
        )
        .select_from(RequestLog)
        .join(Account, Account.id == RequestLog.account_id, isouter=True)
        .join(ApiKey, ApiKey.id == RequestLog.api_key_id, isouter=True)
        .where(*conditions, RequestLog.session_key.in_(keys))
        .group_by(
            RequestLog.session_key,
            RequestLog.account_id,
            Account.name,
            RequestLog.api_key_id,
            ApiKey.name,
            RequestLog.model,
        )
    )
    accounts: dict[str, Counter] = defaultdict(Counter)
    api_keys: dict[str, Counter] = defaultdict(Counter)
    models: dict[str, Counter] = defaultdict(Counter)
    for key, account_id, account_name, api_key_id, key_name, model, count in rows:
        if account_id:
            accounts[key][(account_id, account_name or "(deleted)")] += count
        if api_key_id:
            api_keys[key][(api_key_id, key_name or "(deleted)")] += count
        if model:
            models[key][model] += count
    return {
        key: {
            "accounts": [{"id": aid, "name": name} for aid, name in _ranked(accounts[key])],
            "api_keys": [{"id": kid, "name": name} for kid, name in _ranked(api_keys[key])],
            "models": _ranked(models[key]),
        }
        for key in keys
    }


async def detail(session: AsyncSession, session_key: str) -> dict | None:
    """Every retained request of one conversation, whatever the window."""
    base = RequestLog.session_key == session_key
    summary = (
        await session.execute(
            select(
                func.count(RequestLog.id),
                func.min(RequestLog.created_at),
                func.max(RequestLog.created_at),
                func.coalesce(func.sum(_ERROR), 0),
                func.coalesce(func.sum(RequestLog.cost_usd), 0.0),
                func.coalesce(func.sum(RequestLog.duration_ms), 0),
            ).where(base)
        )
    ).one()
    count, first, last, errors, cost, busy_ms = summary
    if not count:
        return None

    model_rows = await session.execute(
        select(
            RequestLog.model,
            func.count(RequestLog.id),
            func.coalesce(func.sum(_ERROR), 0),
            func.coalesce(func.sum(RequestLog.duration_ms), 0),
            func.coalesce(func.sum(RequestLog.input_tokens), 0),
            func.coalesce(func.sum(RequestLog.cache_read_input_tokens), 0),
            func.coalesce(func.sum(RequestLog.cache_creation_input_tokens), 0),
            func.coalesce(func.sum(RequestLog.output_tokens), 0),
            func.coalesce(func.sum(RequestLog.cost_usd), 0.0),
        )
        .where(base)
        .group_by(RequestLog.model)
    )
    models = sorted(
        (
            {
                "model": model,
                "requests": int(n),
                "errors": int(errs),
                "duration_ms": int(dur),
                "input_tokens": int(inp),
                "cache_read_input_tokens": int(cread),
                "cache_creation_input_tokens": int(cwrite),
                "output_tokens": int(out),
                "cost_usd": round(float(model_cost), 8),
            }
            for model, n, errs, dur, inp, cread, cwrite, out, model_cost in model_rows
        ),
        key=lambda m: (-m["requests"], m["model"] or ""),
    )

    account_rows = await session.execute(
        select(RequestLog.account_id, Account.name, Account.plan_type, func.count(RequestLog.id))
        .join(Account, Account.id == RequestLog.account_id, isouter=True)
        .where(base, RequestLog.account_id.is_not(None))
        .group_by(RequestLog.account_id, Account.name, Account.plan_type)
    )
    accounts = sorted(
        (
            {"id": aid, "name": name or "(deleted)", "plan_type": plan, "requests": int(n)}
            for aid, name, plan, n in account_rows
        ),
        key=lambda a: (-a["requests"], a["name"]),
    )
    key_rows = await session.execute(
        select(RequestLog.api_key_id, ApiKey.name, func.count(RequestLog.id))
        .join(ApiKey, ApiKey.id == RequestLog.api_key_id, isouter=True)
        .where(base, RequestLog.api_key_id.is_not(None))
        .group_by(RequestLog.api_key_id, ApiKey.name)
    )
    api_keys = sorted(
        ({"id": kid, "name": name or "(deleted)", "requests": int(n)} for kid, name, n in key_rows),
        key=lambda k: (-k["requests"], k["name"]),
    )

    ua_rows = await session.execute(
        select(RequestLog.user_agent, func.count(RequestLog.id)).where(base).group_by(RequestLog.user_agent)
    )
    agents: Counter = Counter()
    families: Counter = Counter()
    for agent, n in ua_rows:
        if agent:
            agents[agent] += n
        families[user_agent_family(agent)] += n
    dominant_agent = _ranked(agents)[0] if agents else None
    dominant_family = _ranked(families)[0] if families else None

    timeline_rows = await session.execute(
        select(RequestLog, Account.name, Account.plan_type, ApiKey.name)
        .select_from(RequestLog)
        .join(Account, Account.id == RequestLog.account_id, isouter=True)
        .join(ApiKey, ApiKey.id == RequestLog.api_key_id, isouter=True)
        .where(base)
        .order_by(RequestLog.created_at.desc(), RequestLog.id.desc())
        .limit(TIMELINE_LIMIT)
    )
    timeline = [serialize(log, (name, plan), key_name) for log, name, plan, key_name in timeline_rows]

    return {
        "session_key": session_key,
        "first_at": first,
        "last_at": last,
        "duration_ms": _duration_ms(first, last),
        "busy_ms": int(busy_ms),
        "requests": int(count),
        "errors": int(errors),
        "cost_usd": round(float(cost), 8),
        "account_count": len(accounts),
        "accounts": accounts,
        "api_keys": api_keys,
        "dominant_user_agent": dominant_agent,
        "dominant_user_agent_family": dominant_family,
        "models": models,
        "timeline": timeline,
        "timeline_truncated": int(count) > TIMELINE_LIMIT,
    }
