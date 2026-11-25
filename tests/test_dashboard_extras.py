"""Conversations, paged audit log, model catalog page, and the sticky-session browser."""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime, timedelta

import pytest

from claude_lb.db.models import Account, AuditEvent, ModelCatalogEntry
from claude_lb.db.session import session_scope
from claude_lb.modules.proxy import sticky
from tests.test_dashboard_api import add_key, add_log
from tests.test_proxy_api import add_account, make_client, ok_json


def now() -> datetime:
    return datetime.now(UTC)


class TestConversations:
    async def test_groups_by_session_key_with_facets_and_paging(self):
        alpha = await add_account("alpha")
        beta = await add_account("beta")
        key = await add_key("team")
        t = now()
        await add_log(t - timedelta(minutes=50), account_id=alpha, api_key_id=key, session_key="conv-a")
        await add_log(
            t - timedelta(minutes=10),
            account_id=beta,
            api_key_id=key,
            session_key="conv-a",
            model="claude-haiku-5-5",
            cache_read_input_tokens=1000,
            cost_usd=0.02,
        )
        await add_log(
            t - timedelta(minutes=5), account_id=alpha, session_key="conv-a", status_code=529, error="x"
        )
        await add_log(t - timedelta(minutes=20), account_id=beta, session_key="conv-b")
        await add_log(t - timedelta(days=3), account_id=alpha, session_key="conv-old")
        await add_log(t - timedelta(minutes=1), account_id=alpha)  # no conversation

        async for client in make_client(ok_json([])):
            body = (await client.get("/api/conversations?timeframe=24h")).json()
            assert body["total"] == 2 and body["has_more"] is False
            first, second = body["conversations"]
            assert first["session_key"] == "conv-a", "most recent activity first"
            assert second["session_key"] == "conv-b"
            assert first["requests"] == 3 and first["errors"] == 1
            assert first["duration_ms"] == pytest.approx(45 * 60 * 1000, abs=2000)
            assert first["cost_usd"] == pytest.approx(0.04)
            assert first["cache_read_input_tokens"] == 1000
            assert first["total_tokens"] == 3 * 150 + 1000
            assert [a["name"] for a in first["accounts"]] == ["alpha", "beta"], "most requests first"
            assert first["api_keys"] == [{"id": key, "name": "team"}]
            assert first["models"] == ["claude-opus-5-5", "claude-haiku-5-5"]

            everything = (await client.get("/api/conversations")).json()
            assert everything["total"] == 3

            paged = (await client.get("/api/conversations?limit=1&offset=1")).json()
            assert paged["total"] == 3 and paged["has_more"] is True
            assert [c["session_key"] for c in paged["conversations"]] == ["conv-b"]

            by_model = (await client.get("/api/conversations?search=haiku")).json()
            assert [c["session_key"] for c in by_model["conversations"]] == ["conv-a"]
            # facets still cover the whole conversation, not just the matching request
            assert by_model["conversations"][0]["requests"] == 3

            by_account = (await client.get("/api/conversations?search=beta")).json()
            assert {c["session_key"] for c in by_account["conversations"]} == {"conv-a", "conv-b"}

            literal = (await client.get("/api/conversations?search=%25")).json()
            assert literal["total"] == 0, "LIKE wildcards are escaped"

            bad = await client.get("/api/conversations?timeframe=2y")
            assert bad.status_code == 422

    async def test_detail_has_models_accounts_agent_and_timeline(self):
        alpha = await add_account("alpha", plan_type="max_5x")
        beta = await add_account("beta")
        t = now()
        for minutes, account, model, agent in [
            (30, alpha, "claude-opus-5-5", "claude-cli/2.1 (external)"),
            (20, alpha, "claude-opus-5-5", "claude-cli/2.2"),
            (10, beta, "claude-haiku-5-5", "python-httpx/0.28"),
        ]:
            await add_log(
                t - timedelta(minutes=minutes),
                account_id=account,
                model=model,
                session_key="conv-x",
                user_agent=agent,
                duration_ms=1000,
            )

        async for client in make_client(ok_json([])):
            detail = (await client.get("/api/conversations/conv-x")).json()
            missing = await client.get("/api/conversations/nope")

        assert missing.status_code == 404
        assert detail["requests"] == 3 and detail["account_count"] == 2
        assert detail["accounts"][0] == {"id": alpha, "name": "alpha", "plan_type": "max_5x", "requests": 2}
        assert detail["dominant_user_agent_family"] == "claude-cli"
        assert detail["dominant_user_agent"] in {"claude-cli/2.1 (external)", "claude-cli/2.2"}
        assert detail["busy_ms"] == 3000
        assert detail["duration_ms"] == pytest.approx(20 * 60 * 1000, abs=2000)
        assert [m["model"] for m in detail["models"]] == ["claude-opus-5-5", "claude-haiku-5-5"]
        assert detail["models"][0]["requests"] == 2 and detail["models"][0]["duration_ms"] == 2000
        assert len(detail["timeline"]) == 3 and detail["timeline_truncated"] is False
        assert detail["timeline"][0]["account_name"] == "beta", "newest first"


