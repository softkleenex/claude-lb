"""Regression tests for the 2026-11-27 security review findings.

Each class is one finding. Most tests failed before the fix; the rest guard behaviour
the fix had to keep (request-count limits still allow batches, keys without a model
policy still relay odd bodies, model-less endpoints still work).
"""

from __future__ import annotations

import gzip
import json
import logging
import random
from datetime import timedelta

import httpx
import pytest
from sqlalchemy import select

from claude_lb.core.config import get_settings
from claude_lb.db.models import AuditEvent, AutomationJob, AutomationRun
from claude_lb.db.session import session_scope
from claude_lb.modules.api_keys import limits
from claude_lb.modules.automations import service as automations
from claude_lb.modules.firewall import service as fw
from claude_lb.modules.proxy.load_balancer import PAUSED_REASON
from claude_lb.modules.proxy.service import ProxyService, UpstreamExhausted
from tests.test_auth import PASSWORD
from tests.test_automations import add_job, utc
from tests.test_guest_role import admin_with_guest
from tests.test_proxy_api import add_account, get_account, make_client, ok_json


@pytest.fixture
def require_key(monkeypatch):
    monkeypatch.setattr(get_settings(), "require_api_key", True)


def echo_model(calls: list[httpx.Request]):
    """An upstream that answers with the model it was asked for (so the log row has it)."""

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        try:
            model = json.loads(request.content).get("model", "claude-haiku-4-5")
        except ValueError:
            model = "claude-haiku-4-5"
        return httpx.Response(
            200,
            json={"id": "msg_1", "model": model, "usage": {"input_tokens": 1, "output_tokens": 1}},
        )

    return handler


def batch_body(*models: str) -> dict:
    return {
        "requests": [
            {
                "custom_id": f"r{i}",
                "params": {"model": m, "max_tokens": 16, "messages": [{"role": "user", "content": "hi"}]},
            }
            for i, m in enumerate(models)
        ]
    }


async def new_key(client: httpx.AsyncClient, name: str = "k", **policy) -> str:
    response = await client.post("/api/keys", json={"name": name, **policy})
    assert response.status_code == 201, response.text
    return response.json()["api_key"]


# ---- 1. batches and other model-bearing endpoints obey the key's model policy ----------


