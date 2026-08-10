from __future__ import annotations

import json

import httpx
import pytest

from app.db.models import Account
from app.db.session import session_scope
from app.modules.proxy import sticky
from app.modules.settings import service
from tests.test_proxy_api import MESSAGE_BODY, add_account, make_client, ok_json


@pytest.fixture(autouse=True)
def clean_settings_cache():
    service.invalidate()
    sticky.clear()
    yield
    service.invalidate()
    sticky.clear()


class TestSettingsService:
    async def test_defaults_come_from_the_environment(self):
        async with session_scope() as session:
            settings = await service.load(session, use_cache=False)
        assert settings.routing_strategy == "capacity_weighted"
        assert settings.max_attempts == 3  # CLAUDE_LB_MAX_ATTEMPTS in conftest

    async def test_update_persists_and_overrides_the_default(self):
        async with session_scope() as session:
            await service.update(session, {"routing_strategy": "round_robin"})
        async with session_scope() as session:
            assert (await service.load(session, use_cache=False)).routing_strategy == "round_robin"

    async def test_partial_update_leaves_other_keys_alone(self):
        async with session_scope() as session:
            await service.update(session, {"routing_strategy": "least_used", "max_attempts": 7})
            await service.update(session, {"max_attempts": 2})
            settings = await service.load(session, use_cache=False)
        assert settings.routing_strategy == "least_used"
        assert settings.max_attempts == 2

    async def test_unknown_strategy_is_rejected(self):
        async with session_scope() as session:
            with pytest.raises(ValueError, match="unknown routing strategy"):
                await service.update(session, {"routing_strategy": "teleport"})

    async def test_unknown_key_is_rejected(self):
        async with session_scope() as session:
            with pytest.raises(ValueError, match="unknown setting"):
                await service.update(session, {"nonsense": 1})

    async def test_out_of_range_value_is_rejected(self):
        async with session_scope() as session:
            with pytest.raises(ValueError):
                await service.update(session, {"max_attempts": 999})

    async def test_a_rejected_update_writes_nothing(self):
        async with session_scope() as session:
            await service.update(session, {"max_attempts": 5})
        async with session_scope() as session:
            with pytest.raises(ValueError):
                await service.update(session, {"max_attempts": 999})
        async with session_scope() as session:
            assert (await service.load(session, use_cache=False)).max_attempts == 5

    async def test_corrupt_stored_value_falls_back_to_defaults_rather_than_crashing(self):
        from app.db.models import Setting

        async with session_scope() as session:
            session.add(Setting(key="routing_strategy", value_json=json.dumps("teleport")))
        service.invalidate()
        async with session_scope() as session:
            settings = await service.load(session, use_cache=False)
        assert settings.routing_strategy == "capacity_weighted"

    async def test_unparseable_row_is_skipped(self):
        from app.db.models import Setting

        async with session_scope() as session:
            session.add(Setting(key="max_attempts", value_json="{not json"))
        service.invalidate()
        async with session_scope() as session:
            assert (await service.load(session, use_cache=False)).max_attempts == 3

    async def test_reset_clears_every_override(self):
        async with session_scope() as session:
            await service.update(session, {"routing_strategy": "fill_first", "max_attempts": 9})
        async with session_scope() as session:
            settings = await service.reset(session)
        assert settings.routing_strategy == "capacity_weighted"
        assert settings.max_attempts == 3

    async def test_writes_invalidate_the_read_cache(self):
        async with session_scope() as session:
            await service.load(session)  # populate the cache
            await service.update(session, {"routing_strategy": "round_robin"})
            # A cached read must not serve the pre-update value.
            assert (await service.load(session)).routing_strategy == "round_robin"


class TestSettingsApi:
    async def test_get_returns_settings_and_the_strategy_list(self):
        async for client in make_client(ok_json([])):
            payload = (await client.get("/api/settings")).json()
        assert payload["settings"]["routing_strategy"] == "capacity_weighted"
        assert "capacity_weighted" in payload["available_strategies"]

    async def test_patch_updates_a_single_key(self):
        async for client in make_client(ok_json([])):
            response = await client.patch("/api/settings", json={"routing_strategy": "round_robin"})
        assert response.status_code == 200
        assert response.json()["settings"]["routing_strategy"] == "round_robin"

    async def test_patch_rejects_an_unknown_field(self):
        async for client in make_client(ok_json([])):
            response = await client.patch("/api/settings", json={"teleport": True})
        assert response.status_code == 422

    async def test_patch_rejects_an_invalid_strategy(self):
        async for client in make_client(ok_json([])):
            response = await client.patch("/api/settings", json={"routing_strategy": "teleport"})
        assert response.status_code == 422

    async def test_empty_patch_is_rejected(self):
        async for client in make_client(ok_json([])):
            response = await client.patch("/api/settings", json={})
        assert response.status_code == 400


