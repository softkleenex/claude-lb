from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.db.models import ApiKey
from app.dependencies import SessionDep
from app.modules.api_keys.service import create_api_key
from app.modules.audit import service as audit
from app.modules.auth.dependencies import client_ip

router = APIRouter(prefix="/api/keys", tags=["api-keys"])


class ApiKeyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    expires_at: datetime | None = None
    max_requests_per_window: int | None = Field(default=None, ge=1)
    max_tokens_per_window: int | None = Field(default=None, ge=1)
    max_cost_usd_per_window: float | None = Field(default=None, gt=0)
    window_seconds: int = Field(default=3600, ge=60)
    pinned_account_id: str | None = None


class ApiKeyOut(BaseModel):
    id: str
    name: str
    key_hint: str
    enabled: bool
    expires_at: datetime | None
    max_requests_per_window: int | None
    max_tokens_per_window: int | None
    max_cost_usd_per_window: float | None
    window_seconds: int
    pinned_account_id: str | None
    total_requests: int
    total_cost_usd: float
    last_used_at: datetime | None
    created_at: datetime

    @classmethod
    def of(cls, key: ApiKey) -> ApiKeyOut:
        return cls(**{field: getattr(key, field) for field in cls.model_fields})


class ApiKeyCreated(ApiKeyOut):
    api_key: str = Field(description="Shown once. Only a hash is stored.")


@router.get("", response_model=list[ApiKeyOut])
async def list_keys(session: SessionDep) -> list[ApiKeyOut]:
    result = await session.execute(select(ApiKey).order_by(ApiKey.name))
    return [ApiKeyOut.of(k) for k in result.scalars()]


@router.post("", response_model=ApiKeyCreated, status_code=201)
async def create_key(payload: ApiKeyCreate, request: Request, session: SessionDep) -> ApiKeyCreated:
    existing = await session.execute(select(ApiKey).where(ApiKey.name == payload.name))
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(409, f"a key named {payload.name!r} already exists")

    issued = await create_api_key(session, **payload.model_dump())
    await audit.record(
        session,
        action="api_key.created",
        target=issued.record.name,
        detail=f"hint …{issued.record.key_hint}",
        client_ip=client_ip(request),
    )
    return ApiKeyCreated(api_key=issued.plaintext, **ApiKeyOut.of(issued.record).model_dump())


@router.patch("/{key_id}", response_model=ApiKeyOut)
async def update_key(key_id: str, enabled: bool, request: Request, session: SessionDep) -> ApiKeyOut:
    key = await session.get(ApiKey, key_id)
    if key is None:
        raise HTTPException(404, "API key not found")
    key.enabled = enabled
    await session.flush()
    await audit.record(
        session,
        action="api_key.enabled" if enabled else "api_key.disabled",
        target=key.name,
        client_ip=client_ip(request),
    )
    return ApiKeyOut.of(key)


@router.delete("/{key_id}", status_code=204)
async def delete_key(key_id: str, request: Request, session: SessionDep) -> None:
    key = await session.get(ApiKey, key_id)
    if key is None:
        raise HTTPException(404, "API key not found")
    await audit.record(session, action="api_key.deleted", target=key.name, client_ip=client_ip(request))
    await session.delete(key)