class TestBatchModelPolicy:
    async def test_batch_entries_must_pass_the_allowlist(self, require_key):
        await add_account("a1")
        calls: list[httpx.Request] = []
        async for client in make_client(ok_json(calls)):
            key = await new_key(client, allowed_models=["claude-haiku-4-5"])
            refused = await client.post(
                "/v1/messages/batches",
                headers={"x-api-key": key},
                json=batch_body("claude-haiku-4-5", "claude-opus-4-1"),
            )
            allowed = await client.post(
                "/v1/messages/batches", headers={"x-api-key": key}, json=batch_body("claude-haiku-4-5")
            )
        assert refused.status_code == 403
        assert refused.json()["error"]["type"] == "permission_error"
        assert "claude-opus-4-1" in refused.json()["error"]["message"]
        assert allowed.status_code == 200
        assert len(calls) == 1

    async def test_enforced_model_rewrites_every_batch_entry(self, require_key):
        await add_account("a1")
        calls: list[httpx.Request] = []
        async for client in make_client(ok_json(calls)):
            key = await new_key(client, enforced_model="claude-haiku-4-5")
            r = await client.post(
                "/v1/messages/batches",
                headers={"x-api-key": key},
                json=batch_body("claude-opus-4-1", "claude-sonnet-4-5"),
            )
        assert r.status_code == 200
        sent = json.loads(calls[0].content)
        assert [e["params"]["model"] for e in sent["requests"]] == ["claude-haiku-4-5", "claude-haiku-4-5"]

    @pytest.mark.parametrize(
        "policy",
        [
            {"limits": [{"metric": "cost_usd", "window": "daily", "max_value": 5}]},
            {"limits": [{"metric": "output_tokens", "window": "5h", "max_value": 1000}]},
            {"max_tokens_per_window": 1000},
            {"max_cost_usd_per_window": 1.0},
        ],
    )
    async def test_metered_keys_cannot_create_batches(self, require_key, policy):
        await add_account("a1")
        calls: list[httpx.Request] = []
        async for client in make_client(ok_json(calls)):
            key = await new_key(client, **policy)
            r = await client.post(
                "/v1/messages/batches", headers={"x-api-key": key}, json=batch_body("claude-haiku-4-5")
            )
            # Ordinary messages are still metered and allowed.
            ok = await client.post(
                "/v1/messages",
                headers={"x-api-key": key},
                json={"model": "claude-haiku-4-5", "max_tokens": 5, "messages": []},
            )
        assert r.status_code == 403
        assert r.json()["error"]["type"] == "permission_error"
        assert "batch" in r.json()["error"]["message"]
        assert ok.status_code == 200
        assert [c.url.path for c in calls] == ["/v1/messages"]

    async def test_request_count_limits_still_allow_batches(self, require_key):
        await add_account("a1")
        calls: list[httpx.Request] = []
        async for client in make_client(ok_json(calls)):
            key = await new_key(client, limits=[{"metric": "requests", "window": "5h", "max_value": 10}])
            r = await client.post(
                "/v1/messages/batches", headers={"x-api-key": key}, json=batch_body("claude-haiku-4-5")
            )
        assert r.status_code == 200 and len(calls) == 1

    @pytest.mark.parametrize(
        ("path", "content", "headers"),
        [
            (
                "/v1/messages",
                gzip.compress(b'{"model":"claude-opus-4-1","max_tokens":5,"messages":[]}'),
                {"content-encoding": "gzip"},
            ),
            ("/v1/messages", b'\xef\xbb\xbf{"model":"claude-opus-4-1","max_tokens":5,"messages":[]}', {}),
            ("/v1/messages", b'{"model":"claude-haiku-4-5","model":"claude-opus-4-1","max_tokens":5}', {}),
            ("/v1/messages", b'{"model":["claude-opus-4-1"],"max_tokens":5}', {}),
            ("/v1/messages", b"not json", {}),
            ("/v1/messages/batches", b'{"requests":[{"custom_id":"x","params":{"max_tokens":5}}]}', {}),
            ("/v1/messages/batches", b'{"requests":{"x":1}}', {}),
            (
                "/v1/messages/batches",
                b'{"requests":[{"custom_id":"x","params":{"model":"claude-haiku-4-5",'
                b'"model":"claude-opus-4-1"}}]}',
                {},
            ),
        ],
    )
    async def test_unreadable_bodies_fail_closed_for_keys_with_model_policy(
        self, require_key, path, content, headers
    ):
        await add_account("a1")
        calls: list[httpx.Request] = []
        async for client in make_client(ok_json(calls)):
            key = await new_key(client, allowed_models=["claude-haiku-4-5"])
            r = await client.post(
                path,
                content=content,
                headers={"x-api-key": key, "content-type": "application/json", **headers},
            )
        assert r.status_code == 400, r.text
        assert "model policy" in r.json()["error"]["message"]
        assert calls == []

    async def test_keys_without_model_policy_still_relay_odd_bodies(self, require_key):
        await add_account("a1")
        calls: list[httpx.Request] = []
        async for client in make_client(ok_json(calls)):
            key = await new_key(client)
            r = await client.post(
                "/v1/messages",
                content=b"\xef\xbb\xbf{}",
                headers={"x-api-key": key, "content-type": "application/json"},
            )
        assert r.status_code == 200 and len(calls) == 1

    async def test_count_tokens_obeys_allowlist_and_enforced_model(self, require_key):
        await add_account("a1")
        calls: list[httpx.Request] = []
        body = {"model": "claude-opus-4-1", "messages": [{"role": "user", "content": "hi"}]}
        async for client in make_client(ok_json(calls)):
            limited = await new_key(client, allowed_models=["claude-haiku-4-5"])
            forced = await new_key(client, "forced", enforced_model="claude-haiku-4-5")
            refused = await client.post(
                "/v1/messages/count_tokens", headers={"x-api-key": limited}, json=body
            )
            rewritten = await client.post(
                "/v1/messages/count_tokens", headers={"x-api-key": forced}, json=body
            )
        assert refused.status_code == 403
        assert rewritten.status_code == 200
        assert json.loads(calls[0].content)["model"] == "claude-haiku-4-5"

    async def test_model_less_endpoints_still_work_for_policy_keys(self, require_key):
        await add_account("a1")
        calls: list[httpx.Request] = []
        async for client in make_client(ok_json(calls)):
            key = await new_key(client, allowed_models=["claude-haiku-4-5"])
            models = await client.get("/v1/models", headers={"x-api-key": key})
            batch = await client.get("/v1/messages/batches/msgbatch_1", headers={"x-api-key": key})
        assert models.status_code == 200 and batch.status_code == 200

    @pytest.mark.parametrize(
        "path", ["/v1/messages/./batches", "/v1/messages//batches", "/v1/messages/count_tokens/../batches"]
    )
    async def test_dot_and_empty_segments_are_not_proxied(self, require_key, path):
        await add_account("a1")
        calls: list[httpx.Request] = []
        async for client in make_client(ok_json(calls)):
            key = await new_key(client, allowed_models=["claude-haiku-4-5"])
            r = await client.post(path, headers={"x-api-key": key}, json=batch_body("claude-opus-4-1"))
        assert r.status_code in (403, 404)
        assert calls == []


