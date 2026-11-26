"""Management API for automations (see `automations.service`)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, select

from claude_lb.db.models import Account, AutomationJob, AutomationRun
from claude_lb.dependencies import SessionDep
from claude_lb.modules.audit import service as audit
from claude_lb.modules.auth.dependencies import client_ip
from claude_lb.modules.automations import schedule as sched
from claude_lb.modules.automations import service

router = APIRouter(prefix="/api/automations", tags=["automations"])


class ScheduleIn(BaseModel):
    days: list[str] = Field(default_factory=lambda: list(sched.WEEKDAYS))
    time: str
    timezone: str = "UTC"
    spread_minutes: int = Field(default=0, ge=0, le=service.MAX_SPREAD_MINUTES)


class ScheduleOut(BaseModel):
    days: list[str]
    time: str
    timezone: str
    spread_minutes: int


def _clean_ids(value: list[str] | None) -> list[str] | None:
    if value is None:
        return None
    seen: list[str] = []
    for item in value:
        item = item.strip()
        if item and item not in seen:
            seen.append(item)
    return seen


class JobIn(BaseModel):
    model_config = {"extra": "forbid"}

    name: str = Field(min_length=1, max_length=128)
    enabled: bool = True
    schedule: ScheduleIn
    model: str = Field(min_length=1, max_length=128)
    prompt: str = Field(default="ping", min_length=1, max_length=service.MAX_PROMPT_CHARS)
    max_tokens: int = Field(default=service.DEFAULT_MAX_TOKENS, ge=1, le=service.MAX_TOKENS_CAP)
    account_ids: list[str] = Field(default_factory=list, max_length=256)
    include_paused_accounts: bool = False

    @field_validator("account_ids")
    @classmethod
    def _dedupe(cls, value: list[str]) -> list[str]:
        return _clean_ids(value) or []


class JobPatch(BaseModel):
    model_config = {"extra": "forbid"}

    name: str | None = Field(default=None, min_length=1, max_length=128)
    enabled: bool | None = None
    schedule: ScheduleIn | None = None
    model: str | None = Field(default=None, min_length=1, max_length=128)
    prompt: str | None = Field(default=None, min_length=1, max_length=service.MAX_PROMPT_CHARS)
    max_tokens: int | None = Field(default=None, ge=1, le=service.MAX_TOKENS_CAP)
    account_ids: list[str] | None = Field(default=None, max_length=256)
    include_paused_accounts: bool | None = None

    @field_validator("account_ids")
    @classmethod
    def _dedupe(cls, value: list[str] | None) -> list[str] | None:
        return _clean_ids(value)


class TargetOut(BaseModel):
    id: str
    name: str
    plan_type: str
    paused: bool


class EstimateOut(BaseModel):
    prompt_tokens: int
    per_request_usd: float
    api_accounts: int
    subscription_accounts: int
    per_run_usd: float


class RunOut(BaseModel):
    id: str
    job_id: str
    job_name: str
    cycle_key: str
    trigger: str
    status: str
    scheduled_for: datetime
    started_at: datetime | None
    finished_at: datetime | None
    account_id: str | None
    account_name: str
    model: str
    http_status: int | None
    input_tokens: int
    output_tokens: int
    cost_usd: float
    duration_ms: int | None
    error: str | None


class CycleOut(BaseModel):
    cycle_key: str
    job_id: str
    job_name: str
    trigger: str
    status: str
    """pending | running | success | partial | failed | skipped"""
    scheduled_for: datetime
    finished_at: datetime | None
    total: int
    succeeded: int
    failed: int
    skipped: int
    pending: int
    input_tokens: int
    output_tokens: int
    cost_usd: float
    runs: list[RunOut]


class JobOut(BaseModel):
    id: str
    name: str
    enabled: bool
    schedule: ScheduleOut
    model: str
    prompt: str
    max_tokens: int
    account_ids: list[str]
    include_paused_accounts: bool
    targets: list[TargetOut]
    """The accounts the next cycle would send to."""
    missing_account_ids: list[str]
    """Selected accounts that no longer exist."""
    next_run_at: datetime | None
    last_cycle: CycleOut | None
    estimate: EstimateOut
    created_at: datetime
    updated_at: datetime


class JobsOut(BaseModel):
    jobs: list[JobOut]
    total: int
    max_tokens_cap: int
    max_spread_minutes: int
    min_interval_minutes: int


class CyclesOut(BaseModel):
    cycles: list[CycleOut]
    total: int
    limit: int
    offset: int
    has_more: bool


class RunNowOut(BaseModel):
    cycle_key: str
    runs: int


def _run_out(run: AutomationRun) -> RunOut:
    return RunOut.model_validate(run, from_attributes=True)


def _cycle_status(runs: list[AutomationRun]) -> str:
    statuses = [r.status for r in runs]
    if any(s == "running" for s in statuses):
        return "running"
    if any(s == "pending" for s in statuses):
        return "running" if any(s in service.TERMINAL for s in statuses) else "pending"
    ok = statuses.count("success")
    failed = statuses.count("failed")
    if ok and (failed or statuses.count("skipped")):
        return "partial"
    if ok:
        return "success"
    if failed:
        return "failed"
    return "skipped"


def _cycle_out(runs: list[AutomationRun]) -> CycleOut:
    first = min(runs, key=lambda r: r.scheduled_for)
    finished = [r.finished_at for r in runs if r.finished_at is not None]
    terminal = all(r.status in service.TERMINAL for r in runs)
    return CycleOut(
        cycle_key=first.cycle_key,
        job_id=first.job_id,
        job_name=first.job_name,
        trigger=first.trigger,
        status=_cycle_status(runs),
        scheduled_for=first.scheduled_for,
        finished_at=max(finished) if finished and terminal else None,
        total=len(runs),
        succeeded=sum(1 for r in runs if r.status == "success"),
        failed=sum(1 for r in runs if r.status == "failed"),
        skipped=sum(1 for r in runs if r.status == "skipped"),
        pending=sum(1 for r in runs if r.status in ("pending", "running")),
        input_tokens=sum(r.input_tokens for r in runs),
        output_tokens=sum(r.output_tokens for r in runs),
        cost_usd=sum(r.cost_usd for r in runs),
        runs=[_run_out(r) for r in sorted(runs, key=lambda r: (r.account_name, r.scheduled_for))],
    )


async def _load_cycles(session, cycle_keys: list[str]) -> dict[str, CycleOut]:
    if not cycle_keys:
        return {}
    result = await session.execute(select(AutomationRun).where(AutomationRun.cycle_key.in_(cycle_keys)))
    grouped: dict[str, list[AutomationRun]] = {}
    for run in result.scalars():
        grouped.setdefault(run.cycle_key, []).append(run)
    return {key: _cycle_out(runs) for key, runs in grouped.items()}


async def _last_cycle_keys(session, job_ids: list[str]) -> dict[str, str]:
    if not job_ids:
        return {}
    latest = (
        select(AutomationRun.job_id, func.max(AutomationRun.created_at).label("at"))
        .where(AutomationRun.job_id.in_(job_ids))
        .group_by(AutomationRun.job_id)
        .subquery()
    )
    result = await session.execute(
        select(AutomationRun.job_id, AutomationRun.cycle_key).join(
            latest, (AutomationRun.job_id == latest.c.job_id) & (AutomationRun.created_at == latest.c.at)
        )
    )
    return {job_id: key for job_id, key in result}


def _job_out(job: AutomationJob, accounts: list[Account], last: CycleOut | None) -> JobOut:
    from claude_lb.modules.proxy import load_balancer as lb

    targets = service.targets_of(job, accounts)
    known = {a.id for a in accounts}
    est = service.estimate(job, targets)
    return JobOut(
        id=job.id,
        name=job.name,
        enabled=job.enabled,
        schedule=ScheduleOut(
            days=list(sched.parse_days(job.schedule_days)),
            time=job.schedule_time,
            timezone=job.schedule_timezone,
            spread_minutes=job.spread_minutes,
        ),
        model=job.model,
        prompt=job.prompt,
        max_tokens=job.max_tokens,
        account_ids=job.account_ids,
        include_paused_accounts=job.include_paused_accounts,
        targets=[
            TargetOut(id=a.id, name=a.name, plan_type=a.plan_type or "api", paused=lb.is_paused(a))
            for a in targets
        ],
        missing_account_ids=[i for i in job.account_ids if i not in known],
        next_run_at=service.next_run_at(job),
        last_cycle=last,
        estimate=EstimateOut(**est.__dict__),
        created_at=job.created_at,
        updated_at=job.updated_at,
    )


async def _jobs_out(session, jobs: list[AutomationJob]) -> list[JobOut]:
    accounts = await service.all_accounts(session)
    last_keys = await _last_cycle_keys(session, [j.id for j in jobs])
    cycles = await _load_cycles(session, list(set(last_keys.values())))
    return [_job_out(j, accounts, cycles.get(last_keys.get(j.id, ""))) for j in jobs]


def _validated_schedule(schedule: ScheduleIn) -> sched.Schedule:
    try:
        return sched.validate(schedule.days, schedule.time, schedule.timezone)
    except sched.ScheduleError as exc:
        raise HTTPException(422, str(exc)) from exc


async def _check_accounts(session, ids: list[str]) -> None:
    if not ids:
        return
    result = await session.execute(select(Account.id).where(Account.id.in_(ids)))
    found = {row[0] for row in result}
    unknown = [i for i in ids if i not in found]
    if unknown:
        raise HTTPException(422, f"unknown account id(s): {', '.join(unknown)}")


async def _get_job(session, job_id: str) -> AutomationJob:
    job = await session.get(AutomationJob, job_id)
    if job is None:
        raise HTTPException(404, "automation not found")
    return job


@router.get("", response_model=JobsOut)
async def list_jobs(session: SessionDep) -> JobsOut:
    result = await session.execute(select(AutomationJob).order_by(AutomationJob.created_at))
    jobs = list(result.scalars())
    return JobsOut(
        jobs=await _jobs_out(session, jobs),
        total=len(jobs),
        max_tokens_cap=service.MAX_TOKENS_CAP,
        max_spread_minutes=service.MAX_SPREAD_MINUTES,
        min_interval_minutes=int(service.MANUAL_COOLDOWN.total_seconds() // 60),
    )


@router.post("", response_model=JobOut, status_code=201)
async def create_job(payload: JobIn, request: Request, session: SessionDep) -> JobOut:
    schedule = _validated_schedule(payload.schedule)
    await _check_accounts(session, payload.account_ids)
    job = AutomationJob(
        name=payload.name.strip(),
        enabled=payload.enabled,
        schedule_days=",".join(schedule.days),
        schedule_time=schedule.time,
        schedule_timezone=schedule.timezone,
        spread_minutes=payload.schedule.spread_minutes,
        model=payload.model.strip(),
        prompt=payload.prompt,
        max_tokens=payload.max_tokens,
        include_paused_accounts=payload.include_paused_accounts,
        armed_at=service.now_utc(),
    )
    job.account_ids = payload.account_ids
    session.add(job)
    await session.flush()
    await audit.record(
        session,
        action="automation.created",
        target=job.name,
        detail=f"{job.model} {job.schedule_days} {job.schedule_time} {job.schedule_timezone}; "
        f"{len(job.account_ids) or 'all'} account(s); {'enabled' if job.enabled else 'disabled'}",
        client_ip=client_ip(request),
    )
    return (await _jobs_out(session, [job]))[0]


@router.get("/runs", response_model=CyclesOut)
async def list_runs(
    session: SessionDep,
    job_id: Annotated[list[str] | None, Query()] = None,
    status: Annotated[list[str] | None, Query()] = None,
    trigger: str | None = Query(default=None, pattern="^(scheduled|manual)$"),
    account_id: str | None = None,
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> CyclesOut:
    """Runs grouped into cycles, newest first. ``status`` filters on run status."""
    conditions = []
    if job_id:
        conditions.append(AutomationRun.job_id.in_(job_id))
    if status:
        conditions.append(AutomationRun.status.in_(status))
    if trigger:
        conditions.append(AutomationRun.trigger == trigger)
    if account_id:
        conditions.append(AutomationRun.account_id == account_id)
    grouped = (
        select(AutomationRun.cycle_key, func.min(AutomationRun.scheduled_for).label("at"))
        .where(*conditions)
        .group_by(AutomationRun.cycle_key)
    )
    total = (await session.execute(select(func.count()).select_from(grouped.subquery()))).scalar_one()
    page = await session.execute(
        grouped.order_by(func.min(AutomationRun.scheduled_for).desc()).limit(limit).offset(offset)
    )
    keys = [row[0] for row in page]
    cycles = await _load_cycles(session, keys)
    return CyclesOut(
        cycles=[cycles[k] for k in keys if k in cycles],
        total=total,
        limit=limit,
        offset=offset,
        has_more=offset + len(keys) < total,
    )


@router.get("/{job_id}", response_model=JobOut)
async def get_job(job_id: str, session: SessionDep) -> JobOut:
    return (await _jobs_out(session, [await _get_job(session, job_id)]))[0]


@router.patch("/{job_id}", response_model=JobOut)
async def update_job(job_id: str, payload: JobPatch, request: Request, session: SessionDep) -> JobOut:
    job = await _get_job(session, job_id)
    sent = payload.model_dump(exclude_unset=True)
    if not sent:
        raise HTTPException(422, "nothing to change")
    changed: list[str] = []
    rearm = False
    if payload.schedule is not None:
        schedule = _validated_schedule(payload.schedule)
        new = (",".join(schedule.days), schedule.time, schedule.timezone, payload.schedule.spread_minutes)
        old = (job.schedule_days, job.schedule_time, job.schedule_timezone, job.spread_minutes)
        if new != old:
            job.schedule_days, job.schedule_time, job.schedule_timezone, job.spread_minutes = new
            changed.append("schedule")
            rearm = True
    if payload.account_ids is not None:
        await _check_accounts(session, payload.account_ids)
        if payload.account_ids != job.account_ids:
            job.account_ids = payload.account_ids
            changed.append("accounts")
    for field in ("name", "model", "prompt", "max_tokens", "include_paused_accounts"):
        value = getattr(payload, field)
        if value is None:
            continue
        if isinstance(value, str) and field != "prompt":
            value = value.strip()
        if getattr(job, field) != value:
            setattr(job, field, value)
            changed.append(field)
    toggled: bool | None = None
    if payload.enabled is not None and payload.enabled != job.enabled:
        job.enabled = payload.enabled
        toggled = payload.enabled
        rearm = rearm or payload.enabled
    if rearm:
        # A slot that passed while the job was off (or on the old schedule) never fires late.
        job.armed_at = service.now_utc()
    # Runs already planned (a spread cycle can wait up to two hours) follow the change.
    if toggled is False:
        await service.cancel_pending(session, job.id, "the automation was disabled")
    elif "schedule" in changed:
        await service.cancel_pending(session, job.id, "the schedule changed")
    elif "accounts" in changed and job.account_ids:
        await service.cancel_pending(
            session, job.id, "the account is no longer a target", keep_account_ids=job.account_ids
        )
    await session.flush()
    ip = client_ip(request)
    if changed:
        await audit.record(
            session, action="automation.updated", target=job.name, detail=", ".join(changed), client_ip=ip
        )
    if toggled is not None:
        await audit.record(
            session,
            action="automation.enabled" if toggled else "automation.disabled",
            target=job.name,
            client_ip=ip,
        )
    return (await _jobs_out(session, [job]))[0]


@router.delete("/{job_id}", status_code=204)
async def delete_job(job_id: str, request: Request, session: SessionDep) -> None:
    job = await _get_job(session, job_id)
    name = job.name
    result = await session.execute(delete(AutomationRun).where(AutomationRun.job_id == job.id))
    await session.delete(job)
    await audit.record(
        session,
        action="automation.deleted",
        target=name,
        detail=f"{result.rowcount or 0} run record(s) removed",
        client_ip=client_ip(request),
    )


@router.post("/{job_id}/run", response_model=RunNowOut, status_code=202)
async def run_now(job_id: str, request: Request, session: SessionDep) -> RunNowOut:
    """Send the job's prompt to its targets now, in the background. At most once per
    `MANUAL_COOLDOWN` per job (scheduled cycles count too)."""
    job = await _get_job(session, job_id)
    last = await service.last_cycle_started(session, job.id)
    now = service.now_utc()
    if last is not None and now - last < service.MANUAL_COOLDOWN:
        wait = int((service.MANUAL_COOLDOWN - (now - last)).total_seconds()) + 1
        raise HTTPException(
            429,
            f"this automation ran less than {service.MANUAL_COOLDOWN.seconds // 60} minutes ago; "
            f"try again in {wait} s",
            headers={"retry-after": str(wait)},
        )
    cycle_key = f"{job.id}:manual:{uuid.uuid4().hex[:12]}"
    runs = await service.plan_cycle(session, job, cycle_key=cycle_key, trigger="manual", base_time=now)
    await audit.record(
        session,
        action="automation.run_now",
        target=job.name,
        detail=f"{len(runs)} account(s)",
        client_ip=client_ip(request),
    )
    pending = [r.id for r in runs if r.status == "pending"]
    # Commit before the background task looks for the rows.
    await session.commit()
    if pending:
        service.spawn(request.app.state.http_client, pending)
    return RunNowOut(cycle_key=cycle_key, runs=len(runs))
