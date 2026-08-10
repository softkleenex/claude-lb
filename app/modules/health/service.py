"""Background health probes and model-catalog sync.

Without this, an account disabled by a transient 401 — a key rotated upstream, a
momentary auth blip — stays disabled until someone notices and clicks Enable. The
probe re-checks disabled and cooling-down accounts against a cheap endpoint and
returns them to rotation on its own.

`GET /v1/models` is the probe: it is authenticated, has no token cost, and its body
doubles as the account's model catalog.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime

import httpx
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.crypto import decrypt
from app.db.models import Account, ModelCatalogEntry
from app.db.session import session_scope
from app.modules.proxy import load_balancer as lb
from app.modules.settings import service as settings_service

logger = logging.getLogger(__name__)

PROBE_PATH = "/v1/models"
PROBE_TIMEOUT_SECONDS = 20.0
# Probes run for their side effects; never let one wedge the scheduler.
MAX_CONCURRENT_PROBES = 4


@dataclass
class ProbeResult:
    account_id: str
    account_name: str
    ok: bool
    status_code: int | None
    detail: str
    models: list[dict]


async def probe_account(
    client: httpx.AsyncClient, account: Account, *, base_url: str, credential: str
) -> ProbeResult:
    url = f"{base_url.rstrip('/')}{PROBE_PATH}?limit=100"
    headers = {"x-api-key": credential, "anthropic-version": "2023-06-01"}
    try:
        response = await client.get(url, headers=headers, timeout=PROBE_TIMEOUT_SECONDS)
    except httpx.HTTPError as exc:
        return ProbeResult(account.id, account.name, False, None, f"{type(exc).__name__}: {exc}", [])

    if response.status_code != 200:
        return ProbeResult(
            account.id,
            account.name,
            False,
            response.status_code,
            f"upstream returned {response.status_code}",
            [],
        )

    models: list[dict] = []
    try:
        payload = response.json()
        if isinstance(payload, dict) and isinstance(payload.get("data"), list):
            models = [m for m in payload["data"] if isinstance(m, dict) and m.get("id")]
    except ValueError:
        # A 200 with an unreadable body still proves the credential works.
        pass

    return ProbeResult(account.id, account.name, True, 200, "ok", models)


def _needs_probe(account: Account, *, now: datetime) -> bool:
    """Probe accounts the balancer currently refuses to use.

    Healthy accounts are left alone: real traffic already tells us they work, and
    probing them would just add requests.
    """
    if not account.enabled:
        return True
    cooldown = account.cooldown_until
    if cooldown is not None:
        if cooldown.tzinfo is None:
            cooldown = cooldown.replace(tzinfo=UTC)
        # Only once the cooldown has elapsed — probing mid-cooldown would waste a
        # request against a rate limit we already know about.
        return cooldown <= now
    return account.consecutive_failures > 0


async def run_health_probes(client: httpx.AsyncClient) -> list[ProbeResult]:
    """Probe every unhealthy account once and fold the result back into its row."""
    env = get_settings()
    now = datetime.now(UTC)

    async with session_scope() as session:
        result = await session.execute(select(Account))
        candidates = [
            (a.id, a.name, decrypt(a.encrypted_credential), (a.base_url or env.upstream_base_url), a)
            for a in result.scalars()
            if _needs_probe(a, now=now)
        ]
        # Detach: the probe itself runs outside the transaction.
        targets = [(cid, name, cred, url) for cid, name, cred, url, _ in candidates]
        for *_, account in candidates:
            session.expunge(account)

    if not targets:
        return []

    semaphore = asyncio.Semaphore(MAX_CONCURRENT_PROBES)

    async def _one(account_id: str, name: str, credential: str, base_url: str) -> ProbeResult:
        async with semaphore:
            stub = Account(id=account_id, name=name)
            return await probe_account(client, stub, base_url=base_url, credential=credential)

    results = await asyncio.gather(*(_one(*t) for t in targets), return_exceptions=True)

    probes: list[ProbeResult] = []
    async with session_scope() as session:
        for target, outcome in zip(targets, results, strict=True):
            account_id, name = target[0], target[1]
            if isinstance(outcome, BaseException):
                outcome = ProbeResult(account_id, name, False, None, str(outcome), [])
            probes.append(outcome)

            account = await session.get(Account, account_id)
            if account is None:
                continue
            account.last_probe_at = datetime.now(UTC)
            account.last_probe_ok = outcome.ok
            account.last_probe_detail = outcome.detail[:255]

            if outcome.ok:
                was_down = not account.enabled or account.consecutive_failures
                account.enabled = True
                lb.record_success(account)
                if was_down:
                    logger.info("account %s recovered and is back in rotation", name)
            elif outcome.status_code in (401, 403):
                # Still rejected: leave it disabled, but keep the reason current.
                account.enabled = False
                account.disabled_reason = outcome.detail[:255]

    return probes


async def sync_model_catalog(client: httpx.AsyncClient) -> dict[str, int]:
    """Refresh each enabled account's model list from upstream."""
    env = get_settings()

    async with session_scope() as session:
        result = await session.execute(select(Account).where(Account.enabled.is_(True)))
        targets = [
            (a.id, a.name, decrypt(a.encrypted_credential), (a.base_url or env.upstream_base_url))
            for a in result.scalars()
        ]

    if not targets:
        return {}

    semaphore = asyncio.Semaphore(MAX_CONCURRENT_PROBES)

    async def _one(account_id: str, name: str, credential: str, base_url: str) -> ProbeResult:
        async with semaphore:
            stub = Account(id=account_id, name=name)
            return await probe_account(client, stub, base_url=base_url, credential=credential)

    results = await asyncio.gather(*(_one(*t) for t in targets), return_exceptions=True)

    counts: dict[str, int] = {}
    async with session_scope() as session:
        for target, outcome in zip(targets, results, strict=True):
            if isinstance(outcome, BaseException) or not outcome.ok:
                continue
            account_id = target[0]
            # Replace wholesale: a model the org lost access to must disappear.
            await session.execute(delete(ModelCatalogEntry).where(ModelCatalogEntry.account_id == account_id))
            for model in outcome.models:
                session.add(
                    ModelCatalogEntry(
                        account_id=account_id,
                        model_id=str(model["id"])[:128],
                        display_name=str(model.get("display_name", ""))[:128],
                        max_input_tokens=_int_or_none(model.get("max_input_tokens")),
                        max_output_tokens=_int_or_none(model.get("max_tokens")),
                    )
                )
            account = await session.get(Account, account_id)
            if account is not None:
                account.models_synced_at = datetime.now(UTC)
            counts[target[1]] = len(outcome.models)

    return counts