# ---- 2. out-of-credit detection needs Anthropic's exact wording -------------------------


def error_400(message: str, error_type: str = "invalid_request_error"):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"type": "error", "error": {"type": error_type, "message": message}})

    return handler


class TestBillingDetection:
    async def test_echoed_billing_phrase_does_not_disable_accounts(self):
        ids = [await add_account(f"a{i}") for i in range(3)]

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            extra = next(k for k in body if k not in ("model", "max_tokens", "messages"))
            return error_400(f"{extra}: Extra inputs are not permitted")(request)

        async for client in make_client(handler):
            r = await client.post(
                "/v1/messages",
                json={
                    "model": "claude-haiku-4-5",
                    "max_tokens": 5,
                    "messages": [],
                    "Your credit balance is too low to access the Anthropic API": 1,
                },
            )
        assert r.status_code == 400
        assert [(await get_account(i)).enabled for i in ids] == [True, True, True]

    @pytest.mark.parametrize(
        ("message", "error_type"),
        [
            (
                "Your credit balance is too low to access the Anthropic API. "
                "Please go to Plans & Billing to upgrade or purchase credits. (echo)",
                "invalid_request_error",
            ),
            (
                "x: You have reached your specified API usage limits. You will regain access on y.",
                "invalid_request_error",
            ),
            (
                "Your credit balance is too low to access the Anthropic API. "
                "Please go to Plans & Billing to upgrade or purchase credits.",
                "api_error",
            ),
        ],
    )
    async def test_near_misses_are_ordinary_400s(self, message, error_type):
        account_id = await add_account("a1")
        async for client in make_client(error_400(message, error_type)):
            r = await client.post(
                "/v1/messages", json={"model": "claude-haiku-4-5", "max_tokens": 5, "messages": []}
            )
        assert r.status_code == 400
        assert (await get_account(account_id)).enabled

    async def test_usage_limit_wording_still_disables(self):
        account_id = await add_account("a1")
        message = (
            "You have reached your specified API usage limits. "
            "You will regain access on 2026-12-01 at 00:00 UTC."
        )
        async for client in make_client(error_400(message)):
            await client.post(
                "/v1/messages", json={"model": "claude-haiku-4-5", "max_tokens": 5, "messages": []}
            )
        account = await get_account(account_id)
        assert not account.enabled and account.disabled_reason == "upstream account is out of credit"


