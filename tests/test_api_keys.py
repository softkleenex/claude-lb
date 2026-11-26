"""API key management (edit, regenerate, rules, trends, overview) and its enforcement
at the proxy: model allowlists, enforced models, assigned accounts, multi-rule limits."""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import select

from claude_lb.core.config import get_settings
from claude_lb.db.models import ApiKey, ApiKeyLimitRule, AuditEvent, UsageDaily
from claude_lb.db.session import session_scope
from claude_lb.modules.api_keys import limits
from claude_lb.modules.api_keys import service as key_service
from claude_lb.modules.proxy.service import record_request
from claude_lb.modules.proxy.usage_parser import Usage
from tests.test_proxy_api import MESSAGE_BODY, add_account, get_logs, make_client, ok_json


@pytest.fixture
def require_key(monkeypatch):
    monkeypatch.setattr(get_settings(), "require_api_key", True)


async def create(client: httpx.AsyncClient, **payload) -> dict:
    response = await client.post("/api/keys", json={"name": "k", **payload})
    assert response.status_code == 201, response.text
    return response.json()


async def log_usage(
    key_id: str, *, model: str = "claude-opus-5", account_id: str | None = None, **usage
) -> None:
    await record_request(
        account_id=account_id,
        api_key_id=key_id,
        path="/v1/messages",
        model=model,
        status_code=200,
        streaming=False,
        started_at=time.perf_counter(),
        attempts=1,
        usage=Usage(**usage),
    )


