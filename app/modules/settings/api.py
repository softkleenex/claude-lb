from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.dependencies import SessionDep
from app.modules.proxy.load_balancer import STRATEGIES
from app.modules.settings import service
from app.modules.settings.service import RuntimeSettings

router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingsEnvelope(BaseModel):
    settings: RuntimeSettings
    available_strategies: list[str]


class SettingsPatch(BaseModel):
    """A partial update. Only the keys present are written."""

    model_config = {"extra": "forbid"}

    routing_strategy: str | None = None
    max_attempts: int | None = None
    sticky_sessions_enabled: bool | None = None
    sticky_ttl_seconds: int | None = None
    health_probe_enabled: bool | None = None
    health_probe_interval_seconds: int | None = None
    model_sync_enabled: bool | None = None
    model_sync_interval_seconds: int | None = None
    request_log_retention_days: int | None = None

    def changes(self) -> dict[str, Any]:
        return self.model_dump(exclude_none=True)


@router.get("", response_model=SettingsEnvelope)
async def read_settings(session: SessionDep) -> SettingsEnvelope:
    return SettingsEnvelope(
        settings=await service.load(session, use_cache=False),
        available_strategies=list(STRATEGIES),
    )


@router.patch("", response_model=SettingsEnvelope)
async def patch_settings(payload: SettingsPatch, session: SessionDep) -> SettingsEnvelope:
    changes = payload.changes()
    if not changes:
        raise HTTPException(400, "no settings supplied")
    try:
        settings = await service.update(session, changes)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return SettingsEnvelope(settings=settings, available_strategies=list(STRATEGIES))


@router.post("/reset", response_model=SettingsEnvelope)
async def reset_settings(session: SessionDep) -> SettingsEnvelope:
    """Discard every override and fall back to the environment defaults."""
    return SettingsEnvelope(
        settings=await service.reset(session),
        available_strategies=list(STRATEGIES),
    )