# ---- 3. automation changes reach runs that are already planned --------------------------


async def all_runs() -> list[AutomationRun]:
    async with session_scope() as session:
        result = await session.execute(select(AutomationRun).order_by(AutomationRun.account_name))
        return list(result.scalars())


SLOT = utc(2026, 11, 30, 7, 0)


async def plan_spread_cycle(calls: list[httpx.Request], **job_fields) -> str:
    job_id = await add_job(spread_minutes=120, **job_fields)
    client = httpx.AsyncClient(transport=httpx.MockTransport(ok_json(calls)))
    await automations.tick(client, now=SLOT + timedelta(seconds=1), rng=random.Random(1))
    assert calls == [], "the spread pushes every run past the first tick"
    assert {r.status for r in await all_runs()} == {"pending"}
    return job_id


class TestAutomationChanges:
    async def test_disabled_job_does_not_send_planned_runs(self):
        await add_account("a1")
        await add_account("a2")
        calls: list[httpx.Request] = []
        job_id = await plan_spread_cycle(calls)

        async with session_scope() as session:
            (await session.get(AutomationJob, job_id)).enabled = False
        client = httpx.AsyncClient(transport=httpx.MockTransport(ok_json(calls)))
        for run in await all_runs():
            due = run.scheduled_for.replace(tzinfo=SLOT.tzinfo)
            await automations.tick(client, now=due + timedelta(seconds=1))
        assert calls == []
        assert all(r.status == "skipped" and "disabled" in r.error for r in await all_runs())

    async def test_disabling_or_rescheduling_cancels_pending_runs(self):
        await add_account("a1")
        calls: list[httpx.Request] = []
        job_id = await plan_spread_cycle(calls)
        async for client in make_client(ok_json(calls)):
            r = await client.patch(
                f"/api/automations/{job_id}", json={"schedule": {"time": "08:00", "spread_minutes": 120}}
            )
            assert r.status_code == 200
            assert [(x.status, x.error) for x in await all_runs()] == [
                ("skipped", "cancelled: the schedule changed")
            ]
        assert calls == []

        async with session_scope() as session:
            for run in (await session.execute(select(AutomationRun))).scalars():
                await session.delete(run)
        job_id2 = await plan_spread_cycle(calls, name="second")
        async for client in make_client(ok_json(calls)):
            assert (
                await client.patch(f"/api/automations/{job_id2}", json={"enabled": False})
            ).status_code == 200
        assert [(x.status, x.error) for x in await all_runs()] == [
            ("skipped", "cancelled: the automation was disabled")
        ]

    async def test_dropped_target_is_cancelled_and_others_stay(self):
        a = await add_account("a1")
        b = await add_account("a2")
        calls: list[httpx.Request] = []
        job_id = await plan_spread_cycle(calls, account_ids=[a, b])
        async for client in make_client(ok_json(calls)):
            assert (
                await client.patch(f"/api/automations/{job_id}", json={"account_ids": [a]})
            ).status_code == 200
        by_name = {r.account_name: r for r in await all_runs()}
        assert by_name["a1"].status == "pending"
        assert by_name["a2"].status == "skipped" and "no longer a target" in by_name["a2"].error


# ---- 4. a forced (paused-included) automation still respects caps and breakers ----------