class TestManagement:
    async def test_create_with_policy_and_rules_round_trips(self):
        account_id = await add_account("a1")
        async for client in make_client(ok_json([])):
            created = await create(
                client,
                allowed_models=[" claude-sonnet-4-5 ", "claude-sonnet-4-5", ""],
                enforced_model="",
                assigned_account_ids=[account_id],
                expires_at="2099-01-01T00:00:00Z",
                limits=[
                    {"metric": "requests", "window": "5h", "max_value": 100},
                    {
                        "metric": "cost_usd",
                        "window": "monthly",
                        "max_value": 12.5,
                        "model_filter": "claude-opus-4",
                    },
                    {"metric": "total_tokens", "window": "custom", "window_seconds": 600, "max_value": 1000},
                ],
            )
            listed = (await client.get("/api/keys")).json()

        assert created["api_key"].startswith("clb_")
        assert created["allowed_models"] == ["claude-sonnet-4-5"]
        assert created["enforced_model"] is None
        assert created["assigned_account_ids"] == [account_id]
        assert created["status"] == "active"
        rules = created["limits"]
        assert [(r["metric"], r["window"], r["window_seconds"]) for r in rules] == [
            ("requests", "5h", 18000),
            ("cost_usd", "monthly", 31 * 86400),
            ("total_tokens", "custom", 600),
        ]
        assert all(r["source"] == "rule" and r["current_value"] == 0 for r in rules)
        assert rules[1]["model_filter"] == "claude-opus-4"
        assert rules[1]["resets_at"] is not None, "calendar windows always have a next boundary"
        assert rules[0]["resets_at"] is None, "an empty rolling window frees nothing"
        assert [{**r, "window_start": None} for r in listed[0]["limits"]] == [
            {**r, "window_start": None} for r in rules
        ]
        assert "api_key" not in listed[0]

    async def test_invalid_input_is_rejected(self):
        async for client in make_client(ok_json([])):
            unknown_account = await client.post(
                "/api/keys", json={"name": "x", "assigned_account_ids": ["nope"]}
            )
            custom_without_seconds = await client.post(
                "/api/keys",
                json={"name": "x", "limits": [{"metric": "requests", "window": "custom", "max_value": 1}]},
            )
            bad_metric = await client.post(
                "/api/keys",
                json={"name": "x", "limits": [{"metric": "credits", "window": "5h", "max_value": 1}]},
            )
            zero = await client.post(
                "/api/keys",
                json={"name": "x", "limits": [{"metric": "requests", "window": "5h", "max_value": 0}]},
            )
        assert unknown_account.status_code == 422
        assert custom_without_seconds.status_code == 422
        assert bad_metric.status_code == 422
        assert zero.status_code == 422

    async def test_patch_edits_only_sent_fields_and_replaces_rules(self):
        async for client in make_client(ok_json([])):
            key = await create(
                client,
                allowed_models=["claude-haiku-4-5"],
                expires_at="2099-01-01T00:00:00Z",
                limits=[{"metric": "requests", "window": "daily", "max_value": 5}],
            )
            renamed = (await client.patch(f"/api/keys/{key['id']}", json={"name": "renamed"})).json()
            edited = (
                await client.patch(
                    f"/api/keys/{key['id']}",
                    json={
                        "expires_at": None,
                        "allowed_models": [],
                        "enforced_model": "claude-sonnet-4-5",
                        "limits": [
                            {"metric": "output_tokens", "window": "weekly", "max_value": 50},
                            {"metric": "input_tokens", "window": "7d", "max_value": 70},
                        ],
                    },
                )
            ).json()
            await create(client, name="other")
            taken = await client.patch(f"/api/keys/{key['id']}", json={"name": "other"})
            empty = await client.patch(f"/api/keys/{key['id']}")

        assert renamed["name"] == "renamed"
        assert renamed["allowed_models"] == ["claude-haiku-4-5"], "unsent fields are untouched"
        assert renamed["expires_at"] is not None
        assert edited["expires_at"] is None
        assert edited["allowed_models"] is None, "an empty allowlist means no restriction"
        assert edited["enforced_model"] == "claude-sonnet-4-5"
        assert [r["metric"] for r in edited["limits"]] == ["output_tokens", "input_tokens"]
        assert taken.status_code == 409
        assert empty.status_code == 422
        async with session_scope() as session:
            assert len((await session.execute(select(ApiKeyLimitRule))).all()) == 2

    async def test_enable_disable_keeps_the_query_parameter_form(self):
        async for client in make_client(ok_json([])):
            key = await create(client)
            legacy = (await client.patch(f"/api/keys/{key['id']}?enabled=false")).json()
            body = (await client.patch(f"/api/keys/{key['id']}", json={"enabled": True})).json()
        assert legacy["enabled"] is False and legacy["status"] == "disabled"
        assert body["enabled"] is True and body["status"] == "active"
        async with session_scope() as session:
            actions = [
                a for (a,) in await session.execute(select(AuditEvent.action).order_by(AuditEvent.created_at))
            ]
        assert actions[-2:] == ["api_key.disabled", "api_key.enabled"]

    async def test_regenerate_swaps_the_secret_and_keeps_the_record(self, require_key):
        await add_account("primary")
        async for client in make_client(ok_json([])):
            key = await create(client, limits=[{"metric": "requests", "window": "5h", "max_value": 9}])
            regenerated = await client.post(f"/api/keys/{key['id']}/regenerate")
            new = regenerated.json()
            old_secret = await client.post(
                "/v1/messages", json=MESSAGE_BODY, headers={"x-api-key": key["api_key"]}
            )
            new_secret = await client.post(
                "/v1/messages", json=MESSAGE_BODY, headers={"x-api-key": new["api_key"]}
            )
            missing = await client.post("/api/keys/nope/regenerate")

        assert regenerated.status_code == 200
        assert new["id"] == key["id"] and new["api_key"] != key["api_key"]
        assert new["key_hint"] == new["api_key"][-6:]
        assert len(new["limits"]) == 1
        assert old_secret.status_code == 401
        assert new_secret.status_code == 200
        assert missing.status_code == 404

    async def test_legacy_budget_shows_as_rules_and_an_edit_converts_it(self):
        async for client in make_client(ok_json([])):
            key = await create(
                client, max_requests_per_window=3, max_cost_usd_per_window=2.0, window_seconds=18000
            )
            assert [(r["source"], r["metric"], r["window"]) for r in key["limits"]] == [
                ("legacy", "requests", "5h"),
                ("legacy", "cost_usd", "5h"),
            ]
            converted = (
                await client.patch(
                    f"/api/keys/{key['id']}",
                    json={"limits": [{"metric": "requests", "window": "5h", "max_value": 3}]},
                )
            ).json()
        assert converted["max_requests_per_window"] is None
        assert converted["max_cost_usd_per_window"] is None
        assert [(r["source"], r["metric"]) for r in converted["limits"]] == [("rule", "requests")]

    async def test_delete_removes_rules(self):
        async for client in make_client(ok_json([])):
            key = await create(client, limits=[{"metric": "requests", "window": "5h", "max_value": 1}])
            deleted = await client.delete(f"/api/keys/{key['id']}")
        assert deleted.status_code == 204
        async with session_scope() as session:
            assert (await session.execute(select(ApiKeyLimitRule))).first() is None


