"""Append-only log of management-plane changes.

Records the *fact* of a change, never the secret involved: an account's credential,
an issued proxy key, and the dashboard password are all excluded by construction —
only names, ids, and hints reach `detail`.
"""

from __future__ import annotations

import logging

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AuditEvent

logger = logging.getLogger(__name__)

MAX_DETAIL = 512


async def record(
    session: AsyncSession,
    *,
    action: str,
    target: str = "",
    detail: str = "",
    actor: str = "dashboard",
    client_ip: str = "",
    ok: bool = True,
) -> None:
    session.add(
        AuditEvent(
            action=action[:64],
            target=target[:128],
            detail=detail[:MAX_DETAIL],
            actor=actor[:64],
            client_ip=client_ip[:64],
            ok=ok,
        )
    )
    if not ok:
        logger.warning("audit: %s failed (%s) from %s", action, detail, client_ip or "unknown")


async def record_and_commit(session: AsyncSession, **kwargs) -> None:
    """Write an audit event and commit it immediately.

    Failure paths end in an exception, which rolls the request's transaction back —
    taking the audit row with it. A rejected sign-in is exactly the event you most want
    durable, so commit before raising.

    This commits on the request's own session rather than opening a second one: SQLite
    serializes writers, so a nested write transaction would block on the lock this
    request already holds until the busy timeout expires.
    """
    await record(session, **kwargs)
    await session.commit()


async def recent(session: AsyncSession, *, limit: int = 100, action: str | None = None):
    stmt = select(AuditEvent).order_by(AuditEvent.created_at.desc()).limit(limit)
    if action:
        stmt = stmt.where(AuditEvent.action == action)
    result = await session.execute(stmt)
    return list(result.scalars())


async def prune(session: AsyncSession, *, keep: int = 5000) -> int:
    """Trim the oldest rows so an unattended instance cannot grow the table forever."""
    ids = (
        await session.execute(select(AuditEvent.id).order_by(AuditEvent.created_at.desc()).limit(keep))
    ).scalars()
    keep_ids = set(ids)
    if not keep_ids:
        return 0
    result = await session.execute(delete(AuditEvent).where(AuditEvent.id.notin_(keep_ids)))
    return result.rowcount or 0