class TestForcedAutomation:
    async def test_paused_included_account_over_its_spend_cap_is_skipped(self):
        await add_account(
            "a1", enabled=False, disabled_reason=PAUSED_REASON, spend_cap_usd=1.0, total_cost_usd=50.0
        )
        await add_job(include_paused_accounts=True)
        calls: list[httpx.Request] = []
        client = httpx.AsyncClient(transport=httpx.MockTransport(ok_json(calls)))
        await automations.tick(client, now=utc(2026, 11, 26, 7, 0, 30))
        assert calls == []
        (run,) = await all_runs()
        assert run.status == "skipped" and "spend cap" in run.error

    async def test_forced_send_refuses_capped_and_breaker_disabled_accounts(self):
        broken = await add_account("broken", enabled=False, disabled_reason="out of credit")
        capped = await add_account(
            "capped", enabled=False, disabled_reason=PAUSED_REASON, spend_cap_usd=1.0, total_cost_usd=2.0
        )
        calls: list[httpx.Request] = []
        client = httpx.AsyncClient(transport=httpx.MockTransport(ok_json(calls)))
        body = json.dumps({"model": "claude-haiku-4-5", "max_tokens": 1, "messages": []}).encode()
        for account_id, expected in ((broken, "disabled"), (capped, "spend cap")):
            with pytest.raises(UpstreamExhausted, match=expected):
                await ProxyService(client).forward(
                    method="POST",
                    path="/v1/messages",
                    query="",
                    headers={},
                    body=body,
                    api_key=None,
                    pin_account_id=account_id,
                    force_account=True,
                )
        assert calls == []


# ---- 5. "no account available" does not describe the pool to API-key holders ----------


class TestUnavailableMessage:
    async def test_503_is_generic_and_details_go_to_the_log(self, caplog):
        await add_account("secret-console", spend_cap_usd=1.23, total_cost_usd=5.0)
        await add_account(
            "secret-sub", enabled=False, disabled_reason="token endpoint said: invalid_grant for user@x"
        )
        caplog.set_level(logging.INFO, logger="claude_lb.modules.proxy.service")
        async for client in make_client(ok_json([])):
            r = await client.post(
                "/v1/messages", json={"model": "claude-haiku-4-5", "max_tokens": 5, "messages": []}
            )
        assert r.status_code == 503
        text = r.text
        for leak in ("secret-console", "secret-sub", "1.23", "invalid_grant", "user@x"):
            assert leak not in text
        assert "1 at spend cap" in text and "1 disabled" in text
        assert "secret-console" in caplog.text and "invalid_grant" in caplog.text


# ---- 6. a bad job or an overlong error cannot break the scheduler -----------------------


class TestAutomationRobustness:
    async def test_unknown_timezone_does_not_stop_other_jobs(self):
        await add_account("a1")
        await add_job(name="broken", schedule_timezone="Nowhere/Gone")
        await add_job(name="fine")
        calls: list[httpx.Request] = []
        client = httpx.AsyncClient(transport=httpx.MockTransport(ok_json(calls)))
        await automations.tick(client, now=SLOT + timedelta(seconds=30))
        assert [r.job_name for r in await all_runs()] == ["fine"]
        assert len(calls) == 1
        async for api in make_client(ok_json([])):
            assert (await api.get("/api/automations")).status_code == 200

    async def test_long_error_text_is_clipped_to_the_column(self):
        await add_account("a1")
        await add_job()

        def crash(request: httpx.Request) -> httpx.Response:
            raise RuntimeError("boom " * 400)

        client = httpx.AsyncClient(transport=httpx.MockTransport(crash))
        await automations.tick(client, now=SLOT + timedelta(seconds=30))
        (run,) = await all_runs()
        assert run.status == "failed" and len(run.error) <= 512


# ---- 7. firewall cache is dropped after the change commits ------------------------------


class TestFirewallCache:
    async def test_rules_loaded_before_commit_do_not_stick(self):
        async with session_scope() as session:
            await fw.set_mode(session, "allowlist")
        async with session_scope() as session:
            assert (await fw.load_rules(session)).networks == ()
        async with session_scope() as writer:
            await fw.add_entry(writer, "10.0.0.0/8")
            # Another request reloads the rules before the change commits.
            async with session_scope() as reader:
                assert (await fw.load_rules(reader)).networks == ()
        async with session_scope() as session:
            assert len((await fw.load_rules(session)).networks) == 1


