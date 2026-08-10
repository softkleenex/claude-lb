from __future__ import annotations

import asyncio
import contextlib
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from app.db.models import Account, ModelCatalogEntry
from app.db.session import session_scope
from app.modules.health import service
from app.modules.settings import service as settings_service
from tests.test_proxy_api import MESSAGE_BODY, add_account, get_account, make_client

MODELS_BODY = {
    "data": [
        {
            "id": "claude-opus-5",
            "display_name": "Claude Opus 5",
            "max_input_tokens": 1000000,
            "max_tokens": 128000,
        },
        {
            "id": "claude-haiku-4-5",
            "display_name": "Claude Haiku 4.5",
            "max_input_tokens": 200000,
            "max_tokens": 64000,
        },
    ]
}


def models_handler(calls: list[httpx.Request], *, reject: set[str] | None = None):
    reject = reject or set()

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.headers.get("x-api-key") in reject:
            return httpx.Response(401, json={"type": "error", "error": {"type": "authentication_error"}})
        if request.url.path == "/v1/models":
            return httpx.Response(200, json=MODELS_BODY)
        return httpx.Response(
            200, json={"id": "m", "model": "claude-opus-5", "usage": {"input_tokens": 1, "output_tokens": 1}}
        )

    return handler


async def set_state(account_id: str, **fields) -> None:
    async with session_scope() as session:
        account = await session.get(Account, account_id)
        for key, value in fields.items():
            setattr(account, key, value)


class TestProbeSelection:
    def _account(self, **kwargs) -> Account:
        from tests.test_load_balancer import make_account

        return make_account("a", **kwargs)

    def test_healthy_accounts_are_not_probed(self):
        # Live traffic already proves these work; probing them just adds requests.
        assert not service._needs_probe(self._account(), now=datetime.now(UTC))

    def test_disabled_accounts_are_probed(self):
        assert service._needs_probe(self._account(enabled=False), now=datetime.now(UTC))

    def test_accounts_mid_cooldown_are_left_alone(self):
        now = datetime.now(UTC)
        account = self._account(cooldown_until=now + timedelta(minutes=5))
        assert not service._needs_probe(account, now=now)

    def test_accounts_past_cooldown_are_probed(self):
        now = datetime.now(UTC)
        account = self._account(cooldown_until=now - timedelta(seconds=1))
        assert service._needs_probe(account, now=now)

    def test_accounts_with_recent_failures_are_probed(self):
        assert service._needs_probe(self._account(consecutive_failures=2), now=datetime.now(UTC))

    def test_naive_cooldown_from_sqlite_is_handled(self):
        now = datetime.now(UTC)
        account = self._account(cooldown_until=(now + timedelta(minutes=5)).replace(tzinfo=None))
        assert not service._needs_probe(account, now=now)


class TestProbeRecovery:
    async def test_a_recovered_account_is_returned_to_rotation(self, proxy_calls):
        account_id = await add_account("broken", key="sk-ant-broken", enabled=False)
        await set_state(account_id, disabled_reason="upstream returned 401", consecutive_failures=4)

        async for client in make_client(models_handler(proxy_calls)):
            results = (await client.post("/api/health/probe")).json()

        assert [r["ok"] for r in results] == [True]
        account = await get_account(account_id)
        assert account.enabled is True
        assert account.disabled_reason is None
        assert account.consecutive_failures == 0
        assert account.last_probe_ok is True

    async def test_a_still_broken_account_stays_disabled(self, proxy_calls):
        account_id = await add_account("broken", key="sk-ant-broken", enabled=False)

        async for client in make_client(models_handler(proxy_calls, reject={"sk-ant-broken"})):
            results = (await client.post("/api/health/probe")).json()

        assert [r["ok"] for r in results] == [False]
        account = await get_account(account_id)
        assert account.enabled is False
        assert "401" in account.disabled_reason

    async def test_healthy_accounts_are_not_probed_end_to_end(self, proxy_calls):
        await add_account("fine", key="sk-ant-fine")
        async for client in make_client(models_handler(proxy_calls)):
            results = (await client.post("/api/health/probe")).json()
        assert results == []
        assert not proxy_calls, "a healthy pool should generate no upstream probe traffic"

    async def test_a_transport_error_does_not_re_enable_the_account(self, proxy_calls):
        account_id = await add_account("gone", key="sk-ant-gone", enabled=False)

        def handler(request: httpx.Request) -> httpx.Response:
            proxy_calls.append(request)
            raise httpx.ConnectError("no route to host")

        async for client in make_client(handler):
            results = (await client.post("/api/health/probe")).json()

        assert results[0]["ok"] is False
        assert (await get_account(account_id)).enabled is False

    async def test_one_failing_probe_does_not_block_the_others(self, proxy_calls):
        good_id = await add_account("good", key="sk-ant-good", enabled=False)
        bad_id = await add_account("bad", key="sk-ant-bad", enabled=False)

        async for client in make_client(models_handler(proxy_calls, reject={"sk-ant-bad"})):
            results = {r["account_name"]: r["ok"] for r in (await client.post("/api/health/probe")).json()}

        assert results == {"good": True, "bad": False}
        assert (await get_account(good_id)).enabled is True
        assert (await get_account(bad_id)).enabled is False