class TestUsageReporting:
    async def test_rule_usage_counts_window_and_model_filter(self):
        account_id = await add_account("a1")
        async for client in make_client(ok_json([])):
            key = await create(
                client,
                limits=[
                    {"metric": "requests", "window": "5h", "max_value": 10},
                    {"metric": "total_tokens", "window": "5h", "max_value": 1000},
                    {"metric": "input_tokens", "window": "5h", "max_value": 1000},
                    {
                        "metric": "output_tokens",
                        "window": "5h",
                        "max_value": 1000,
                        "model_filter": "claude-haiku-4-5",
                    },
                ],
            )
            await log_usage(
                key["id"],
                account_id=account_id,
                input_tokens=10,
                output_tokens=5,
                cache_read_input_tokens=100,
            )
            await log_usage(
                key["id"],
                model="claude-haiku-4-5-20251001",
                account_id=account_id,
                input_tokens=1,
                output_tokens=7,
            )
            listed = (await client.get(f"/api/keys/{key['id']}")).json()

        requests, total, prompt, haiku_out = listed["limits"]
        assert requests["current_value"] == 2
        assert total["current_value"] == 123
        assert prompt["current_value"] == 111, "input counts cache reads and writes too"
        assert haiku_out["current_value"] == 7, "a model filter matches the dated id of a family"
        assert requests["used_percent"] == 20 and requests["remaining"] == 8
        assert requests["resets_at"] is not None
        assert listed["total_tokens"] == 123
        assert listed["total_requests"] == 2
        assert listed["lifetime_requests"] == 2

    async def test_trends_overview_and_cost_by_account(self):
        a1 = await add_account("alpha", plan_type="max_5x")
        a2 = await add_account("beta")
        async for client in make_client(ok_json([])):
            busy = await create(client, name="busy")
            await create(client, name="idle")
            off = await create(client, name="off")
            await create(client, name="old", expires_at="2000-01-01T00:00:00Z")
            await client.patch(f"/api/keys/{off['id']}", json={"enabled": False})
            await log_usage(busy["id"], account_id=a1, input_tokens=100, output_tokens=50)
            await log_usage(busy["id"], account_id=a2, input_tokens=10, output_tokens=5)
            async with session_scope() as session:
                # An older day, outside a 7-day trend but inside lifetime totals.
                session.add(
                    UsageDaily(
                        day=(datetime.now(UTC).date() - timedelta(days=30)).isoformat(),
                        account_id=a1,
                        api_key_id=busy["id"],
                        model="claude-opus-5",
                        requests=4,
                        input_tokens=1000,
                        cost_usd=1.0,
                    )
                )
            trends = (await client.get(f"/api/keys/{busy['id']}/trends")).json()
            overview = (await client.get("/api/keys/overview")).json()
            missing = await client.get("/api/keys/nope/trends")

        assert missing.status_code == 404
        assert trends["days"] == 7 and len(trends["usage"]) == 7
        assert trends["usage"][-1]["requests"] == 2
        assert trends["usage"][-1]["total_tokens"] == 165
        assert trends["totals"]["requests"] == 2
        assert [(r["account_name"], r["plan_type"]) for r in trends["by_account"]][0][0] in {"alpha", "beta"}
        assert {r["account_name"] for r in trends["by_account"]} == {"alpha", "beta"}
        assert trends["by_model"][0]["model"] == "claude-opus-5"

        assert overview["total"] == 4
        assert overview["active"] == 2
        assert overview["disabled"] == 1
        assert overview["expired"] == 1
        assert overview["idle"] == 2, "active keys never used (busy was used just now)"
        assert overview["lifetime_requests"] == 6, "from rollups, so older history counts"
        assert overview["lifetime_cost_usd"] >= 1.0
        assert overview["lifetime_tokens"] == 165 + 1000
        assert overview["by_key"][0]["name"] == "busy"
        assert overview["by_key"][0]["requests"] == 6