# ---- 8. guests do not see firewall addresses --------------------------------------------


class TestGuestFirewallPrivacy:
    async def test_guest_sees_no_firewall_addresses(self):
        address = "198.51.100.23"
        async for client in make_client(ok_json([])):
            await admin_with_guest(client)
            await client.post("/api/auth/login", json={"password": PASSWORD})
            added = await client.post(
                "/api/firewall/entries", json={"network": address, "note": "alice laptop"}
            )
            assert added.status_code == 201
            admin_view = (await client.get("/api/firewall")).json()
            assert admin_view["entries"][0]["network"] == address
            client.cookies.clear()
            assert (await client.post("/api/auth/guest/login", json={})).status_code == 200
            seen = {
                "firewall": (await client.get("/api/firewall")).json(),
                "audit": (await client.get("/api/audit/events")).json(),
                "audit_legacy": (await client.get("/api/audit")).json(),
                "search": (await client.get("/api/audit/events", params={"search": address})).json(),
                "search_note": (await client.get("/api/audit/events", params={"search": "alice"})).json(),
                "target": (await client.get("/api/audit/events", params={"target": address})).json(),
            }
        blob = repr(seen)
        assert address not in blob and "alice" not in blob
        assert seen["firewall"]["entries"][0]["network"] == "hidden"
        assert seen["search"]["total"] == 0 and seen["search_note"]["total"] == 0
        assert seen["target"]["total"] == 0
        assert any(e["action"] == "firewall.entry_added" for e in seen["audit"]["events"])
        async with session_scope() as session:
            stored = (
                await session.execute(select(AuditEvent).where(AuditEvent.action == "firewall.entry_added"))
            ).scalar_one()
        assert stored.target == address, "the record itself is untouched"


# ---- 9. model-filtered rules match aliases and dated snapshots both ways ---------------


class TestModelAliases:
    @pytest.mark.parametrize(
        ("rule", "model"),
        [
            ("claude-opus-4-1", "claude-opus-4-1-20250805"),
            ("claude-opus-4-1-20250805", "claude-opus-4-1"),
            ("claude-opus-4-1-latest", "claude-opus-4-1-20250805"),
            ("claude-opus-4-1-20250805", "claude-opus-4-1-latest"),
        ],
    )
    def test_alias_and_snapshot_match_both_ways(self, rule, model):
        assert limits.model_matches(rule, model)

    def test_other_families_still_do_not_match(self):
        assert not limits.model_matches("claude-opus-4-1-20250805", "claude-opus-4")
        assert not limits.model_matches("claude-sonnet-4", "claude-sonnet-45")

    async def test_dated_rule_limits_requests_for_the_alias(self, require_key):
        await add_account("a1")
        calls: list[httpx.Request] = []
        async for client in make_client(echo_model(calls)):
            key = await new_key(
                client,
                limits=[
                    {
                        "metric": "requests",
                        "window": "5h",
                        "max_value": 1,
                        "model_filter": "claude-opus-4-1-20250805",
                    }
                ],
            )
            body = {"model": "claude-opus-4-1", "max_tokens": 5, "messages": []}
            first = await client.post("/v1/messages", headers={"x-api-key": key}, json=body)
            second = await client.post("/v1/messages", headers={"x-api-key": key}, json=body)
        assert [first.status_code, second.status_code] == [200, 429]

    async def test_allowlisted_alias_admits_its_snapshot(self, require_key):
        await add_account("a1")
        async for client in make_client(ok_json([])):
            key = await new_key(client, allowed_models=["claude-opus-4-1-20250805"])
            r = await client.post(
                "/v1/messages",
                headers={"x-api-key": key},
                json={"model": "claude-opus-4-1", "max_tokens": 5, "messages": []},
            )
        assert r.status_code == 200