async def add_event(created_at: datetime, action: str, **fields) -> None:
    async with session_scope() as session:
        session.add(AuditEvent(created_at=created_at, action=action, **fields))


class TestAuditPage:
    async def test_filters_paging_and_actions(self):
        t = now()
        await add_event(t - timedelta(minutes=5), "account.created", target="alpha", client_ip="10.0.0.1")
        await add_event(t - timedelta(minutes=4), "account.updated", target="alpha", detail="weight")
        await add_event(t - timedelta(minutes=3), "auth.login", ok=False, detail="bad password")
        await add_event(t - timedelta(days=2), "api_key.created", target="team_1")

        async for client in make_client(ok_json([])):
            page = (await client.get("/api/audit/events?limit=2")).json()
            assert page["total"] == 4 and page["has_more"] is True
            assert [e["action"] for e in page["events"]] == ["auth.login", "account.updated"]

            day = (await client.get("/api/audit/events?timeframe=24h")).json()
            assert day["total"] == 3

            two = (await client.get("/api/audit/events?action=account.created&action=auth.login")).json()
            assert {e["action"] for e in two["events"]} == {"account.created", "auth.login"}

            target = (await client.get("/api/audit/events?target=alpha")).json()
            assert target["total"] == 2

            failed = (await client.get("/api/audit/events?ok=false")).json()
            assert [e["action"] for e in failed["events"]] == ["auth.login"]

            search = (await client.get("/api/audit/events?search=10.0.0")).json()
            assert [e["action"] for e in search["events"]] == ["account.created"]

            underscore = (await client.get("/api/audit/events?search=_1")).json()
            assert [e["target"] for e in underscore["events"]] == ["team_1"], "_ is literal"

            since = (t - timedelta(days=3)).isoformat()
            until = (t - timedelta(days=1)).isoformat()
            ranged = (await client.get("/api/audit/events", params={"since": since, "until": until})).json()
            assert [e["action"] for e in ranged["events"]] == ["api_key.created"]

            actions = (await client.get("/api/audit/actions")).json()
            assert {a["action"]: a["count"] for a in actions} == {
                "account.created": 1,
                "account.updated": 1,
                "api_key.created": 1,
                "auth.login": 1,
            }

            legacy = (await client.get("/api/audit?limit=2")).json()
            assert isinstance(legacy, list) and len(legacy) == 2

            assert (await client.get("/api/audit/events?timeframe=2y")).status_code == 422


class TestCatalogPage:
    async def test_models_prices_blocks_and_accounts(self):
        alpha = await add_account("alpha", plan_type="max_5x")
        beta = await add_account("beta")
        synced = now()
        async with session_scope() as session:
            for account_id in (alpha, beta):
                session.add(
                    ModelCatalogEntry(
                        account_id=account_id,
                        model_id="claude-haiku-5-5-20260101",
                        display_name="Claude Haiku 5.5",
                        max_input_tokens=200_000,
                        max_output_tokens=64_000,
                        synced_at=synced,
                    )
                )
            session.add(ModelCatalogEntry(account_id=alpha, model_id="claude-mystery-1", synced_at=synced))
            account = await session.get(Account, alpha)
            account.models_synced_at = synced
            account.model_blocks_json = json.dumps(
                {"claude-opus-5-5": time.time() + 3600, "claude-sonnet-5-5": time.time() - 10}
            )

        async for client in make_client(ok_json([])):
            body = (await client.get("/api/health/catalog")).json()

        haiku, mystery = body["models"]
        assert haiku["model_id"] == "claude-haiku-5-5-20260101"
        assert [a["name"] for a in haiku["accounts"]] == ["alpha", "beta"]
        assert haiku["max_input_tokens"] == 200_000 and haiku["max_output_tokens"] == 64_000
        assert haiku["price_key"] == "claude-haiku-5-5"
        assert haiku["price"]["input"] == pytest.approx(0.10)
        assert haiku["price"]["cache_write_5m"] == pytest.approx(0.125)
        assert haiku["price"]["long_context_threshold"] == 100_000
        assert haiku["price"]["long_context"]["input"] == pytest.approx(0.50)
        assert mystery["price"] is None and mystery["price_key"] is None

        prices = {row["model"]: row["price"] for row in body["prices"]}
        assert prices["claude-opus-5-5"]["cache_read"] == pytest.approx(0.20)
        assert prices["claude-sonnet-4-5"]["cache_read"] == pytest.approx(0.30), "0.1x input by default"

        assert body["blocks"] == [
            {
                "account_id": alpha,
                "account_name": "alpha",
                "plan_type": "max_5x",
                "model": "claude-opus-5-5",
                "until": body["blocks"][0]["until"],
            }
        ], "expired blocks are not shown"
        counts = {a["name"]: a["models"] for a in body["accounts"]}
        assert counts == {"alpha": 2, "beta": 1}
        assert body["last_synced_at"] is not None


