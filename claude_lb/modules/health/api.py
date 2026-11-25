from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Request
from pydantic import BaseModel
from sqlalchemy import func, select

from claude_lb.core import pricing
from claude_lb.db.models import Account, ModelCatalogEntry
from claude_lb.dependencies import ProxyServiceDep, SessionDep
from claude_lb.modules.audit import service as audit
from claude_lb.modules.auth.dependencies import ManagementAuthDep, client_ip
from claude_lb.modules.health import service
from claude_lb.modules.proxy import model_blocks
from claude_lb.modules.proxy.load_balancer import is_paused

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
async def probe_now(
    request: Request, proxy: ProxyServiceDep, session: SessionDep, _: ManagementAuthDep
) -> list[ProbeOut]:
    """Run the health probe immediately instead of waiting for the next tick."""
    results = await service.run_health_probes(proxy._client)  # noqa: SLF001 - same app
    await audit.record(
        session, action="health.probe", detail=f"{len(results)} account(s)", client_ip=client_ip(request)
    )
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
    request: Request, proxy: ProxyServiceDep, session: SessionDep, _: ManagementAuthDep
) -> dict[str, int]:
    counts = await service.sync_model_catalog(proxy._client)  # noqa: SLF001 - same app
    await audit.record(
        session, action="health.model_sync", detail=f"{len(counts)} account(s)", client_ip=client_ip(request)
    )
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


# ---------------------------------------------------------------- catalog page


class PriceOut(BaseModel):
    """USD per million tokens."""

    input: float
    output: float
    cache_read: float
    cache_write_5m: float
    cache_write_1h: float
    long_context_threshold: int | None = None
    long_context: PriceOut | None = None


class ServingAccount(BaseModel):
    id: str
    name: str


class CatalogEntryOut(BaseModel):
    model_id: str
    display_name: str
    accounts: list[ServingAccount]
    max_input_tokens: int | None
    max_output_tokens: int | None
    synced_at: datetime | None
    price: PriceOut | None
    price_key: str | None


class PriceTableRow(BaseModel):
    model: str
    price: PriceOut


class ModelBlockOut(BaseModel):
    account_id: str
    account_name: str
    plan_type: str
    model: str
    until: datetime


class CatalogAccountOut(BaseModel):
    id: str
    name: str
    plan_type: str
    enabled: bool
    paused: bool
    models: int
    models_synced_at: datetime | None


class CatalogOut(BaseModel):
    models: list[CatalogEntryOut]
    prices: list[PriceTableRow]
    blocks: list[ModelBlockOut]
    accounts: list[CatalogAccountOut]
    last_synced_at: datetime | None


def _price_out(price: pricing.ModelPrice) -> PriceOut:
    return PriceOut(
        input=price.input_per_mtok,
        output=price.output_per_mtok,
        cache_read=price.cache_read_rate,
        cache_write_5m=price.input_per_mtok * pricing.CACHE_WRITE_5M_MULTIPLIER,
        cache_write_1h=price.input_per_mtok * pricing.CACHE_WRITE_1H_MULTIPLIER,
        long_context_threshold=price.long_context_threshold,
        long_context=_price_out(price.long_context) if price.long_context is not None else None,
    )


def _price_key(model: str) -> str | None:
    """The PRICES entry a model id resolves to — same rule as ``pricing.lookup``."""
    normalized = pricing._normalize(model)  # noqa: SLF001 - same package family
    if normalized in pricing.PRICES:
        return normalized
    keys = [key for key in pricing.PRICES if normalized.startswith(key)]
    return max(keys, key=len) if keys else None


@router.get("/catalog", response_model=CatalogOut)
async def catalog(session: SessionDep, _: ManagementAuthDep) -> CatalogOut:
    """Everything the model catalog page shows, in one call.

    Models come from the upstream sync (one row per account that can reach them); prices
    from the built-in table; refusals from what live traffic taught each subscription.
    """
    accounts = list((await session.execute(select(Account).order_by(Account.name))).scalars())
    names = {a.id: a.name for a in accounts}

    rows = (await session.execute(select(ModelCatalogEntry).order_by(ModelCatalogEntry.model_id))).scalars()
    grouped: dict[str, list[ModelCatalogEntry]] = {}
    for row in rows:
        grouped.setdefault(row.model_id, []).append(row)

    per_account: dict[str, int] = {}
    models: list[CatalogEntryOut] = []
    for model_id, entries in grouped.items():
        for entry in entries:
            per_account[entry.account_id] = per_account.get(entry.account_id, 0) + 1
        inputs = [e.max_input_tokens for e in entries if e.max_input_tokens is not None]
        outputs = [e.max_output_tokens for e in entries if e.max_output_tokens is not None]
        synced = [e.synced_at for e in entries if e.synced_at is not None]
        price_key = _price_key(model_id)
        models.append(
            CatalogEntryOut(
                model_id=model_id,
                display_name=next((e.display_name for e in entries if e.display_name), ""),
                accounts=sorted(
                    (
                        ServingAccount(id=e.account_id, name=names.get(e.account_id, e.account_id))
                        for e in entries
                    ),
                    key=lambda a: a.name,
                ),
                max_input_tokens=max(inputs) if inputs else None,
                max_output_tokens=max(outputs) if outputs else None,
                synced_at=max(synced) if synced else None,
                price=_price_out(pricing.PRICES[price_key]) if price_key else None,
                price_key=price_key,
            )
        )

    blocks = [
        ModelBlockOut(
            account_id=a.id,
            account_name=a.name,
            plan_type=a.plan_type or "api",
            model=model,
            until=datetime.fromtimestamp(until, UTC),
        )
        for a in accounts
        for model, until in model_blocks.active_block_expiries(a)
    ]
    synced_times = [a.models_synced_at for a in accounts if a.models_synced_at is not None]
    return CatalogOut(
        models=models,
        prices=[PriceTableRow(model=key, price=_price_out(price)) for key, price in pricing.PRICES.items()],
        blocks=blocks,
        accounts=[
            CatalogAccountOut(
                id=a.id,
                name=a.name,
                plan_type=a.plan_type or "api",
                enabled=a.enabled,
                paused=is_paused(a),
                models=per_account.get(a.id, 0),
                models_synced_at=a.models_synced_at,
            )
            for a in accounts
        ],
        last_synced_at=max(synced_times) if synced_times else None,
    )
