from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Query
from pydantic import BaseModel

from app.dependencies import SessionDep
from app.modules.audit import service
from app.modules.auth.dependencies import ManagementAuthDep

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


@router.get("", response_model=list[AuditEventOut])
async def list_events(
    session: SessionDep,
    _: ManagementAuthDep,
    limit: int = Query(default=100, ge=1, le=1000),
    action: str | None = None,
) -> list[AuditEventOut]:
    events = await service.recent(session, limit=limit, action=action)
    return [AuditEventOut.model_validate(e, from_attributes=True) for e in events]
