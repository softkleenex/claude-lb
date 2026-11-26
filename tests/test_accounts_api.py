"""Account management endpoints the dashboard's Accounts page relies on."""

from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import func, select

from claude_lb.db.models import Account, QuotaHistory, RequestLog, UsageDaily
from claude_lb.db.session import session_scope
from claude_lb.modules.health import service as health_service
from claude_lb.modules.proxy import model_blocks
from claude_lb.modules.proxy.load_balancer import PAUSED_REASON
from tests.test_health import models_handler, set_state
from tests.test_proxy_api import MESSAGE_BODY, add_account, get_account, make_client, ok_json


class TestRename:
    async def test_rename_updates_the_name(self):
        account_id = await add_account("old")
        async for client in make_client(ok_json([])):
            response = await client.patch(f"/api/accounts/{account_id}", json={"name": "new"})
        assert response.status_code == 200
        assert response.json()["name"] == "new"
        assert (await get_account(account_id)).name == "new"

    async def test_rename_to_a_taken_name_is_rejected(self):
        await add_account("taken")
        account_id = await add_account("mine")
        async for client in make_client(ok_json([])):
            response = await client.patch(f"/api/accounts/{account_id}", json={"name": "taken"})
        assert response.status_code == 409
        assert (await get_account(account_id)).name == "mine"

    async def test_renaming_to_its_own_name_is_a_no_op(self):
        account_id = await add_account("same")
        async for client in make_client(ok_json([])):
            response = await client.patch(f"/api/accounts/{account_id}", json={"name": "same"})
        assert response.status_code == 200

    async def test_empty_name_is_rejected(self):
        account_id = await add_account("named")
        async for client in make_client(ok_json([])):
            response = await client.patch(f"/api/accounts/{account_id}", json={"name": ""})
        assert response.status_code == 422


class TestTransport:
    async def test_create_and_update_transport(self):
        async for client in make_client(ok_json([])):
            created = await client.post(
                "/api/accounts",
                json={
                    "name": "native-subscription",
                    "api_key": "sk-ant-oat-test",
                    "provider": "oauth",
                    "transport": "claude_code",
                },
            )
            updated = await client.patch(f"/api/accounts/{created.json()['id']}", json={"transport": "http"})

        assert created.status_code == 201
        assert created.json()["transport"] == "claude_code"
        assert updated.status_code == 200
        assert updated.json()["transport"] == "http"


class TestPauseResume:
    async def test_pause_marks_the_account_paused(self):
        account_id = await add_account("acct")
        async for client in make_client(ok_json([])):
            response = await client.patch(f"/api/accounts/{account_id}", json={"enabled": False})
        body = response.json()
        assert body["enabled"] is False
        assert body["paused"] is True
        assert body["available"] is False
        assert body["disabled_reason"] == PAUSED_REASON

    async def test_resume_clears_pause_and_breaker(self):
        account_id = await add_account("acct", enabled=False, consecutive_failures=4)
        await set_state(account_id, disabled_reason=PAUSED_REASON)
        async for client in make_client(ok_json([])):
            response = await client.patch(f"/api/accounts/{account_id}", json={"enabled": True})
        body = response.json()
        assert body["paused"] is False
        assert body["available"] is True
        assert body["disabled_reason"] is None
        assert body["consecutive_failures"] == 0

    async def test_breaker_disabled_account_is_not_reported_paused(self):
        account_id = await add_account("acct", enabled=False)
        await set_state(account_id, disabled_reason="upstream returned 401")
        async for client in make_client(ok_json([])):
            body = (await client.get("/api/accounts")).json()[0]
        assert body["paused"] is False
        assert body["enabled"] is False

    async def test_background_probe_leaves_a_paused_account_alone(self, proxy_calls):
        account_id = await add_account("acct", enabled=False)
        await set_state(account_id, disabled_reason=PAUSED_REASON)
        async with httpx.AsyncClient(transport=httpx.MockTransport(models_handler(proxy_calls))) as client:
            results = await health_service.run_health_probes(client)
        assert results == []
        assert proxy_calls == []
        assert (await get_account(account_id)).enabled is False


