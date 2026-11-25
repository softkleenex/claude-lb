"""Automations: send a small prompt through chosen accounts on a weekly schedule.

The main use is starting a subscription's 5-hour window at a time of your choosing —
e.g. weekdays at 07:00, so the window resets around noon instead of mid-afternoon.

How a slot fires:

1. Once a minute the scheduler looks at every enabled job. If the job's most recent
   slot is in the past, no older than `GRACE`, and not before the job was armed, it
   *plans a cycle*: one `AutomationRun` row per target account, each due at the slot
   plus a random offset within the job's spread. ``slot_key`` is unique, so a slot
   that was already planned — before a restart, or by another worker — is not planned
   again. That is the whole idempotency story.
2. Due runs are claimed with a conditional UPDATE (``pending`` → ``running``) and sent
   through `ProxyService.forward` pinned to their account, so they are logged like any
   request (user agent `USER_AGENT`), counted in spend, and update quota state.

A run whose account refuses the model, is paused (unless the job includes paused
accounts) or is disabled is *skipped* without a request. A run that could not be sent
within `GRACE` of its due time (the server was down) is skipped as missed.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import random
import time
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfoNotFoundError

import httpx
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from claude_lb import __version__
from claude_lb.core.pricing import estimate_cost_usd
from claude_lb.db.models import Account, AutomationJob, AutomationRun
from claude_lb.db.session import session_scope
from claude_lb.modules.automations import schedule as sched
from claude_lb.modules.proxy import load_balancer as lb
from claude_lb.modules.proxy import model_blocks
from claude_lb.modules.proxy.quota import as_aware
from claude_lb.modules.proxy.service import ProxyService, UpstreamExhausted, record_request
from claude_lb.modules.proxy.usage_parser import Usage

logger = logging.getLogger(__name__)

USER_AGENT = f"claude-lb-automation/{__version__}"
MAX_TOKENS_CAP = 1024
DEFAULT_MAX_TOKENS = 16
MAX_SPREAD_MINUTES = 120
MAX_PROMPT_CHARS = 2000
GRACE = timedelta(minutes=15)
"""A slot (or a run) later than this is skipped rather than sent late."""
STALE_RUNNING = timedelta(minutes=15)
MANUAL_COOLDOWN = timedelta(minutes=5)
"""No job runs more often than this, manual "Run now" included."""
CONCURRENCY = 4
TERMINAL = ("success", "failed", "skipped")
ERROR_MAX_CHARS = 512
"""`AutomationRun.error` is a VARCHAR(512); longer text is cut, never rejected."""


def clip_error(text: str | None) -> str | None:
    if text is None or len(text) <= ERROR_MAX_CHARS:
        return text
    return text[: ERROR_MAX_CHARS - 1] + "…"


def now_utc() -> datetime:
    return datetime.now(UTC)


def schedule_of(job: AutomationJob) -> sched.Schedule:
    return sched.Schedule(
        days=sched.parse_days(job.schedule_days), time=job.schedule_time, timezone=job.schedule_timezone
    )


def next_run_at(job: AutomationJob, now: datetime | None = None) -> datetime | None:
    if not job.enabled:
        return None
    try:
        return sched.next_slot(schedule_of(job), now or now_utc())
    except (sched.ScheduleError, ValueError, ZoneInfoNotFoundError):
        return None


# ---- targets & estimates ---------------------------------------------------


async def all_accounts(session: AsyncSession) -> list[Account]:
    result = await session.execute(select(Account).order_by(Account.name))
    return list(result.scalars())


def targets_of(job: AutomationJob, accounts: list[Account]) -> list[Account]:
    """The accounts a cycle sends to: the selected ones (in name order), or all."""
    ids = job.account_ids
    if not ids:
        return [a for a in accounts if not lb.is_paused(a) or job.include_paused_accounts]
    wanted = set(ids)
    return [a for a in accounts if a.id in wanted]


@dataclass
class Estimate:
    prompt_tokens: int
    per_request_usd: float
    """Upper bound for one request: the prompt plus ``max_tokens`` of output."""
    api_accounts: int
    subscription_accounts: int
    per_run_usd: float
    """Upper bound for one cycle across the API-key accounts (subscriptions are flat-rate)."""


def estimate(job: AutomationJob, targets: Iterable[Account]) -> Estimate:
    prompt_tokens = math.ceil(len(job.prompt or "") / 4) + 8
    per = estimate_cost_usd(job.model, input_tokens=prompt_tokens, output_tokens=job.max_tokens)
    targets = list(targets)
    api = sum(1 for a in targets if (a.plan_type or "api") == "api")
    return Estimate(
        prompt_tokens=prompt_tokens,
        per_request_usd=per,
        api_accounts=api,
        subscription_accounts=len(targets) - api,
        per_run_usd=per * api,
    )


# ---- planning ----------------------------------------------------------------


async def cycle_exists(session: AsyncSession, cycle_key: str) -> bool:
    result = await session.execute(
        select(AutomationRun.id).where(AutomationRun.cycle_key == cycle_key).limit(1)
    )
    return result.first() is not None


async def last_cycle_started(session: AsyncSession, job_id: str) -> datetime | None:
    result = await session.execute(
        select(AutomationRun.created_at)
        .where(AutomationRun.job_id == job_id)
        .order_by(AutomationRun.created_at.desc())
        .limit(1)
    )
    row = result.first()
    return as_aware(row[0]) if row else None


async def plan_cycle(
    session: AsyncSession,
    job: AutomationJob,
    *,
    cycle_key: str,
    trigger: str,
    base_time: datetime,
    rng: random.Random | None = None,
) -> list[AutomationRun]:
    """Insert one pending run per target account. Returns ``[]`` if the cycle already exists."""
    rng = rng or random.Random()
    if await cycle_exists(session, cycle_key):
        return []
    targets = targets_of(job, await all_accounts(session))
    spread = job.spread_minutes * 60 if trigger == "scheduled" else 0
    runs: list[AutomationRun] = []
    for account in targets:
        offset = timedelta(seconds=rng.uniform(0, spread)) if spread else timedelta(0)
        runs.append(
            AutomationRun(
                job_id=job.id,
                job_name=job.name,
                cycle_key=cycle_key,
                slot_key=f"{cycle_key}:{account.id}",
                trigger=trigger,
                status="pending",
                scheduled_for=base_time + offset,
                account_id=account.id,
                account_name=account.name,
                model=job.model,
            )
        )
    if not runs:
        runs.append(
            AutomationRun(
                job_id=job.id,
                job_name=job.name,
                cycle_key=cycle_key,
                slot_key=f"{cycle_key}:-",
                trigger=trigger,
                status="skipped",
                scheduled_for=base_time,
                finished_at=now_utc(),
                model=job.model,
                error="no target accounts (all deleted, or paused and paused accounts are excluded)",
            )
        )
    try:
        # A savepoint, so losing the race to another worker does not poison the session.
        async with session.begin_nested():
            session.add_all(runs)
            await session.flush()
    except IntegrityError:
        logger.info("automation cycle %s was already planned elsewhere", cycle_key)
        return []
    return runs


async def plan_due_cycles(session: AsyncSession, now: datetime, rng: random.Random | None = None) -> int:
    """Plan the cycle of every enabled job whose latest slot is due. Returns runs planned."""
    result = await session.execute(select(AutomationJob).where(AutomationJob.enabled.is_(True)))
    planned = 0
    for job in list(result.scalars()):
        # One broken job (an invalid schedule, a timezone the system no longer knows)
        # must not stop every other job from firing.
        try:
            planned += await _plan_job(session, job, now, rng)
        except Exception:
            logger.exception("automation %s could not be planned; skipping it this tick", job.name)
    return planned


async def _plan_job(
    session: AsyncSession, job: AutomationJob, now: datetime, rng: random.Random | None
) -> int:
    try:
        schedule = schedule_of(job)
        latest = sched.latest_slot(schedule, now)
    except (sched.ScheduleError, ValueError, ZoneInfoNotFoundError):
        logger.warning("automation %s has an invalid schedule; skipping", job.name)
        return 0
    if latest is None:
        return 0
    local_day, instant = latest
    if instant < (as_aware(job.armed_at) or instant) or now - instant > GRACE:
        return 0
    runs = await plan_cycle(
        session,
        job,
        cycle_key=sched.cycle_key(job.id, schedule, local_day),
        trigger="scheduled",
        base_time=instant,
        rng=rng,
    )
    if runs:
        logger.info("automation %s: planned %d run(s) for %s", job.name, len(runs), instant.isoformat())
    return len(runs)


async def cancel_pending(
    session: AsyncSession, job_id: str, reason: str, *, keep_account_ids: Iterable[str] | None = None
) -> int:
    """Skip a job's runs that are planned but not started, e.g. because the job was
    switched off or rescheduled. ``keep_account_ids`` spares the runs of those accounts
    (used when only the targets changed). Returns how many were cancelled."""
    conditions = [AutomationRun.job_id == job_id, AutomationRun.status == "pending"]
    if keep_account_ids is not None:
        keep = list(keep_account_ids)
        if keep:
            conditions.append((AutomationRun.account_id.is_(None)) | (AutomationRun.account_id.not_in(keep)))
    result = await session.execute(
        update(AutomationRun)
        .where(*conditions)
        .values(status="skipped", finished_at=now_utc(), error=clip_error(f"cancelled: {reason}"))
    )
    return result.rowcount or 0


# ---- execution ---------------------------------------------------------------


async def _finish(run_id: str, **values) -> None:
    values.setdefault("finished_at", now_utc())
    if "error" in values:
        values["error"] = clip_error(values["error"])
    async with session_scope() as session:
        await session.execute(update(AutomationRun).where(AutomationRun.id == run_id).values(**values))


async def claim(run_id: str) -> bool:
    async with session_scope() as session:
        result = await session.execute(
            update(AutomationRun)
            .where(AutomationRun.id == run_id, AutomationRun.status == "pending")
            .values(status="running", started_at=now_utc())
        )
        return (result.rowcount or 0) == 1


def _error_message(body: bytes | None, fallback: str) -> str:
    if body:
        try:
            message = json.loads(body).get("error", {}).get("message")
        except (ValueError, AttributeError):
            message = None
        if isinstance(message, str) and message:
            return message[:500]
    return fallback[:500]


async def execute_run(client: httpx.AsyncClient, run_id: str) -> str:
    """Send one claimed run. Returns its final status."""
    async with session_scope() as session:
        run = await session.get(AutomationRun, run_id)
        if run is None:
            return "missing"
        job = await session.get(AutomationJob, run.job_id)
        account = await session.get(Account, run.account_id) if run.account_id else None
        if job is None:
            await _finish(run_id, status="skipped", error="the automation was deleted")
            return "skipped"
        if account is None:
            await _finish(run_id, status="skipped", error="the account was deleted")
            return "skipped"
        # The job may have changed since this run was planned (a spread run can wait up
        # to two hours): re-check right before sending.
        if run.trigger == "scheduled" and not job.enabled:
            await _finish(run_id, status="skipped", error="cancelled: the automation was disabled")
            return "skipped"
        if job.account_ids and account.id not in job.account_ids:
            await _finish(run_id, status="skipped", error="cancelled: the account is no longer a target")
            return "skipped"
        paused = lb.is_paused(account)
        if paused and not job.include_paused_accounts:
            await _finish(run_id, status="skipped", error="account is paused")
            return "skipped"
        if not account.enabled and not paused:
            await _finish(
                run_id,
                status="skipped",
                error=f"account is disabled ({account.disabled_reason or 'breaker'})",
            )
            return "skipped"
        if model_blocks.is_blocked(account, job.model):
            await _finish(
                run_id, status="skipped", error=f"model refused: {account.name} does not serve {job.model}"
            )
            return "skipped"
        if lb.spend_cap_reached(account):
            await _finish(
                run_id,
                status="skipped",
                error=f"account reached its spend cap (${account.spend_cap_usd:.2f})",
            )
            return "skipped"
        account_id, model = account.id, job.model
        body = json.dumps(
            {
                "model": job.model,
                "max_tokens": min(max(job.max_tokens, 1), MAX_TOKENS_CAP),
                "messages": [{"role": "user", "content": job.prompt}],
            }
        ).encode()

    perf_started = time.perf_counter()
    meta = {"session_key": None, "user_agent": USER_AGENT, "client_ip": None}
    try:
        outcome = await ProxyService(client).forward(
            method="POST",
            path="/v1/messages",
            query="",
            headers={
                "user-agent": USER_AGENT,
                "content-type": "application/json",
                "anthropic-version": "2023-06-01",
            },
            body=body,
            api_key=None,
            pin_account_id=account_id,
            force_account=paused,
        )
    except UpstreamExhausted as exc:
        duration = int((time.perf_counter() - perf_started) * 1000)
        await record_request(
            account_id=account_id,
            api_key_id=None,
            path="/v1/messages",
            model=model,
            status_code=exc.status_code,
            streaming=False,
            started_at=perf_started,
            attempts=0,
            usage=Usage(),
            error=f"automation: {exc}",
            **meta,
        )
        async with session_scope() as session:
            fresh = await session.get(Account, account_id)
            refused = fresh is not None and model_blocks.is_blocked(fresh, model)
        if refused:
            await _finish(
                run_id,
                status="skipped",
                http_status=exc.status_code,
                duration_ms=duration,
                error=f"model refused: the subscription does not serve {model}",
            )
            return "skipped"
        await _finish(
            run_id,
            status="failed",
            http_status=exc.status_code,
            duration_ms=duration,
            error=_error_message(exc.last_body, str(exc)),
        )
        return "failed"
    except Exception as exc:  # noqa: BLE001 - a run must always end in a terminal state
        logger.exception("automation run %s crashed", run_id)
        await _finish(run_id, status="failed", error=f"{type(exc).__name__}: {exc}")
        return "failed"

    duration = int((time.perf_counter() - perf_started) * 1000)
    usage = outcome.usage
    ok = outcome.status_code < 400
    await record_request(
        account_id=outcome.account.id,
        api_key_id=None,
        path="/v1/messages",
        model=model,
        status_code=outcome.status_code,
        streaming=False,
        started_at=perf_started,
        attempts=outcome.attempts,
        usage=usage,
        error=None if ok else _error_message(outcome.body, f"upstream returned {outcome.status_code}"),
        **meta,
    )
    status = "success" if ok else "failed"
    await _finish(
        run_id,
        status=status,
        http_status=outcome.status_code,
        input_tokens=usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens,
        output_tokens=usage.output_tokens,
        cost_usd=estimate_cost_usd(usage.model or model, **usage.cost_inputs()),
        duration_ms=duration,
        error=None if ok else _error_message(outcome.body, f"upstream returned {outcome.status_code}"),
    )
    return status


async def run_claimed(client: httpx.AsyncClient, run_ids: list[str]) -> None:
    """Claim and send runs, a few at a time."""
    semaphore = asyncio.Semaphore(CONCURRENCY)

    async def one(run_id: str) -> None:
        async with semaphore:
            if not await claim(run_id):
                return
            try:
                await execute_run(client, run_id)
            except Exception as exc:  # noqa: BLE001 - one run must not sink the others
                logger.exception("automation run %s crashed", run_id)
                await _finish(run_id, status="failed", error=f"{type(exc).__name__}: {exc}")

    await asyncio.gather(*(one(r) for r in run_ids))


async def tick(
    client: httpx.AsyncClient, now: datetime | None = None, rng: random.Random | None = None
) -> int:
    """One scheduler pass: expire stale work, plan due cycles, send due runs."""
    now = now or now_utc()
    async with session_scope() as session:
        await session.execute(
            update(AutomationRun)
            .where(AutomationRun.status == "running", AutomationRun.started_at < now - STALE_RUNNING)
            .values(status="failed", finished_at=now, error="interrupted (the server stopped mid-run)")
        )
        await session.execute(
            update(AutomationRun)
            .where(AutomationRun.status == "pending", AutomationRun.scheduled_for < now - GRACE)
            .values(
                status="skipped", finished_at=now, error="missed (the server was not running at the due time)"
            )
        )
        await plan_due_cycles(session, now, rng)
    async with session_scope() as session:
        result = await session.execute(
            select(AutomationRun.id)
            .where(AutomationRun.status == "pending", AutomationRun.scheduled_for <= now)
            .order_by(AutomationRun.scheduled_for)
        )
        due = [row[0] for row in result]
    if due:
        await run_claimed(client, due)
    return len(due)


# ---- manual runs -------------------------------------------------------------

_background: set[asyncio.Task] = set()


def spawn(client: httpx.AsyncClient, run_ids: list[str]) -> asyncio.Task:
    task = asyncio.get_running_loop().create_task(run_claimed(client, run_ids))
    _background.add(task)
    task.add_done_callback(_background.discard)
    return task


async def wait_background() -> None:
    """Tests and shutdown: let manual runs finish."""
    while _background:
        await asyncio.gather(*list(_background), return_exceptions=True)