def _int_or_none(value) -> int | None:
    return value if isinstance(value, int) else None


async def accounts_supporting(session: AsyncSession, model: str) -> set[str] | None:
    """Account ids known to serve ``model``, or ``None`` if the catalog can't answer.

    Returning ``None`` rather than an empty set matters: an unsynced catalog must not
    be read as "no account supports this" and blackhole every request.
    """
    if not model:
        return None
    total = await session.execute(select(ModelCatalogEntry.account_id).limit(1))
    if total.first() is None:
        return None
    result = await session.execute(
        select(ModelCatalogEntry.account_id).where(ModelCatalogEntry.model_id == model)
    )
    supported = set(result.scalars())
    return supported or None


class Scheduler:
    """Runs the probe and sync loops for the lifetime of the app."""

    def __init__(self, client: httpx.AsyncClient) -> None:
        self._client = client
        self._tasks: list[asyncio.Task] = []
        self._stopping = asyncio.Event()

    def start(self) -> None:
        self._tasks = [
            asyncio.create_task(self._loop("health probe", self._probe_tick), name="clb-health"),
            asyncio.create_task(self._loop("model sync", self._sync_tick), name="clb-model-sync"),
        ]

    async def stop(self) -> None:
        self._stopping.set()
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: B014 - shutdown is best-effort
                pass
        self._tasks.clear()

    async def _loop(self, label: str, tick) -> None:
        # Stagger the first run so startup isn't a thundering herd of upstream calls.
        await self._sleep(5)
        while not self._stopping.is_set():
            try:
                interval = await tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                # A scheduler that dies on one bad tick is worse than a noisy log.
                logger.exception("%s tick failed", label)
                interval = 60
            await self._sleep(interval)

    async def _sleep(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self._stopping.wait(), timeout=seconds)
        except TimeoutError:
            pass

    async def _probe_tick(self) -> int:
        async with session_scope() as session:
            runtime = await settings_service.load(session, use_cache=False)
        if not runtime.health_probe_enabled:
            return runtime.health_probe_interval_seconds
        results = await run_health_probes(self._client)
        recovered = [r.account_name for r in results if r.ok]
        if recovered:
            logger.info("health probe returned %d account(s) to rotation", len(recovered))
        return runtime.health_probe_interval_seconds

    async def _sync_tick(self) -> int:
        async with session_scope() as session:
            runtime = await settings_service.load(session, use_cache=False)
        if not runtime.model_sync_enabled:
            return runtime.model_sync_interval_seconds
        counts = await sync_model_catalog(self._client)
        if counts:
            logger.info("model catalog synced: %s", counts)
        return runtime.model_sync_interval_seconds