class TestProbeOne:
    async def test_probe_reports_success_and_records_it(self, proxy_calls):
        account_id = await add_account("acct")
        async for client in make_client(models_handler(proxy_calls)):
            response = await client.post(f"/api/accounts/{account_id}/probe")
        assert response.status_code == 200
        body = response.json()
        assert body["probe"] == {"ok": True, "status_code": 200, "detail": "ok", "models": 2}
        assert body["account"]["last_probe_ok"] is True
        assert body["account"]["last_probe_at"] is not None
        assert [r.url.path for r in proxy_calls] == ["/v1/models"]

    async def test_probe_failure_is_a_result_not_an_error(self, proxy_calls):
        account_id = await add_account("acct", key="sk-ant-revoked")
        async for client in make_client(models_handler(proxy_calls, reject={"sk-ant-revoked"})):
            response = await client.post(f"/api/accounts/{account_id}/probe")
        body = response.json()
        assert response.status_code == 200
        assert body["probe"]["ok"] is False
        assert body["probe"]["status_code"] == 401
        assert body["account"]["enabled"] is False
        assert body["account"]["disabled_reason"] == "upstream returned 401"

    async def test_passing_probe_recovers_a_breaker_disabled_account(self, proxy_calls):
        account_id = await add_account("acct", enabled=False, consecutive_failures=3)
        await set_state(account_id, disabled_reason="upstream returned 401")
        async for client in make_client(models_handler(proxy_calls)):
            body = (await client.post(f"/api/accounts/{account_id}/probe")).json()
        assert body["account"]["enabled"] is True
        assert body["account"]["available"] is True

    async def test_passing_probe_keeps_a_paused_account_paused(self, proxy_calls):
        account_id = await add_account("acct", enabled=False)
        await set_state(account_id, disabled_reason=PAUSED_REASON)
        async for client in make_client(models_handler(proxy_calls)):
            body = (await client.post(f"/api/accounts/{account_id}/probe")).json()
        assert body["probe"]["ok"] is True
        assert body["account"]["paused"] is True
        assert body["account"]["last_probe_ok"] is True

    async def test_probe_does_not_lift_a_quota_block(self, proxy_calls):
        reset = datetime.now(UTC) + timedelta(hours=2)
        account_id = await add_account("sub", plan_type="max_5x")
        await set_state(
            account_id, quota_status="rate_limited", primary_reset_at=reset, primary_used_percent=100
        )
        async for client in make_client(models_handler(proxy_calls)):
            body = (await client.post(f"/api/accounts/{account_id}/probe")).json()
        assert body["account"]["quota_status"] == "rate_limited"
        assert body["account"]["available"] is False

    async def test_probe_unknown_account_is_404(self, proxy_calls):
        async for client in make_client(models_handler(proxy_calls)):
            response = await client.post("/api/accounts/nope/probe")
        assert response.status_code == 404
        assert proxy_calls == []


class TestModelBlocks:
    async def _blocked_account(self) -> str:
        account_id = await add_account("sub", plan_type="max_5x")
        async with session_scope() as session:
            account = await session.get(Account, account_id)
            model_blocks.add_block(account, "claude-sonnet-5")
            model_blocks.add_block(account, "claude-opus-5")
        return account_id

    async def test_blocks_are_listed_with_their_expiry(self):
        account_id = await self._blocked_account()
        async for client in make_client(ok_json([])):
            body = (await client.get("/api/accounts")).json()[0]
        assert body["blocked_models"] == ["claude-opus-5", "claude-sonnet-5"]
        until = datetime.fromisoformat(body["model_blocks"][0]["until"])
        expected = time.time() + model_blocks.BLOCK_TTL_SECONDS
        assert abs(until.timestamp() - expected) < 60
        assert account_id == body["id"]

    async def test_clear_one_model(self):
        account_id = await self._blocked_account()
        async for client in make_client(ok_json([])):
            response = await client.delete(
                f"/api/accounts/{account_id}/model-blocks", params={"model": "claude-opus-5"}
            )
        assert response.status_code == 200
        assert response.json()["blocked_models"] == ["claude-sonnet-5"]

    async def test_clear_all(self):
        account_id = await self._blocked_account()
        async for client in make_client(ok_json([])):
            response = await client.delete(f"/api/accounts/{account_id}/model-blocks")
        assert response.json()["model_blocks"] == []

    async def test_clearing_an_unblocked_model_is_404(self):
        account_id = await self._blocked_account()
        async for client in make_client(ok_json([])):
            response = await client.delete(
                f"/api/accounts/{account_id}/model-blocks", params={"model": "claude-haiku-4-5"}
            )
        assert response.status_code == 404