class TestModelCatalog:
    async def test_sync_records_the_upstream_model_list(self, proxy_calls):
        await add_account("primary", key="sk-ant-primary")

        async for client in make_client(models_handler(proxy_calls)):
            counts = (await client.post("/api/health/sync-models")).json()
            catalog = (await client.get("/api/health/models")).json()

        assert counts == {"primary": 2}
        by_id = {m["model_id"]: m for m in catalog}
        assert set(by_id) == {"claude-opus-5", "claude-haiku-4-5"}
        assert by_id["claude-opus-5"]["max_input_tokens"] == 1000000
        assert by_id["claude-opus-5"]["accounts"] == 1

    async def test_resync_removes_models_the_org_lost_access_to(self, proxy_calls):
        await add_account("primary", key="sk-ant-primary")

        shrinking = {"data": [{"id": "claude-haiku-4-5"}]}
        stage = {"first": True}

        def handler(request: httpx.Request) -> httpx.Response:
            proxy_calls.append(request)
            body = MODELS_BODY if stage["first"] else shrinking
            return httpx.Response(200, json=body)

        async for client in make_client(handler):
            await client.post("/api/health/sync-models")
            stage["first"] = False
            await client.post("/api/health/sync-models")
            catalog = (await client.get("/api/health/models")).json()

        assert {m["model_id"] for m in catalog} == {"claude-haiku-4-5"}

    async def test_a_failed_sync_leaves_the_previous_catalog_intact(self, proxy_calls):
        await add_account("primary", key="sk-ant-primary")
        stage = {"ok": True}

        def handler(request: httpx.Request) -> httpx.Response:
            proxy_calls.append(request)
            if stage["ok"]:
                return httpx.Response(200, json=MODELS_BODY)
            return httpx.Response(500, json={"error": "boom"})

        async for client in make_client(handler):
            await client.post("/api/health/sync-models")
            stage["ok"] = False
            await client.post("/api/health/sync-models")
            catalog = (await client.get("/api/health/models")).json()

        assert len(catalog) == 2, "a failed sync must not wipe a good catalog"

    async def test_catalog_counts_accounts_per_model(self, proxy_calls):
        await add_account("a", key="sk-ant-a")
        await add_account("b", key="sk-ant-b")

        async for client in make_client(models_handler(proxy_calls)):
            await client.post("/api/health/sync-models")
            catalog = {m["model_id"]: m["accounts"] for m in (await client.get("/api/health/models")).json()}

        assert catalog == {"claude-opus-5": 2, "claude-haiku-4-5": 2}


