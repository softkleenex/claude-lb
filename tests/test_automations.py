"""Automations: schedule arithmetic, idempotent slots, pinned execution, API."""

from __future__ import annotations

import random
from datetime import UTC, date, datetime, timedelta

import httpx
import pytest
from sqlalchemy import select

from claude_lb.db.models import Account, AuditEvent, AutomationJob, AutomationRun, RequestLog
from claude_lb.db.session import session_scope
from claude_lb.modules.automations import schedule as sched
from claude_lb.modules.automations import service
from claude_lb.modules.proxy import model_blocks
from claude_lb.modules.proxy.load_balancer import PAUSED_REASON
from tests.test_proxy_api import add_account, make_client, ok_json


def utc(*args) -> datetime:
    return datetime(*args, tzinfo=UTC)


class TestSchedule:
    def test_timezone_conversion_and_weekdays(self):
        s = sched.validate(["mon", "tue", "wed", "thu", "fri"], "07:00", "Asia/Seoul")
        # Seoul 07:00 Monday 2026-11-30 = Sunday 22:00 UTC.
        assert sched.slot_on(s, date(2026, 11, 30)) == utc(2026, 11, 29, 22, 0)
        # Saturday 2026-11-28 12:00 UTC: latest weekday slot is Friday's.
        day, instant = sched.latest_slot(s, utc(2026, 11, 28, 12, 0))
        assert day == date(2026, 11, 27) and instant == utc(2026, 11, 26, 22, 0)
        assert sched.next_slot(s, utc(2026, 11, 28, 12, 0)) == utc(2026, 11, 29, 22, 0)
        # Exactly at the slot counts as due; a second later the next one is tomorrow's.
        assert sched.latest_slot(s, utc(2026, 11, 29, 22, 0))[1] == utc(2026, 11, 29, 22, 0)
        assert sched.next_slot(s, utc(2026, 11, 29, 22, 0)) == utc(2026, 11, 30, 22, 0)

    def test_dst_spring_forward_nonexistent_time(self):
        s = sched.validate(["sun"], "02:30", "America/New_York")
        # 2026-03-08 02:30 does not exist in New York; it fires at 03:30 EDT = 07:30 UTC.
        assert sched.slot_on(s, date(2026, 3, 8)) == utc(2026, 3, 8, 7, 30)
        assert sched.slot_on(s, date(2026, 3, 15)) == utc(2026, 3, 15, 6, 30)  # EDT

    def test_dst_fall_back_ambiguous_time_fires_once_first_occurrence(self):
        s = sched.validate(["sun"], "01:30", "America/New_York")
        # 2026-11-01 01:30 happens twice; the first (EDT, UTC-4) is 05:30 UTC.
        first = sched.slot_on(s, date(2026, 11, 1))
        assert first == utc(2026, 11, 1, 5, 30)
        # One hour later (the repeated 01:30 EST) is not another slot.
        assert sched.next_slot(s, first + timedelta(minutes=1)) == utc(2026, 11, 8, 6, 30)

    @pytest.mark.parametrize(
        ("days", "at", "tz"),
        [
            ([], "07:00", "UTC"),
            (["mon", "xyz"], "07:00", "UTC"),
            (["mon"], "7:00", "UTC"),
            (["mon"], "24:00", "UTC"),
            (["mon"], "07:00", "Mars/Olympus"),
        ],
    )
    def test_validation(self, days, at, tz):
        with pytest.raises(sched.ScheduleError):
            sched.validate(days, at, tz)

    def test_days_are_normalized(self):
        assert sched.parse_days("fri,MON, mon") == ("mon", "fri")


async def add_job(**fields) -> str:
    defaults = {
        "name": "morning",
        "schedule_days": ",".join(sched.WEEKDAYS),
        "schedule_time": "07:00",
        "schedule_timezone": "UTC",
        "model": "claude-haiku-4-5",
        "prompt": "hi",
        "max_tokens": 8,
        "armed_at": utc(2026, 1, 1),
    }
    account_ids = fields.pop("account_ids", [])
    async with session_scope() as session:
        job = AutomationJob(**(defaults | fields))
        job.account_ids = account_ids
        session.add(job)
        await session.flush()
        return job.id