class TestTrends:
    async def test_quota_is_bucketed_hourly_and_usage_zero_filled(self, proxy_calls):
        account_id = await add_account("acct")
        now = datetime.now(UTC).replace(minute=30, second=0, microsecond=0)
        async with session_scope() as session:
            for minutes, primary, secondary in ((0, 10.0, 40.0), (5, 25.0, 41.0), (65, 5.0, None)):
                session.add(
                    QuotaHistory(
                        account_id=account_id,
                        recorded_at=now - timedelta(hours=3) + timedelta(minutes=minutes),
                        primary_used_percent=primary,
                        secondary_used_percent=secondary,
                    )
                )
            # Older than the window: excluded.
            session.add(
                QuotaHistory(
                    account_id=account_id,
                    recorded_at=now - timedelta(days=9),
                    primary_used_percent=99.0,
                )
            )

        async for client in make_client(ok_json(proxy_calls)):
            await client.post("/v1/messages", json=MESSAGE_BODY)
            response = await client.get(f"/api/accounts/{account_id}/trends", params={"days": 7})

        assert response.status_code == 200
        body = response.json()
        assert body["days"] == 7
        quota = body["quota"]
        assert [(p["primary_used_percent"], p["secondary_used_percent"]) for p in quota] == [
            (25.0, 41.0),
            (5.0, None),
        ]
        assert len(body["usage"]) == 7
        assert body["usage"][-1]["requests"] == 1
        assert body["usage"][-1]["output_tokens"] == 22
        assert sum(d["requests"] for d in body["usage"][:-1]) == 0
        assert body["totals"]["requests"] == 1

    async def test_unknown_account_is_404(self):
        async for client in make_client(ok_json([])):
            response = await client.get("/api/accounts/nope/trends")
        assert response.status_code == 404


class TestDeleteHistory:
    async def _account_with_history(self) -> str:
        account_id = await add_account("acct")
        async with session_scope() as session:
            session.add(QuotaHistory(account_id=account_id, primary_used_percent=1.0))
        return account_id

    async def _counts(self, account_id: str) -> tuple[int, int, int]:
        async with session_scope() as session:
            logs = await session.scalar(
                select(func.count(RequestLog.id)).where(RequestLog.account_id == account_id)
            )
            rollups = await session.scalar(
                select(func.count(UsageDaily.id)).where(UsageDaily.account_id == account_id)
            )
            quota = await session.scalar(
                select(func.count(QuotaHistory.id)).where(QuotaHistory.account_id == account_id)
            )
        return logs, rollups, quota

    async def test_plain_delete_keeps_request_history(self, proxy_calls):
        account_id = await self._account_with_history()
        async for client in make_client(ok_json(proxy_calls)):
            await client.post("/v1/messages", json=MESSAGE_BODY)
            response = await client.delete(f"/api/accounts/{account_id}")
        assert response.status_code == 204
        logs, rollups, quota = await self._counts(account_id)
        assert rollups == 1
        assert quota == 0
        # The request log survives with its account reference intact or nulled.
        async with session_scope() as session:
            assert await session.scalar(select(func.count(RequestLog.id))) == 1
        assert logs in (0, 1)

    async def test_delete_with_history_removes_it(self, proxy_calls):
        account_id = await self._account_with_history()
        async for client in make_client(ok_json(proxy_calls)):
            await client.post("/v1/messages", json=MESSAGE_BODY)
            response = await client.delete(f"/api/accounts/{account_id}", params={"delete_history": "true"})
        assert response.status_code == 204
        assert await self._counts(account_id) == (0, 0, 0)
        async with session_scope() as session:
            assert await session.scalar(select(func.count(RequestLog.id))) == 0