class TestModelAwareRouting:
    async def test_requests_avoid_accounts_that_cannot_serve_the_model(self, proxy_calls):
        await add_account("opus-only", key="sk-ant-opus")
        await add_account("haiku-only", key="sk-ant-haiku")

        def handler(request: httpx.Request) -> httpx.Response:
            proxy_calls.append(request)
            if request.url.path == "/v1/models":
                key = request.headers["x-api-key"]
                models = [{"id": "claude-opus-5"}] if key == "sk-ant-opus" else [{"id": "claude-haiku-4-5"}]
                return httpx.Response(200, json={"data": models})
            return httpx.Response(
                200,
                json={"id": "m", "model": "claude-opus-5", "usage": {"input_tokens": 1, "output_tokens": 1}},
            )

        async for client in make_client(handler):
            await client.post("/api/health/sync-models")
            proxy_calls.clear()
            for _ in range(8):
                await client.post("/v1/messages", json={**MESSAGE_BODY, "model": "claude-opus-5"})

        assert {c.headers["x-api-key"] for c in proxy_calls} == {"sk-ant-opus"}

    async def test_an_empty_catalog_does_not_blackhole_traffic(self, proxy_calls):
        """The dangerous failure mode: never synced, so nothing "supports" anything."""
        await add_account("primary", key="sk-ant-primary")

        async for client in make_client(models_handler(proxy_calls)):
            response = await client.post("/v1/messages", json=MESSAGE_BODY)

        assert response.status_code == 200

    async def test_an_unknown_model_falls_back_to_the_whole_pool(self, proxy_calls):
        await add_account("primary", key="sk-ant-primary")

        async for client in make_client(models_handler(proxy_calls)):
            await client.post("/api/health/sync-models")
            response = await client.post(
                "/v1/messages", json={**MESSAGE_BODY, "model": "claude-some-future-model"}
            )

        assert response.status_code == 200, "an unrecognised model must still be attempted"


class TestScheduler:
    async def test_probe_tick_respects_the_runtime_toggle(self, proxy_calls):
        await add_account("broken", key="sk-ant-broken", enabled=False)
        async with session_scope() as session:
            await settings_service.update(session, {"health_probe_enabled": False})

        async with httpx.AsyncClient(transport=httpx.MockTransport(models_handler(proxy_calls))) as client:
            interval = await service.Scheduler(client)._probe_tick()

        assert not proxy_calls, "probes must not run while disabled"
        assert interval > 0, "a disabled probe still has to schedule the next check"

    async def test_probe_tick_runs_when_enabled(self, proxy_calls):
        account_id = await add_account("broken", key="sk-ant-broken", enabled=False)

        async with httpx.AsyncClient(transport=httpx.MockTransport(models_handler(proxy_calls))) as client:
            await service.Scheduler(client)._probe_tick()

        assert proxy_calls, "an unhealthy account should have been probed"
        assert (await get_account(account_id)).enabled is True

    async def test_sync_tick_respects_the_runtime_toggle(self, proxy_calls):
        await add_account("primary", key="sk-ant-primary")
        async with session_scope() as session:
            await settings_service.update(session, {"model_sync_enabled": False})

        async with httpx.AsyncClient(transport=httpx.MockTransport(models_handler(proxy_calls))) as client:
            await service.Scheduler(client)._sync_tick()

        assert not proxy_calls

    async def test_a_failing_tick_does_not_kill_the_loop(self, proxy_calls, monkeypatch):
        """A scheduler that dies on one bad tick is worse than a noisy log."""
        calls = {"n": 0}

        async def exploding_tick() -> int:
            calls["n"] += 1
            raise RuntimeError("boom")

        async with httpx.AsyncClient(transport=httpx.MockTransport(models_handler(proxy_calls))) as client:
            scheduler = service.Scheduler(client)
            # Collapse both the startup stagger and the inter-tick wait.
            monkeypatch.setattr(scheduler, "_sleep", lambda _seconds: asyncio.sleep(0))

            task = asyncio.create_task(scheduler._loop("test", exploding_tick))
            # Let the loop spin over several failures.
            for _ in range(20):
                await asyncio.sleep(0)
                if calls["n"] >= 3:
                    break

            assert calls["n"] >= 3, f"loop stopped after {calls['n']} failure(s)"
            assert not task.done(), "the loop must survive a failing tick"

            scheduler._stopping.set()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def test_start_then_stop_leaves_no_running_tasks(self):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200))) as c:
            scheduler = service.Scheduler(c)
            scheduler.start()
            assert len(scheduler._tasks) == 2
            await scheduler.stop()
            assert scheduler._tasks == []

    async def test_stop_is_idempotent(self):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200))) as c:
            scheduler = service.Scheduler(c)
            scheduler.start()
            await scheduler.stop()
            await scheduler.stop()


