from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from claude_lb.dependencies import SessionDep
from claude_lb.modules.audit import service
from claude_lb.modules.auth.dependencies import ManagementAuthDep, is_guest
from claude_lb.modules.dashboard.timeframes import TIMEFRAMES

router = APIRouter(prefix="/api/audit", tags=["audit"])


class AuditEventOut(BaseModel):
    id: str
    created_at: datetime
    action: str
    target: str
    detail: str
    actor: str
    client_ip: str
    ok: bool


class AuditPage(BaseModel):
    events: list[AuditEventOut]
    total: int
    limit: int
    offset: int
    has_more: bool


class AuditActionCount(BaseModel):
    action: str
    count: int


def _out(event, *, guest: bool) -> AuditEventOut:
    out = AuditEventOut.model_validate(event, from_attributes=True)
    if not guest:
        return out
    # Guests get a read-only view; who connected from where is not part of it — and a
    # firewall entry *is* an address (its note often names whose).
    update = {"client_ip": ""}
    if service.reveals_addresses(out.action):
        update |= {"target": "hidden", "detail": ""}
    return out.model_copy(update=update)


def _aware(value: datetime | None) -> datetime | None:
    if value is None or value.tzinfo:
        return value
    return value.replace(tzinfo=UTC)


@router.get("", response_model=list[AuditEventOut])
async def list_events(
    request: Request,
    session: SessionDep,
    _: ManagementAuthDep,
    limit: int = Query(default=100, ge=1, le=1000),
    action: str | None = None,
) -> list[AuditEventOut]:
    """Most recent events as a plain list (kept for scripts and the legacy dashboard)."""
    events = await service.recent(session, limit=limit, action=action)
    guest = is_guest(request)
    return [_out(e, guest=guest) for e in events]


@router.get("/events", response_model=AuditPage)
async def page_events(
    request: Request,
    session: SessionDep,
    _: ManagementAuthDep,
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    action: Annotated[list[str] | None, Query()] = None,
    target: str | None = Query(default=None, max_length=128),
    search: str | None = Query(default=None, max_length=200),
    timeframe: str | None = Query(default=None, description="all | 1h | 24h | 7d | 30d"),
    since: datetime | None = None,
    until: datetime | None = None,
    ok: bool | None = None,
) -> AuditPage:
    """Filtered, paged events, newest first."""
    if since is None and timeframe and timeframe != "all":
        frame = TIMEFRAMES.get(timeframe)
        if frame is None:
            raise HTTPException(422, f"timeframe must be one of all, {', '.join(TIMEFRAMES)}")
        since = datetime.now(UTC) - frame.window
    guest = is_guest(request)
    events, total = await service.page(
        session,
        limit=limit,
        offset=offset,
        actions=action or (),
        target=target,
        search=search,
        since=_aware(since),
        until=_aware(until),
        ok=ok,
        search_client_ip=not guest,
    )
    return AuditPage(
        events=[_out(e, guest=guest) for e in events],
        total=total,
        limit=limit,
        offset=offset,
        has_more=offset + len(events) < total,
    )


@router.get("/actions", response_model=list[AuditActionCount])
async def list_actions(session: SessionDep, _: ManagementAuthDep) -> list[AuditActionCount]:
    return [AuditActionCount(action=a, count=n) for a, n in await service.actions(session)]