class TestStickySessions:
    @pytest.fixture(autouse=True)
    def clean_map(self):
        sticky.clear()
        yield
        sticky.clear()

    async def test_list_filter_delete_and_purge(self):
        alpha = await add_account("alpha")
        beta = await add_account("beta")
        base = time.monotonic()
        sticky.remember("k-expired", alpha, ttl_seconds=1, now=base - 10)
        sticky.remember("k-alpha", alpha, ttl_seconds=600, now=base)
        sticky.remember("k-beta-1", beta, ttl_seconds=600, now=base)
        sticky.remember("k-beta-2", beta, ttl_seconds=600, now=base)

        async for client in make_client(ok_json([])):
            body = (await client.get("/api/sticky-sessions")).json()
            assert body["total"] == 4 and body["size"] == 4 and body["expired_count"] == 1
            assert body["entries"][0]["key"] == "k-beta-2", "most recently used first"
            assert body["entries"][0]["account_name"] == "beta"
            assert 590 <= body["entries"][0]["remaining_seconds"] <= 600
            expired = next(e for e in body["entries"] if e["key"] == "k-expired")
            assert expired["expired"] is True and expired["remaining_seconds"] == 0
            assert body["enabled"] is True and body["ttl_seconds"] == 900
            assert {c["account_name"]: c["entries"] for c in body["by_account"]} == {"alpha": 2, "beta": 2}

            only_beta = (await client.get(f"/api/sticky-sessions?account_id={beta}")).json()
            assert only_beta["total"] == 2
            live = (await client.get("/api/sticky-sessions?include_expired=false")).json()
            assert live["total"] == 3
            paged = (await client.get("/api/sticky-sessions?limit=1&offset=1")).json()
            assert paged["has_more"] is True and [e["key"] for e in paged["entries"]] == ["k-beta-1"]
            searched = (await client.get("/api/sticky-sessions?search=ALPHA")).json()
            assert [e["key"] for e in searched["entries"]] == ["k-alpha"]

            assert (await client.delete("/api/sticky-sessions/k-alpha")).status_code == 204
            assert (await client.delete("/api/sticky-sessions/k-alpha")).status_code == 404

            many = await client.post("/api/sticky-sessions/delete", json={"keys": ["k-beta-1", "nope"]})
            assert many.json() == {"deleted_count": 1}
            assert (await client.post("/api/sticky-sessions/delete", json={"keys": []})).status_code == 422

            purged = await client.post("/api/sticky-sessions/purge")
            assert purged.json() == {"deleted_count": 1}

            cleared = await client.post("/api/sticky-sessions/delete-account", json={"account_id": beta})
            assert cleared.json() == {"deleted_count": 1}
            assert sticky.size() == 0

            audit = (await client.get("/api/audit/events?search=sticky")).json()
            actions = sorted(e["action"] for e in audit["events"])
            assert actions == [
                "sticky.account_cleared",
                "sticky.deleted",
                "sticky.deleted",
                "sticky.purged",
            ]
            cleared_event = next(e for e in audit["events"] if e["action"] == "sticky.account_cleared")
            assert cleared_event["target"] == "beta"

    async def test_management_auth_guards_the_new_endpoints(self):
        from claude_lb.modules.auth import service as auth_service

        async with session_scope() as session:
            await auth_service.set_password(session, "correct horse battery")
        async for client in make_client(ok_json([])):
            paths = ("/api/sticky-sessions", "/api/conversations", "/api/audit/events", "/api/health/catalog")
            for path in paths:
                assert (await client.get(path)).status_code == 401, path
            assert (await client.post("/api/sticky-sessions/purge")).status_code == 401