class TestUnsupportedAccounts:
    async def test_an_empty_catalog_rules_nothing_out(self):
        async with session_scope() as session:
            assert await service.unsupported_accounts(session, "claude-opus-5") == set()

    async def test_an_account_that_never_synced_stays_in_rotation(self):
        """The bug this guards: once one account syncs, unsynced peers were silently
        excluded from every request, because the catalog looked 'answerable'."""
        synced = await add_account("synced")
        never = await add_account("never-synced")
        async with session_scope() as session:
            session.add(ModelCatalogEntry(account_id=synced, model_id="claude-opus-5"))

        async with session_scope() as session:
            excluded = await service.unsupported_accounts(session, "claude-opus-5")
        assert never not in excluded
        assert excluded == set()

    async def test_a_synced_account_missing_the_model_is_excluded(self):
        haiku_only = await add_account("haiku-only")
        opus_only = await add_account("opus-only")
        async with session_scope() as session:
            session.add(ModelCatalogEntry(account_id=haiku_only, model_id="claude-haiku-4-5"))
            session.add(ModelCatalogEntry(account_id=opus_only, model_id="claude-opus-5"))

        async with session_scope() as session:
            excluded = await service.unsupported_accounts(session, "claude-opus-5")
        assert excluded == {haiku_only}

    async def test_a_model_nobody_lists_excludes_every_synced_account(self):
        synced = await add_account("synced")
        async with session_scope() as session:
            session.add(ModelCatalogEntry(account_id=synced, model_id="claude-opus-5"))
        async with session_scope() as session:
            excluded = await service.unsupported_accounts(session, "claude-unknown")
        # The proxy turns this into a fail-open fallback rather than a 503.
        assert excluded == {synced}

    @pytest.mark.parametrize("model", ["", None])
    async def test_no_model_means_no_constraint(self, model):
        async with session_scope() as session:
            assert await service.unsupported_accounts(session, model or "") == set()


class TestProbeUsesTheAccountsAuthScheme:
    async def test_a_bearer_account_is_probed_with_authorization(self, proxy_calls):
        """Hardcoding x-api-key here 401s every OAuth account on every probe."""
        from tests.test_credentials import add_oauth_account

        await add_oauth_account("bearer-acct", access_token="tok-live", expires_in=3600, enabled=False)

        async for client in make_client(models_handler(proxy_calls)):
            results = (await client.post("/api/health/probe")).json()

        assert results[0]["ok"] is True
        probe = proxy_calls[0]
        assert probe.headers["authorization"] == "Bearer tok-live"
        assert "x-api-key" not in probe.headers

    async def test_extra_headers_are_sent_on_probes_too(self, proxy_calls):
        from tests.test_credentials import add_oauth_account

        await add_oauth_account(
            "bearer-acct",
            access_token="tok-live",
            expires_in=3600,
            enabled=False,
            extra_headers={"anthropic-beta": "some-flag"},
        )

        async for client in make_client(models_handler(proxy_calls)):
            await client.post("/api/health/probe")

        assert proxy_calls[0].headers["anthropic-beta"] == "some-flag"

    async def test_a_bearer_account_can_sync_its_catalog(self, proxy_calls):
        from tests.test_credentials import add_oauth_account

        await add_oauth_account("bearer-acct", access_token="tok-live", expires_in=3600)

        async for client in make_client(models_handler(proxy_calls)):
            counts = (await client.post("/api/health/sync-models")).json()

        assert counts == {"bearer-acct": 2}