async def runs() -> list[AutomationRun]:
    async with session_scope() as session:
        result = await session.execute(select(AutomationRun).order_by(AutomationRun.account_name))
        return list(result.scalars())


def mock_client(calls: list[httpx.Request], handler=None) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler or ok_json(calls)))


class TestSchedulerTick:
    async def test_slot_fires_once_per_account_and_restarts_do_not_refire(self):
        a = await add_account("alpha", key="sk-ant-alpha")
        b = await add_account("beta", key="sk-ant-beta")
        await add_job(account_ids=[a, b])
        calls: list[httpx.Request] = []
        slot = utc(2026, 11, 30, 7, 0)

        sent = await service.tick(mock_client(calls), now=slot + timedelta(seconds=30))
        assert sent == 2
        assert sorted(r.headers["x-api-key"] for r in calls) == ["sk-ant-alpha", "sk-ant-beta"]
        assert {r.headers["user-agent"] for r in calls} == {service.USER_AGENT}
        assert all(r.url.path == "/v1/messages" for r in calls)

        # Next minute, and a "restarted" process: the slot is already planned.
        assert await service.tick(mock_client(calls), now=slot + timedelta(minutes=1)) == 0
        assert await service.tick(mock_client(calls), now=slot + timedelta(minutes=5)) == 0
        assert len(calls) == 2

        done = await runs()
        assert [r.status for r in done] == ["success", "success"]
        assert done[0].account_name == "alpha" and done[0].http_status == 200
        assert done[0].input_tokens == 11 and done[0].output_tokens == 22 and done[0].cost_usd > 0
        assert done[0].cycle_key == done[1].cycle_key

        async with session_scope() as session:
            logs = list((await session.execute(select(RequestLog))).scalars())
        assert len(logs) == 2 and {log.user_agent for log in logs} == {service.USER_AGENT}
        assert {log.account_id for log in logs} == {a, b}

        # The next day fires again.
        assert await service.tick(mock_client(calls), now=slot + timedelta(days=1, seconds=10)) == 2

    async def test_late_and_unarmed_slots_do_not_fire(self):
        await add_account("alpha")
        calls: list[httpx.Request] = []
        await add_job(name="late")
        await add_job(name="fresh", armed_at=utc(2026, 11, 30, 7, 5))
        await add_job(name="off", enabled=False)
        # 20 minutes after the slot is past the grace period.
        assert await service.tick(mock_client(calls), now=utc(2026, 11, 30, 7, 20)) == 0
        # Within grace, only "late" fires: "fresh" was created after the slot, "off" is off.
        assert await service.tick(mock_client(calls), now=utc(2026, 12, 1, 7, 1)) == 2
        names = {r.job_name for r in await runs()}
        assert names == {"late", "fresh"}

    async def test_spread_staggers_runs_within_the_window(self):
        for name in ("a1", "a2", "a3"):
            await add_account(name)
        await add_job(spread_minutes=30)
        calls: list[httpx.Request] = []
        slot = utc(2026, 11, 30, 7, 0)
        await service.tick(mock_client(calls), now=slot + timedelta(seconds=5), rng=random.Random(1))
        planned = await runs()
        assert len(planned) == 3
        offsets = [(r.scheduled_for.replace(tzinfo=UTC) - slot).total_seconds() for r in planned]
        assert all(0 <= o <= 30 * 60 for o in offsets)
        # Sent once due (the scheduler ticks every minute), each exactly once.
        for minute in range(1, 32):
            await service.tick(mock_client(calls), now=slot + timedelta(minutes=minute))
        assert len(calls) == 3 and {r.status for r in await runs()} == {"success"}

    async def test_missed_runs_are_skipped_and_stale_running_fails(self):
        a = await add_account("alpha")
        job = await add_job(account_ids=[a])
        async with session_scope() as session:
            session.add(
                AutomationRun(
                    job_id=job,
                    cycle_key="c1",
                    slot_key="c1:a",
                    status="pending",
                    scheduled_for=utc(2026, 11, 30, 6, 0),
                    account_id=a,
                    account_name="alpha",
                )
            )
            session.add(
                AutomationRun(
                    job_id=job,
                    cycle_key="c2",
                    slot_key="c2:a",
                    status="running",
                    scheduled_for=utc(2026, 11, 30, 6, 0),
                    started_at=utc(2026, 11, 30, 6, 0),
                    account_id=a,
                    account_name="alpha",
                )
            )
        await service.tick(mock_client([]), now=utc(2026, 11, 30, 6, 40))
        by_key = {r.cycle_key: r for r in await runs()}
        assert by_key["c1"].status == "skipped" and "missed" in by_key["c1"].error
        assert by_key["c2"].status == "failed" and "interrupted" in by_key["c2"].error

    async def test_paused_refused_and_disabled_accounts_are_skipped_without_a_request(self):
        paused = await add_account("paused", enabled=False, disabled_reason=PAUSED_REASON)
        broken = await add_account("broken", enabled=False, disabled_reason="401 from upstream")
        refused = await add_account("refused", plan_type="max_5x")
        async with session_scope() as session:
            model_blocks.add_block(await session.get(Account, refused), "claude-haiku-4-5")
        await add_job(account_ids=[paused, broken, refused])
        calls: list[httpx.Request] = []
        await service.tick(mock_client(calls), now=utc(2026, 11, 30, 7, 0, 30))
        assert calls == []
        result = {r.account_name: r for r in await runs()}
        assert {r.status for r in result.values()} == {"skipped"}
        assert result["paused"].error == "account is paused"
        assert "disabled" in result["broken"].error
        assert result["refused"].error.startswith("model refused")

    async def test_include_paused_sends_through_a_paused_account(self):
        paused = await add_account(
            "paused", key="sk-ant-paused", enabled=False, disabled_reason=PAUSED_REASON
        )
        await add_job(account_ids=[paused], include_paused_accounts=True)
        calls: list[httpx.Request] = []
        await service.tick(mock_client(calls), now=utc(2026, 11, 30, 7, 0, 30))
        assert [r.headers["x-api-key"] for r in calls] == ["sk-ant-paused"]
        assert (await runs())[0].status == "success"

    async def test_upstream_model_refusal_marks_skipped_and_records_the_block(self):
        sub = await add_account("sub", plan_type="max_5x", auth_scheme="bearer")
        await add_job(account_ids=[sub])
        calls: list[httpx.Request] = []

        def refuse(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return httpx.Response(
                429, json={"type": "error", "error": {"type": "rate_limit_error", "message": "no"}}
            )

        await service.tick(mock_client(calls, refuse), now=utc(2026, 11, 30, 7, 0, 30))
        assert len(calls) == 1, "one attempt only: the run is pinned"
        run = (await runs())[0]
        assert run.status == "skipped" and run.error.startswith("model refused")
        async with session_scope() as session:
            account = await session.get(Account, sub)
            assert model_blocks.is_blocked(account, "claude-haiku-4-5")

    async def test_upstream_error_fails_the_run(self):
        a = await add_account("alpha")
        await add_job(account_ids=[a])

        def bad(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                400,
                json={
                    "type": "error",
                    "error": {"type": "invalid_request_error", "message": "max_tokens: too small"},
                },
            )

        await service.tick(mock_client([], bad), now=utc(2026, 11, 30, 7, 0, 30))
        run = (await runs())[0]
        assert run.status == "failed" and run.http_status == 400 and run.error == "max_tokens: too small"


class TestApi:
    async def test_crud_estimate_run_now_and_runs(self):
        api_acc = await add_account("console", plan_type="api")
        sub = await add_account("max", plan_type="max_5x")
        calls: list[httpx.Request] = []
        async for client in make_client(ok_json(calls)):
            body = {
                "name": "Start window",
                "schedule": {
                    "days": ["mon", "fri"],
                    "time": "07:00",
                    "timezone": "Asia/Seoul",
                    "spread_minutes": 5,
                },
                "model": "claude-haiku-4-5",
                "prompt": "Reply with OK",
                "account_ids": [api_acc, sub, api_acc],
            }
            created = await client.post("/api/automations", json=body)
            assert created.status_code == 201, created.text
            job = created.json()
            assert job["enabled"] is True, "codex-lb parity: new jobs start enabled"
            assert job["max_tokens"] == service.DEFAULT_MAX_TOKENS
            assert job["account_ids"] == [api_acc, sub], "duplicates dropped"
            assert [t["name"] for t in job["targets"]] == ["console", "max"]
            assert job["schedule"]["days"] == ["mon", "fri"]
            assert job["next_run_at"] is not None and job["last_cycle"] is None
            est = job["estimate"]
            assert est["api_accounts"] == 1 and est["subscription_accounts"] == 1
            assert est["per_run_usd"] == pytest.approx(est["per_request_usd"]) and est["per_request_usd"] > 0

            for bad in (
                {**body, "max_tokens": 2048},
                {**body, "schedule": {**body["schedule"], "timezone": "Nowhere/City"}},
                {**body, "schedule": {**body["schedule"], "days": []}},
                {**body, "schedule": {**body["schedule"], "spread_minutes": 500}},
                {**body, "account_ids": ["missing"]},
            ):
                assert (await client.post("/api/automations", json=bad)).status_code == 422

            listing = (await client.get("/api/automations")).json()
            assert listing["total"] == 1 and listing["max_tokens_cap"] == 1024
            assert listing["min_interval_minutes"] == 5

            patched = await client.patch(
                f"/api/automations/{job['id']}", json={"enabled": False, "max_tokens": 4}
            )
            assert patched.json()["enabled"] is False and patched.json()["next_run_at"] is None
            assert (await client.patch(f"/api/automations/{job['id']}", json={})).status_code == 422

            run = await client.post(f"/api/automations/{job['id']}/run")
            assert run.status_code == 202 and run.json()["runs"] == 2
            await service.wait_background()
            again = await client.post(f"/api/automations/{job['id']}/run")
            assert again.status_code == 429 and "retry-after" in again.headers

            cycles = (await client.get("/api/automations/runs")).json()
            assert cycles["total"] == 1
            cycle = cycles["cycles"][0]
            assert cycle["trigger"] == "manual" and cycle["status"] == "success"
            assert cycle["total"] == 2 and cycle["succeeded"] == 2 and cycle["cost_usd"] > 0
            assert [r["account_name"] for r in cycle["runs"]] == ["console", "max"]
            assert len(calls) == 2

            filtered = (await client.get("/api/automations/runs", params={"status": "failed"})).json()
            assert filtered["total"] == 0
            last = (await client.get(f"/api/automations/{job['id']}")).json()["last_cycle"]
            assert last["cycle_key"] == cycle["cycle_key"]

            assert (await client.delete(f"/api/automations/{job['id']}")).status_code == 204
            assert (await client.get(f"/api/automations/{job['id']}")).status_code == 404
            assert (await client.get("/api/automations/runs")).json()["total"] == 0

        async with session_scope() as session:
            actions = [a for (a,) in (await session.execute(select(AuditEvent.action))).all()]
        for action in (
            "automation.created",
            "automation.updated",
            "automation.disabled",
            "automation.run_now",
            "automation.deleted",
        ):
            assert action in actions

    async def test_empty_selection_targets_all_unpaused_accounts(self):
        await add_account("a")
        await add_account("b", enabled=False, disabled_reason=PAUSED_REASON)
        async for client in make_client(ok_json([])):
            job = (
                await client.post(
                    "/api/automations",
                    json={
                        "name": "all",
                        "schedule": {"time": "07:00"},
                        "model": "claude-haiku-4-5",
                    },
                )
            ).json()
            assert [t["name"] for t in job["targets"]] == ["a"]
            job = (
                await client.patch(f"/api/automations/{job['id']}", json={"include_paused_accounts": True})
            ).json()
            assert [t["name"] for t in job["targets"]] == ["a", "b"]