class TestProxyEnforcement:
    async def test_disallowed_model_is_refused_with_403_permission_error(self, require_key):
        await add_account("primary")
        calls: list[httpx.Request] = []
        async for client in make_client(ok_json(calls)):
            key = (await create(client, allowed_models=["claude-sonnet-4-5"]))["api_key"]
            refused = await client.post("/v1/messages", json=MESSAGE_BODY, headers={"x-api-key": key})
            allowed = await client.post(
                "/v1/messages",
                json={**MESSAGE_BODY, "model": "claude-sonnet-4-5-20250929"},
                headers={"x-api-key": key},
            )
            no_model = await client.get("/v1/models", headers={"x-api-key": key})

        assert refused.status_code == 403
        body = refused.json()
        assert body["type"] == "error"
        assert body["error"]["type"] == "permission_error"
        assert "claude-opus-5" in body["error"]["message"]
        assert allowed.status_code == 200
        assert no_model.status_code == 200, "requests that name no model are not model requests"
        assert len(calls) == 2, "the refused request never reached upstream"

    async def test_enforced_model_rewrites_the_request(self, require_key):
        await add_account("primary")
        calls: list[httpx.Request] = []
        async for client in make_client(ok_json(calls)):
            key = (
                await create(client, allowed_models=["claude-haiku-4-5"], enforced_model="claude-haiku-4-5")
            )["api_key"]
            response = await client.post("/v1/messages", json=MESSAGE_BODY, headers={"x-api-key": key})

        assert response.status_code == 200, "the allowlist is checked against the enforced model"
        sent = json.loads(calls[0].content)
        assert sent["model"] == "claude-haiku-4-5"
        assert sent["messages"] == MESSAGE_BODY["messages"]
        assert len(await get_logs()) == 1

    async def test_assigned_accounts_restrict_routing(self, require_key):
        first = await add_account("first", key="sk-ant-first")
        second = await add_account("second", key="sk-ant-second")
        third = await add_account("third", key="sk-ant-third")
        calls: list[httpx.Request] = []
        async for client in make_client(ok_json(calls)):
            key = (await create(client, assigned_account_ids=[second]))["api_key"]
            for _ in range(6):
                response = await client.post("/v1/messages", json=MESSAGE_BODY, headers={"x-api-key": key})
                assert response.status_code == 200
            # With the assigned account paused, the key must not spill onto the others.
            await client.patch(f"/api/accounts/{second}", json={"enabled": False})
            stranded = await client.post("/v1/messages", json=MESSAGE_BODY, headers={"x-api-key": key})

        assert {c.headers["x-api-key"] for c in calls} == {"sk-ant-second"}
        assert {log.account_id for log in await get_logs() if log.status_code == 200} == {second}
        assert stranded.status_code == 503
        assert first and third

    async def test_assigned_accounts_that_were_deleted_fail_closed(self, require_key):
        only = await add_account("only")
        await add_account("other")
        async for client in make_client(ok_json([])):
            key = (await create(client, assigned_account_ids=[only]))["api_key"]
            await client.delete(f"/api/accounts/{only}")
            response = await client.post("/v1/messages", json=MESSAGE_BODY, headers={"x-api-key": key})
        assert response.status_code == 503
        assert "assigned" in response.json()["error"]["message"]

    async def test_multi_rule_limit_trips_with_429_and_retry_after(self, require_key):
        await add_account("primary")
        async for client in make_client(ok_json([])):
            created = await create(
                client,
                limits=[
                    {"metric": "requests", "window": "5h", "max_value": 100},
                    {"metric": "output_tokens", "window": "daily", "max_value": 40},
                ],
            )
            key = created["api_key"]
            # Each upstream reply is 22 output tokens: two requests pass, the third trips.
            codes = [
                (await client.post("/v1/messages", json=MESSAGE_BODY, headers={"x-api-key": key})).status_code
                for _ in range(2)
            ]
            tripped = await client.post("/v1/messages", json=MESSAGE_BODY, headers={"x-api-key": key})

        assert codes == [200, 200]
        assert tripped.status_code == 429
        error = tripped.json()["error"]
        assert error["type"] == "rate_limit_error"
        assert "40 output tokens per UTC day" in error["message"]
        assert int(tripped.headers["retry-after"]) > 0

    async def test_model_filtered_rule_only_limits_that_model(self, require_key):
        await add_account("primary")
        async for client in make_client(ok_json([])):
            key = (
                await create(
                    client,
                    limits=[
                        {
                            "metric": "requests",
                            "window": "5h",
                            "max_value": 1,
                            "model_filter": "claude-opus-5",
                        }
                    ],
                )
            )["api_key"]
            first = await client.post("/v1/messages", json=MESSAGE_BODY, headers={"x-api-key": key})
            second = await client.post("/v1/messages", json=MESSAGE_BODY, headers={"x-api-key": key})
            other = await client.post(
                "/v1/messages", json={**MESSAGE_BODY, "model": "claude-haiku-4-5"}, headers={"x-api-key": key}
            )
        assert [first.status_code, second.status_code, other.status_code] == [200, 429, 200]

    async def test_request_rules_hold_against_a_burst(self, require_key):
        import asyncio

        await add_account("primary")

        async def slow_ok(request: httpx.Request) -> httpx.Response:
            await asyncio.sleep(0.2)
            return ok_json([])(request)

        async for client in make_client(slow_ok):
            key = (await create(client, limits=[{"metric": "requests", "window": "7d", "max_value": 2}]))[
                "api_key"
            ]
            responses = await asyncio.gather(
                *(
                    client.post("/v1/messages", json=MESSAGE_BODY, headers={"x-api-key": key})
                    for _ in range(8)
                )
            )
        assert sorted(r.status_code for r in responses) == [200] * 2 + [429] * 6
        assert key_service._inflight == {}


