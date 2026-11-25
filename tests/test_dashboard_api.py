"""Dashboard overview, projections, request logs, and the new RequestLog columns."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import inspect, text

from claude_lb.db.models import ApiKey, QuotaHistory, RequestLog
from claude_lb.db.session import get_engine, init_db, session_scope
from claude_lb.modules.dashboard import pace
from claude_lb.modules.proxy import sticky
from claude_lb.modules.request_logs.service import status_category
from tests.test_proxy_api import MESSAGE_BODY, SSE_BODY, add_account, get_logs, make_client, ok_json


async def add_log(created_at: datetime, **fields) -> str:
    defaults = {
        "path": "/v1/messages",
        "model": "claude-opus-5-5",
        "status_code": 200,
        "input_tokens": 100,
        "output_tokens": 50,
        "cost_usd": 0.01,
    }
    async with session_scope() as session:
        row = RequestLog(created_at=created_at, **(defaults | fields))
        session.add(row)
        await session.flush()
        return row.id


async def add_key(name: str) -> str:
    async with session_scope() as session:
        key = ApiKey(name=name, key_hash=name * 4, key_hint=f"clb-…{name[:4]}")
        session.add(key)
        await session.flush()
        return key.id


def now() -> datetime:
    return datetime.now(UTC)


class TestRecordedColumns:
    async def test_non_streaming_request_logs_conversation_agent_and_ip(self, proxy_calls):
        await add_account("primary")
        async for client in make_client(ok_json(proxy_calls)):
            await client.post("/v1/messages", json=MESSAGE_BODY, headers={"user-agent": "claude-cli/2.1"})

        (log,) = await get_logs()
        assert log.session_key == sticky.session_key(
            __import__("json").dumps(MESSAGE_BODY).encode(), api_key_id=None
        )
        assert log.user_agent == "claude-cli/2.1"
        assert log.client_ip == "127.0.0.1"
        assert log.ttft_ms is None, "no first byte to time on a buffered response"

    async def test_streaming_request_logs_time_to_first_byte(self, proxy_calls):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=SSE_BODY, headers={"content-type": "text/event-stream"})

        await add_account("primary")
        async for client in make_client(handler):
            async with client.stream("POST", "/v1/messages", json={**MESSAGE_BODY, "stream": True}) as r:
                [chunk async for chunk in r.aiter_bytes()]

        (log,) = await get_logs()
        assert log.ttft_ms is not None
        assert 0 <= log.ttft_ms <= log.duration_ms
        assert log.session_key

    async def test_exhausted_request_still_logs_its_conversation(self, proxy_calls):
        async for client in make_client(ok_json(proxy_calls)):
            response = await client.post("/v1/messages", json=MESSAGE_BODY)
        assert response.status_code >= 500
        (log,) = await get_logs()
        assert log.session_key is not None


OLD_REQUEST_LOGS = """
CREATE TABLE request_logs (
    id VARCHAR(32) NOT NULL,
    created_at TIMESTAMP NOT NULL,
    account_id VARCHAR(32),
    api_key_id VARCHAR(32),
    path VARCHAR(255) NOT NULL,
    model VARCHAR(128),
    status_code INTEGER NOT NULL,
    streaming BOOLEAN NOT NULL,
    duration_ms INTEGER NOT NULL,
    attempts INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_creation_input_tokens INTEGER NOT NULL,
    cache_read_input_tokens INTEGER NOT NULL,
    cost_usd FLOAT NOT NULL,
    error VARCHAR(512),
    PRIMARY KEY (id)
)
"""


class TestSchemaUpgrade:
    async def test_old_request_logs_table_gains_the_new_columns_and_keeps_rows(self):
        engine = get_engine()
        # recent, so the startup retention prune keeps it
        created = (now() - timedelta(hours=1)).strftime("%Y-%m-%d %H:%M:%S")
        async with engine.begin() as conn:
            await conn.execute(text("DROP TABLE IF EXISTS request_logs"))
            await conn.execute(text(OLD_REQUEST_LOGS))
            await conn.execute(
                text(
                    f"INSERT INTO request_logs VALUES ('old1', '{created}', NULL, NULL,"
                    " '/v1/messages', 'claude-opus-5', 200, 0, 900, 1, 10, 20, 0, 0, 0.5, NULL)"
                )
            )

        await init_db()

        async with engine.begin() as conn:
            columns = {
                c["name"] for c in await conn.run_sync(lambda c: inspect(c).get_columns("request_logs"))
            }
            indexes = {
                i["name"] for i in await conn.run_sync(lambda c: inspect(c).get_indexes("request_logs"))
            }
        assert {"ttft_ms", "session_key", "user_agent", "client_ip"} <= columns
        assert "ix_request_logs_session_created" in indexes

        async with session_scope() as session:
            row = await session.get(RequestLog, "old1")
        assert row is not None and row.cost_usd == 0.5
        assert row.session_key is None and row.ttft_ms is None

        async for client in make_client(ok_json([])):
            page = (await client.get("/api/request-logs")).json()
        assert page["total"] == 1
        assert page["requests"][0]["ttft_ms"] is None


class TestOverview:
    async def test_totals_deltas_and_sparkline_buckets(self):
        account_id = await add_account("primary")
        t = now()
        # current 24h window: three requests, one failing, one with cache reads
        await add_log(
            t - timedelta(minutes=30), account_id=account_id, session_key="a", ttft_ms=200, duration_ms=1000
        )
        await add_log(
            t - timedelta(minutes=90),
            account_id=account_id,
            session_key="a",
            cache_read_input_tokens=900_000,
            duration_ms=3000,
        )
        await add_log(
            t - timedelta(hours=23),
            account_id=account_id,
            session_key="b",
            status_code=529,
            error="upstream 529",
            cost_usd=0.0,
            duration_ms=2000,
        )
        # previous window
        await add_log(t - timedelta(hours=30), account_id=account_id, session_key="c")
        # outside both
        await add_log(t - timedelta(hours=60), account_id=account_id)

        async for client in make_client(ok_json([])):
            body = (await client.get("/api/dashboard/overview?timeframe=24h")).json()

        cur, prev = body["current"], body["previous"]
        assert body["timeframe"] == {
            "key": "24h",
            "window_minutes": 1440,
            "bucket_seconds": 3600,
            "bucket_count": 24,
        }
        assert cur["requests"] == 3 and cur["errors"] == 1
        assert cur["error_rate"] == pytest.approx(1 / 3, abs=1e-4)
        assert cur["top_error"] == "upstream 529" and cur["top_error_count"] == 1
        assert cur["conversations"] == 2
        assert cur["cost_usd"] == pytest.approx(0.02)
        assert cur["cache_savings_usd"] == pytest.approx(900_000 * (4.00 - 0.20) / 1e6)
        assert cur["cache_hit_rate"] == pytest.approx(900_000 / (900_000 + 300), abs=1e-4)
        assert cur["avg_duration_ms"] == pytest.approx(2000)
        assert cur["avg_ttft_ms"] == pytest.approx(200)
        assert prev["requests"] == 1 and prev["conversations"] == 1
        assert body["can_compare"] is True

        trends = body["trends"]
        assert len(trends) == 24
        assert sum(p["requests"] for p in trends) == 3
        assert trends[-1]["requests"] == 1 and trends[-2]["requests"] == 1
        assert trends[0]["requests"] == 1 and trends[0]["error_rate"] == 1.0

        (model,) = body["by_model"]
        assert model["model"] == "claude-opus-5-5" and model["requests"] == 3
        assert model["cache_savings_usd"] == pytest.approx(cur["cache_savings_usd"])

        meta = body["meta"]
        assert meta["accounts_total"] == 1 and meta["accounts_available"] == 1
        assert meta["routing_strategy"] and meta["version"]
        assert meta["request_log_retention_days"] == 30

    @pytest.mark.parametrize(("frame", "buckets"), [("1h", 12), ("7d", 28), ("30d", 30)])
    async def test_every_timeframe_has_fixed_bucket_counts(self, frame, buckets):
        await add_log(now() - timedelta(minutes=2))
        async for client in make_client(ok_json([])):
            body = (await client.get(f"/api/dashboard/overview?timeframe={frame}")).json()
        assert len(body["trends"]) == buckets
        assert body["current"]["requests"] == 1
        assert body["trends"][-1]["requests"] == 1
        assert body["can_compare"] is False

    async def test_unknown_timeframe_is_rejected(self):
        async for client in make_client(ok_json([])):
            response = await client.get("/api/dashboard/overview?timeframe=2d")
        assert response.status_code == 422

    async def test_empty_database(self):
        async for client in make_client(ok_json([])):
            body = (await client.get("/api/dashboard/overview")).json()
        assert body["current"]["requests"] == 0
        assert body["current"]["top_error"] is None
        assert body["current"]["avg_duration_ms"] is None
        assert body["by_model"] == []
        assert body["meta"]["pool_remaining_percent"] == 100.0


class TestProjections:
    async def test_no_subscription_accounts(self):
        await add_account("console", plan_type="api", spend_cap_usd=10.0, total_cost_usd=2.5)
        async for client in make_client(ok_json([])):
            body = (await client.get("/api/dashboard/projections")).json()
        assert body["subscription_accounts"] == 0
        assert body["primary"] is None and body["secondary"] is None and body["weekly_pace"] is None
        (spend,) = body["api_accounts"]
        assert spend["cap_used_percent"] == 25.0 and spend["spend_usd"] == 2.5

    async def test_capacity_windows_and_weekly_pace(self):
        t = now()
        max_id = await add_account(
            "max",
            plan_type="max_5x",
            primary_used_percent=40.0,
            primary_reset_at=t + timedelta(hours=1),
            secondary_used_percent=80.0,
            secondary_reset_at=t + timedelta(days=3, hours=12),
            quota_observed_at=t,
        )
        await add_account(
            "pro",
            plan_type="pro",
            primary_used_percent=0.0,
            primary_reset_at=t + timedelta(hours=4),
            secondary_used_percent=10.0,
            secondary_reset_at=t + timedelta(days=6),
            quota_observed_at=t,
        )
        await add_account("paused-pro", plan_type="pro", enabled=False)
        await add_account("console", plan_type="api")
        # the max account burned 20% of its week in the last 4 hours
        async with session_scope() as session:
            for hours_ago, used in ((4, 60.0), (2, 70.0), (0, 80.0)):
                session.add(
                    QuotaHistory(
                        account_id=max_id,
                        recorded_at=t - timedelta(hours=hours_ago),
                        primary_used_percent=40.0,
                        secondary_used_percent=used,
                        secondary_reset_at=t + timedelta(days=3, hours=12),
                    )
                )

        async for client in make_client(ok_json([])):
            body = (await client.get("/api/dashboard/projections")).json()

        assert body["subscription_accounts"] == 2
        primary, secondary = body["primary"], body["secondary"]
        assert primary["capacity_credits"] == 600.0
        assert primary["remaining_credits"] == pytest.approx(500 * 0.6 + 100)
        assert {a["account_name"] for a in primary["accounts"]} == {"max", "pro"}
        assert primary["safe_used_percent"] is not None
        assert secondary["remaining_percent"] == pytest.approx((100 + 90) / 600 * 100, abs=0.01)
        max_secondary = next(a for a in secondary["accounts"] if a["account_name"] == "max")
        assert max_secondary["safe_used_percent"] == pytest.approx(50.0, abs=0.1)
        assert max_secondary["risk_level"] == "critical"
        assert max_secondary["burn_rate_credits_per_hour"] > 0

        weekly = body["weekly_pace"]
        assert weekly["account_count"] == 2
        assert weekly["inactive_account_count"] == 1
        assert weekly["actual_used_percent"] > weekly["scheduled_used_percent"]
        assert weekly["status"] == "danger"
        assert weekly["projected_shortfall_credits"] > 0
        assert weekly["pause_for_break_even_hours"] > 0
        assert weekly["pro_accounts_to_cover"] >= 1
        assert weekly["confidence"] == "medium"
        assert {a["account_name"] for a in body["api_accounts"]} == {"console"}


class TestWeeklyPaceMath:
    def test_on_schedule_pool_with_no_burn_samples_is_on_track_low_confidence(self):
        from claude_lb.db.models import Account

        t = now()
        account = Account(
            id="a",
            name="a",
            plan_type="pro",
            enabled=True,
            secondary_used_percent=50.0,
            secondary_reset_at=t + timedelta(days=3, hours=12),
            quota_observed_at=t,
        )
        result = pace.build_weekly_pace([account], {}, now=t)
        assert result is not None
        assert result["scheduled_used_percent"] == pytest.approx(50.0, abs=0.01)
        assert result["status"] == "on_track"
        assert result["confidence"] == "low"
        assert result["projected_shortfall_credits"] == 0
        assert result["pro_accounts_to_cover"] is None

    def test_api_accounts_are_ignored(self):
        from claude_lb.db.models import Account

        account = Account(id="a", name="a", plan_type="api", enabled=True)
        assert pace.build_weekly_pace([account], {}, now=now()) is None


class TestRequestLogs:
    async def seed(self):
        t = now()
        a = await add_account("alpha")
        b = await add_account("beta", plan_type="max_5x")
        key = await add_key("ci-bot")
        ids = {
            "ok": await add_log(
                t - timedelta(minutes=1),
                account_id=a,
                api_key_id=key,
                session_key="conv1",
                user_agent="claude-cli/2.1",
                client_ip="10.0.0.7",
            ),
            "rate": await add_log(
                t - timedelta(minutes=2), account_id=b, status_code=429, error="rate limited"
            ),
            "over": await add_log(
                t - timedelta(minutes=3), account_id=b, status_code=529, model="claude-haiku-5-5"
            ),
            "abort": await add_log(
                t - timedelta(minutes=4), account_id=a, error="client disconnected mid-stream"
            ),
            "old": await add_log(
                t - timedelta(days=3),
                account_id=a,
                model="claude-sonnet-5-5",
                session_key="conv1",
                cost_usd=0.5,
            ),
        }
        return ids, a, b, key

    async def test_pagination_total_and_ordering(self):
        ids, *_ = await self.seed()
        async for client in make_client(ok_json([])):
            first = (await client.get("/api/request-logs?limit=2")).json()
            second = (await client.get("/api/request-logs?limit=2&offset=2")).json()
            last = (await client.get("/api/request-logs?limit=2&offset=4")).json()
        assert first["total"] == 5 and first["has_more"] is True
        assert [r["id"] for r in first["requests"]] == [ids["ok"], ids["rate"]]
        assert [r["id"] for r in second["requests"]] == [ids["over"], ids["abort"]]
        assert [r["id"] for r in last["requests"]] == [ids["old"]] and last["has_more"] is False

    async def test_row_shape(self):
        ids, a, _, key = await self.seed()
        async for client in make_client(ok_json([])):
            page = (await client.get("/api/request-logs?limit=1")).json()
        row = page["requests"][0]
        assert row["account_name"] == "alpha" and row["api_key_name"] == "ci-bot"
        assert row["plan_type"] == "api"
        assert row["status"] == "ok" and row["total_tokens"] == 150
        assert row["session_key"] == "conv1" and row["user_agent"] == "claude-cli/2.1"
        assert row["client_ip"] == "10.0.0.7"

    @pytest.mark.parametrize(
        ("query", "expected"),
        [
            ("status=rate_limited", {"rate"}),
            ("status=overloaded&status=aborted", {"over", "abort"}),
            ("status=ok", {"ok", "old"}),
            ("timeframe=24h", {"ok", "rate", "over", "abort"}),
            ("model=claude-sonnet-5-5", {"old"}),
            ("search=disconnected", {"abort"}),
            ("search=BETA", {"rate", "over"}),
            ("search=ci-bot", {"ok"}),
            ("search=10.0.0", {"ok"}),
            ("session_key=conv1", {"ok", "old"}),
            ("search=100%25", set()),
        ],
    )
    async def test_filters(self, query, expected):
        ids, *_ = await self.seed()
        async for client in make_client(ok_json([])):
            page = (await client.get(f"/api/request-logs?{query}")).json()
        names = {name for name, rid in ids.items() if rid in {r["id"] for r in page["requests"]}}
        assert names == expected
        assert page["total"] == len(expected)

    async def test_account_and_key_filters(self):
        ids, a, b, key = await self.seed()
        async for client in make_client(ok_json([])):
            by_account = (await client.get(f"/api/request-logs?account_id={b}")).json()
            by_key = (await client.get(f"/api/request-logs?api_key_id={key}")).json()
            both = (await client.get(f"/api/request-logs?account_id={a}&account_id={b}")).json()
        assert by_account["total"] == 2
        assert [r["id"] for r in by_key["requests"]] == [ids["ok"]]
        assert both["total"] == 5

    async def test_unknown_status_is_rejected(self):
        async for client in make_client(ok_json([])):
            response = await client.get("/api/request-logs?status=nope")
        assert response.status_code == 422

    async def test_options(self):
        _, a, b, key = await self.seed()
        async for client in make_client(ok_json([])):
            options = (await client.get("/api/request-logs/options")).json()
            recent = (await client.get("/api/request-logs/options?timeframe=24h")).json()
        assert [o["name"] for o in options["accounts"]] == ["alpha", "beta"]
        assert options["api_keys"] == [{"id": key, "name": "ci-bot", "key_hint": "clb-…ci-b"}]
        assert options["models"] == ["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]
        assert options["statuses"] == ["ok", "aborted", "rate_limited", "overloaded"]
        assert "claude-sonnet-5-5" not in recent["models"]

    async def test_detail_with_cost_breakdown_and_conversation(self):
        ids, *_ = await self.seed()
        async for client in make_client(ok_json([])):
            detail = (await client.get(f"/api/request-logs/{ids['ok']}")).json()
            missing = await client.get("/api/request-logs/nope")
        assert detail["id"] == ids["ok"]
        assert detail["cost_breakdown"]["input_usd"] == pytest.approx(100 * 4.0 / 1e6)
        assert detail["cost_breakdown"]["output_usd"] == pytest.approx(50 * 20.0 / 1e6)
        assert detail["conversation"]["requests"] == 2
        assert detail["conversation"]["cost_usd"] == pytest.approx(0.51)
        assert missing.status_code == 404

    async def test_legacy_usage_requests_endpoint_still_works(self):
        await self.seed()
        async for client in make_client(ok_json([])):
            rows = (await client.get("/api/usage/requests?limit=3")).json()
        assert len(rows) == 3


@pytest.mark.parametrize(
    ("code", "error", "category"),
    [
        (200, None, "ok"),
        (200, "client disconnected mid-stream", "aborted"),
        (429, None, "rate_limited"),
        (529, None, "overloaded"),
        (401, None, "auth_error"),
        (400, None, "client_error"),
        (503, "no account", "server_error"),
        (0, None, "server_error"),
    ],
)
def test_status_category(code, error, category):
    assert status_category(code, error) == category
