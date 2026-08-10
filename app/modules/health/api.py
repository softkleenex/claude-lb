from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import func, select

from app.db.models import ModelCatalogEntry
from app.dependencies import ProxyServiceDep, SessionDep
from app.modules.audit import service as audit
from app.modules.auth.dependencies import ManagementAuthDep
from app.modules.health import service

router = APIRouter(prefix="/api/health", tags=["health"])


class ProbeOut(BaseModel):
    account_id: str
    account_name: str
    ok: bool
    status_code: int | None
    detail: str
    models: int


class CatalogModel(BaseModel):
    model_id: str
    display_name: str
    accounts: int
    max_input_tokens: int | None
    max_output_tokens: int | None
    synced_at: datetime | None


@router.post("/probe", response_model=list[ProbeOut])
async def probe_now(proxy: ProxyServiceDep, session: SessionDep, _: ManagementAuthDep) -> list[ProbeOut]:
    """Run the health probe immediately instead of waiting for the next tick."""
    results = await service.run_health_probes(proxy._client)  # noqa: SLF001 - same app
    await audit.record(session, action="health.probe", detail=f"{len(results)} account(s)")
    return [
        ProbeOut(
            account_id=r.account_id,
            account_name=r.account_name,
            ok=r.ok,
            status_code=r.status_code,
            detail=r.detail,
            models=len(r.models),
        )
        for r in results
    ]


@router.post("/sync-models", response_model=dict[str, int])
async def sync_models_now(
    proxy: ProxyServiceDep, session: SessionDep, _: ManagementAuthDep
) -> dict[str, int]:
    counts = await service.sync_model_catalog(proxy._client)  # noqa: SLF001 - same app
    await audit.record(session, action="health.model_sync", detail=f"{len(counts)} account(s)")
    return counts


@router.get("/models", response_model=list[CatalogModel])
async def list_models(session: SessionDep, _: ManagementAuthDep) -> list[CatalogModel]:
    """The union of every account's catalog, with how many accounts serve each model."""
    result = await session.execute(
        select(
            ModelCatalogEntry.model_id,
            func.max(ModelCatalogEntry.display_name),
            func.count(ModelCatalogEntry.account_id),
            func.max(ModelCatalogEntry.max_input_tokens),
            func.max(ModelCatalogEntry.max_output_tokens),
            func.max(ModelCatalogEntry.synced_at),
        )
        .group_by(ModelCatalogEntry.model_id)
        .order_by(ModelCatalogEntry.model_id)
    )
    return [
        CatalogModel(
            model_id=row[0],
            display_name=row[1] or "",
            accounts=row[2],
            max_input_tokens=row[3],
            max_output_tokens=row[4],
            synced_at=row[5],
        )
        for row in result
    ]