class TestSettingsTakeEffectWithoutRestart:
    async def test_changing_max_attempts_changes_the_fan_out(self, proxy_calls):
        for i in range(6):
            await add_account(f"account-{i}", key=f"sk-ant-{i}")

        def handler(request: httpx.Request) -> httpx.Response:
            proxy_calls.append(request)
            return httpx.Response(503, json={"type": "error", "error": {"type": "overloaded_error"}})

        async for client in make_client(handler):
            await client.post("/v1/messages", json=MESSAGE_BODY)
            first_burst = len(proxy_calls)

            await client.patch("/api/settings", json={"max_attempts": 5})
            proxy_calls.clear()
            await client.post("/v1/messages", json=MESSAGE_BODY)
            second_burst = len(proxy_calls)

        assert first_burst == 3, "env default"
        assert second_burst == 5, "live setting must apply to the very next request"

    async def test_changing_the_strategy_changes_which_account_is_picked(self, proxy_calls):
        # single_account is deterministic: always the highest-priority account.
        await add_account("low", key="sk-ant-low", priority=0)
        await add_account("high", key="sk-ant-high", priority=50)

        async for client in make_client(ok_json(proxy_calls)):
            await client.patch("/api/settings", json={"routing_strategy": "single_account"})
            for _ in range(5):
                await client.post("/v1/messages", json=MESSAGE_BODY)

        assert {c.headers["x-api-key"] for c in proxy_calls} == {"sk-ant-high"}


class TestStickyRoutingThroughTheProxy:
    async def test_a_conversation_stays_on_one_account_across_turns(self, proxy_calls):
        for i in range(5):
            await add_account(f"account-{i}", key=f"sk-ant-{i}")

        turns = [
            {**MESSAGE_BODY, "messages": [{"role": "user", "content": "start"}]},
            {
                **MESSAGE_BODY,
                "messages": [
                    {"role": "user", "content": "start"},
                    {"role": "assistant", "content": "ok"},
                    {"role": "user", "content": "more"},
                ],
            },
            {
                **MESSAGE_BODY,
                "messages": [
                    {"role": "user", "content": "start"},
                    {"role": "assistant", "content": "ok"},
                    {"role": "user", "content": "more"},
                    {"role": "assistant", "content": "ok again"},
                    {"role": "user", "content": "even more"},
                ],
            },
        ]

        async for client in make_client(ok_json(proxy_calls)):
            served_by = [
                (await client.post("/v1/messages", json=turn)).headers["x-claude-lb-account"]
                for turn in turns
            ]

        assert len(set(served_by)) == 1, f"conversation bounced across accounts: {served_by}"

    async def test_distinct_conversations_still_spread_across_the_pool(self, proxy_calls):
        for i in range(4):
            await add_account(f"account-{i}", key=f"sk-ant-{i}")

        async for client in make_client(ok_json(proxy_calls)):
            served_by = set()
            for i in range(60):
                body = {**MESSAGE_BODY, "messages": [{"role": "user", "content": f"topic {i}"}]}
                response = await client.post("/v1/messages", json=body)
                served_by.add(response.headers["x-claude-lb-account"])

        assert len(served_by) > 1, "affinity must not collapse the pool onto one account"

    async def test_affinity_yields_when_the_sticky_account_fails(self, proxy_calls):
        await add_account("primary", key="sk-ant-primary")
        await add_account("backup", key="sk-ant-backup")

        failing: set[str] = set()

        def handler(request: httpx.Request) -> httpx.Response:
            proxy_calls.append(request)
            if request.headers["x-api-key"] in failing:
                return httpx.Response(503, json={"type": "error", "error": {"type": "overloaded_error"}})
            return httpx.Response(
                200,
                json={"id": "m", "model": "claude-opus-5", "usage": {"input_tokens": 1, "output_tokens": 1}},
            )

        async for client in make_client(handler):
            first = await client.post("/v1/messages", json=MESSAGE_BODY)
            stuck_to = first.headers["x-claude-lb-account"]

            # Take the sticky account down and repeat the same conversation.
            failing.add(f"sk-ant-{stuck_to}")
            second = await client.post("/v1/messages", json=MESSAGE_BODY)

        assert second.status_code == 200
        assert second.headers["x-claude-lb-account"] != stuck_to

    async def test_disabling_stickiness_lets_routing_spread_again(self, proxy_calls):
        for i in range(4):
            await add_account(f"account-{i}", key=f"sk-ant-{i}")

        async for client in make_client(ok_json(proxy_calls)):
            await client.patch(
                "/api/settings",
                json={"sticky_sessions_enabled": False, "routing_strategy": "round_robin"},
            )
            served_by = set()
            for _ in range(12):
                response = await client.post("/v1/messages", json=MESSAGE_BODY)
                served_by.add(response.headers["x-claude-lb-account"])

        assert len(served_by) == 4, "with stickiness off, round robin should touch every account"

    async def test_a_pinned_api_key_still_beats_affinity(self, proxy_calls):
        pinned_id = await add_account("pinned", key="sk-ant-pinned")
        await add_account("other", key="sk-ant-other")

        async with session_scope() as session:
            account = await session.get(Account, pinned_id)
            assert account is not None

        async for client in make_client(ok_json(proxy_calls)):
            created = (
                await client.post("/api/keys", json={"name": "bound", "pinned_account_id": pinned_id})
            ).json()
            for _ in range(5):
                await client.post(
                    "/v1/messages",
                    json=MESSAGE_BODY,
                    headers={"x-api-key": created["api_key"]},
                )

        assert {c.headers["x-api-key"] for c in proxy_calls} == {"sk-ant-pinned"}