class TestWindows:
    def test_calendar_bounds(self):
        now = datetime(2026, 12, 31, 15, 0, tzinfo=UTC)  # a Thursday
        assert limits.calendar_bounds("daily", now) == (
            datetime(2026, 12, 31, tzinfo=UTC),
            datetime(2027, 1, 1, tzinfo=UTC),
        )
        assert limits.calendar_bounds("weekly", now) == (
            datetime(2026, 12, 28, tzinfo=UTC),
            datetime(2027, 1, 4, tzinfo=UTC),
        )
        assert limits.calendar_bounds("monthly", now) == (
            datetime(2026, 12, 1, tzinfo=UTC),
            datetime(2027, 1, 1, tzinfo=UTC),
        )

    def test_model_matching(self):
        assert limits.model_matches(None, None)
        assert limits.model_matches("claude-sonnet-4-5", "claude-sonnet-4-5")
        assert limits.model_matches("claude-sonnet-4-5", "claude-sonnet-4-5-20250929")
        assert not limits.model_matches("claude-sonnet-4", "claude-sonnet-45")
        assert not limits.model_matches("claude-sonnet-4-5", None)

    async def test_corrupt_restriction_fails_closed(self):
        async with session_scope() as session:
            issued = await key_service.create_api_key(session, name="x")
            issued.record.allowed_models_json = "not json"
        async with session_scope() as session:
            key = (await session.execute(select(ApiKey))).scalar_one()
            assert key.allowed_models == []
            with pytest.raises(key_service.AuthError):
                key_service.check_model_allowed(key, "claude-opus-5")


class TestUpgrade:
    async def test_old_api_keys_table_gains_the_new_columns_and_keeps_its_budget(self):
        """A key written by an older release keeps its single budget, now shown as rules."""
        from sqlalchemy import inspect, text

        from claude_lb.db import schema
        from claude_lb.db.session import get_engine

        engine = get_engine()
        async with engine.begin() as conn:
            await conn.execute(text("DROP TABLE IF EXISTS api_key_limit_rules"))
            for column in ("allowed_models_json", "enforced_model", "assigned_account_ids_json"):
                await conn.execute(text(f'ALTER TABLE api_keys DROP COLUMN "{column}"'))
            await conn.execute(
                text(
                    "INSERT INTO api_keys (id, name, key_hash, key_hint, enabled, max_requests_per_window,"
                    " window_seconds, total_requests, total_cost_usd, created_at)"
                    " VALUES ('old', 'old-key', 'hash', 'abcdef', TRUE, 5, 3600, 0, 0, '2026-01-01 00:00:00')"
                )
            )
        async with engine.begin() as conn:
            await conn.run_sync(ApiKey.metadata.create_all)
            await schema.reconcile(conn)
            columns = {c["name"] for c in await conn.run_sync(lambda c: inspect(c).get_columns("api_keys"))}
        assert {"allowed_models_json", "enforced_model", "assigned_account_ids_json"} <= columns

        async for client in make_client(ok_json([])):
            [key] = (await client.get("/api/keys")).json()
        assert key["allowed_models"] is None and key["assigned_account_ids"] is None
        assert [(r["source"], r["metric"], r["max_value"]) for r in key["limits"]] == [
            ("legacy", "requests", 5)
        ]
