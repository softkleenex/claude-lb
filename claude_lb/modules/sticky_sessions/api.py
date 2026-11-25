"""Browse and clear the in-process conversation → account affinity map.

The map lives in this process's memory (``proxy.sticky``): it is empty after a
restart, and each worker of a multi-worker deployment has its own.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from claude_lb.db.models import Account
from claude_lb.dependencies import SessionDep
from claude_lb.modules.audit import service as audit
from claude_lb.modules.auth.dependencies import client_ip
from claude_lb.modules.proxy import sticky
from claude_lb.modules.settings import service as settings_service

router = APIRouter(prefix="/api/sticky-sessions", tags=["sticky-sessions"])


class StickyEntry(BaseModel):
    key: str
    account_id: str
    account_name: str | None
    expires_at: datetime
    remaining_seconds: int
    expired: bool


class StickyAccountCount(BaseModel):
    account_id: str
    account_name: str | None
    entries: int


class StickyPage(BaseModel):
    entries: list[StickyEntry]
    total: int
    limit: int
    offset: int
    has_more: bool
    size: int
    expired_count: int
    capacity: int
    enabled: bool
    ttl_seconds: int
    by_account: list[StickyAccountCount]


class DeleteKeys(BaseModel):
    keys: list[str] = Field(min_length=1, max_length=1000)


class DeleteAccount(BaseModel):
    account_id: str = Field(min_length=1)


class DeletedCount(BaseModel):
    deleted_count: int


def _entries(count: int, qualifier: str = "") -> str:
    return f"{count} {qualifier}{'entry' if count == 1 else 'entries'}"


async def _account_names(session) -> dict[str, str]:
    rows = await session.execute(select(Account.id, Account.name))
    return {account_id: name for account_id, name in rows}


@router.get("", response_model=StickyPage)
async def list_entries(
    session: SessionDep,
    account_id: str | None = None,
    include_expired: bool = True,
    search: str | None = Query(default=None, max_length=64),
    limit: int = Query(default=25, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> StickyPage:
    runtime = await settings_service.load(session)
    names = await _account_names(session)
    now = datetime.now(UTC)
    everything = sticky.entries()

    counts: dict[str, int] = {}
    for _, owner, _ in everything:
        counts[owner] = counts.get(owner, 0) + 1

    term = (search or "").strip().lower()
    rows = [
        (key, owner, left)
        for key, owner, left in everything
        if (account_id is None or owner == account_id)
        and (include_expired or left > 0)
        and (not term or term in key)
    ]
    page = rows[offset : offset + limit]
    return StickyPage(
        entries=[
            StickyEntry(
                key=key,
                account_id=owner,
                account_name=names.get(owner),
                expires_at=now + timedelta(seconds=left),
                remaining_seconds=max(0, int(left)),
                expired=left <= 0,
            )
            for key, owner, left in page
        ],
        total=len(rows),
        limit=limit,
        offset=offset,
        has_more=offset + len(page) < len(rows),
        size=len(everything),
        expired_count=sum(1 for _, _, left in everything if left <= 0),
        capacity=sticky.capacity(),
        enabled=runtime.sticky_sessions_enabled,
        ttl_seconds=runtime.sticky_ttl_seconds,
        by_account=sorted(
            (
                StickyAccountCount(account_id=owner, account_name=names.get(owner), entries=n)
                for owner, n in counts.items()
            ),
            key=lambda c: (-c.entries, c.account_name or c.account_id),
        ),
    )


@router.post("/delete", response_model=DeletedCount)
async def delete_entries(payload: DeleteKeys, request: Request, session: SessionDep) -> DeletedCount:
    deleted = sticky.forget_many(payload.keys)
    await audit.record(
        session, action="sticky.deleted", detail=_entries(deleted), client_ip=client_ip(request)
    )
    return DeletedCount(deleted_count=deleted)


@router.post("/delete-account", response_model=DeletedCount)
async def delete_account_entries(
    payload: DeleteAccount, request: Request, session: SessionDep
) -> DeletedCount:
    deleted = sticky.forget_account(payload.account_id)
    names = await _account_names(session)
    await audit.record(
        session,
        action="sticky.account_cleared",
        target=names.get(payload.account_id, payload.account_id),
        detail=_entries(deleted),
        client_ip=client_ip(request),
    )
    return DeletedCount(deleted_count=deleted)


@router.post("/purge", response_model=DeletedCount)
async def purge_expired(request: Request, session: SessionDep) -> DeletedCount:
    deleted = sticky.purge_expired()
    await audit.record(
        session, action="sticky.purged", detail=_entries(deleted, "expired "), client_ip=client_ip(request)
    )
    return DeletedCount(deleted_count=deleted)


@router.delete("/{key}", status_code=204)
async def delete_entry(key: str, request: Request, session: SessionDep) -> None:
    if not sticky.forget_many([key]):
        raise HTTPException(404, "sticky session not found")
    await audit.record(session, action="sticky.deleted", detail=_entries(1), client_ip=client_ip(request))
