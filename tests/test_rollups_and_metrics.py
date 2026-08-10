from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select

from app.db.models import RequestLog, UsageDaily
from app.db.session import session_scope
from app.modules.usage import rollup
from tests.test_proxy_api import MESSAGE_BODY, add_account, make_client, ok_json


async def rows() -> list[UsageDaily]:
    async with session_scope() as session:
        result = await session.execute(select(UsageDaily))
        return list(result.scalars())


class TestRollupAccumulation:
    async def test_a_request_creates_a_daily_row(self, proxy_calls):
        await add_account("primary")
        async for client in make_client(ok_json(proxy_calls)):
            await client.post("/v1/messages", json=MESSAGE_BODY)

        (row,) = await rows()
        assert row.day == rollup.day_key()
        assert row.requests == 1
        assert row.input_tokens == 11
        assert row.output_tokens == 22
        assert row.model == "claude-opus-5"

    async def test_repeated_requests_accumulate_into_one_row(self, proxy_calls):
        await add_account("primary")
        async for client in make_client(ok_json(proxy_calls)):
            for _ in range(5):
                await client.post("/v1/messages", json=MESSAGE_BODY)

        (row,) = await rows()
        assert row.requests == 5
        assert row.output_tokens == 110

    async def test_errors_are_counted_separately(self, proxy_calls):
        import httpx

        await add_account("primary")

        def handler(request: httpx.Request) -> httpx.Response:
            proxy_calls.append(request)
            return httpx.Response(400, json={"type": "error", "error": {"type": "invalid_request_error"}})

        async for client in make_client(handler):
            await client.post("/v1/messages", json=MESSAGE_BODY)

        (row,) = await rows()
        assert row.requests == 1
        assert row.errors == 1

    async def test_different_models_get_different_rows(self, proxy_calls):
        import httpx

        await add_account("primary")

        def handler(request: httpx.Request) -> httpx.Response:
            proxy_calls.append(request)
            import json as jsonlib

            model = jsonlib.loads(request.content)["model"]
            return httpx.Response(
                200, json={"id": "m", "model": model, "usage": {"input_tokens": 1, "output_tokens": 1}}
            )

        async for client in make_client(handler):
            await client.post("/v1/messages", json={**MESSAGE_BODY, "model": "claude-opus-5"})
            await client.post("/v1/messages", json={**MESSAGE_BODY, "model": "claude-haiku-4-5"})

        assert {r.model for r in await rows()} == {"claude-opus-5", "claude-haiku-4-5"}

    async def test_streaming_requests_are_rolled_up_too(self, proxy_calls):
        import httpx

        from tests.test_proxy_api import SSE_BODY

        await add_account("primary")

        def handler(request: httpx.Request) -> httpx.Response:
            proxy_calls.append(request)
            return httpx.Response(200, content=SSE_BODY, headers={"content-type": "text/event-stream"})

        async for client in make_client(handler):
            async with client.stream(
                "POST", "/v1/messages", json={**MESSAGE_BODY, "stream": True}
            ) as response:
                async for _ in response.aiter_bytes():
                    pass

        (row,) = await rows()
        assert row.requests == 1
        assert row.output_tokens == 33


class TestRollupsSurviveLogPruning:
    async def test_trend_still_reports_after_request_logs_are_deleted(self, proxy_calls):
        """The whole point of rollups: retention must not erase the trend."""
        await add_account("primary")
        async for client in make_client(ok_json(proxy_calls)):
            for _ in range(3):
                await client.post("/v1/messages", json=MESSAGE_BODY)

            async with session_scope() as session:
                await session.execute(delete(RequestLog))

            trend = (await client.get("/api/usage/trend?days=7")).json()
            summary = (await client.get("/api/usage/summary?window_hours=24")).json()

        assert summary["totals"]["requests"] == 0, "request-log view is empty, as expected"
        assert sum(p["requests"] for p in trend) == 3, "the rollup must still know"


class TestTrendShape:
    async def test_quiet_days_are_zero_filled(self):
        async for client in make_client(ok_json([])):
            trend = (await client.get("/api/usage/trend?days=28")).json()
        assert len(trend) == 28
        assert all(point["requests"] == 0 for point in trend)

    async def test_days_are_returned_oldest_first(self):
        async for client in make_client(ok_json([])):
            trend = (await client.get("/api/usage/trend?days=5")).json()
        days = [p["day"] for p in trend]
        assert days == sorted(days)
        assert days[-1] == rollup.day_key()

    async def test_window_is_bounded(self):
        async for client in make_client(ok_json([])):
            assert (await client.get("/api/usage/trend?days=0")).status_code == 422
            assert (await client.get("/api/usage/trend?days=9999")).status_code == 422


class TestBackfill:
    async def test_rebuilds_rollups_from_request_logs(self):
        account_id = await add_account("primary")
        yesterday = datetime.now(UTC) - timedelta(days=1)

        async with session_scope() as session:
            for _ in range(4):
                session.add(
                    RequestLog(
                        created_at=yesterday,
                        account_id=account_id,
                        path="/v1/messages",
                        model="claude-opus-5",
                        status_code=200,
                        input_tokens=10,
                        output_tokens=20,
                        cost_usd=0.001,
                    )
                )
            # Rollups intentionally absent, as on an instance upgraded from an
            # older version.
            await session.execute(delete(UsageDaily))

        async for client in make_client(ok_json([])):
            result = (await client.post("/api/usage/rollups/backfill?days=7")).json()
            trend = (await client.get("/api/usage/trend?days=7")).json()

        assert result["rows"] == 1
        assert sum(p["requests"] for p in trend) == 4
        assert sum(p["output_tokens"] for p in trend) == 80

    async def test_backfill_is_idempotent(self):
        account_id = await add_account("primary")
        async with session_scope() as session:
            session.add(
                RequestLog(
                    account_id=account_id,
                    path="/v1/messages",
                    model="claude-opus-5",
                    status_code=200,
                    input_tokens=5,
                    output_tokens=5,
                )
            )

        async for client in make_client(ok_json([])):
            await client.post("/api/usage/rollups/backfill?days=7")
            await client.post("/api/usage/rollups/backfill?days=7")
            trend = (await client.get("/api/usage/trend?days=7")).json()

        assert sum(p["requests"] for p in trend) == 1, "running twice must not double-count"

    async def test_backfill_with_no_logs_is_a_no_op(self):
        async for client in make_client(ok_json([])):
            result = (await client.post("/api/usage/rollups/backfill")).json()
        assert result["rows"] == 0


class TestPrometheusMetrics:
    async def test_exposes_the_prometheus_text_format(self, proxy_calls):
        await add_account("primary")
        async for client in make_client(ok_json(proxy_calls)):
            await client.post("/v1/messages", json=MESSAGE_BODY)
            response = await client.get("/metrics")

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/plain")
        body = response.text
        assert "# HELP claude_lb_accounts_total" in body
        assert "# TYPE claude_lb_accounts_total gauge" in body
        assert body.endswith("\n")

    async def test_reports_per_account_state(self, proxy_calls):
        await add_account("primary")
        await add_account("broken", key="sk-ant-broken", enabled=False)

        async for client in make_client(ok_json(proxy_calls)):
            body = (await client.get("/metrics")).text

        assert 'claude_lb_account_up{account="primary"} 1' in body
        assert 'claude_lb_account_up{account="broken"} 0' in body
        assert "claude_lb_accounts_total 2" in body
        assert "claude_lb_accounts_available 1" in body

    async def test_counters_reflect_traffic(self, proxy_calls):
        await add_account("primary")
        async for client in make_client(ok_json(proxy_calls)):
            for _ in range(3):
                await client.post("/v1/messages", json=MESSAGE_BODY)
            body = (await client.get("/metrics")).text

        assert 'claude_lb_account_requests_total{account="primary"} 3' in body
        assert "claude_lb_requests_recent 3" in body
        assert 'claude_lb_account_tokens_total{account="primary",direction="output"} 66' in body

    async def test_account_names_are_escaped(self):
        await add_account('weird"name\\here')
        async for client in make_client(ok_json([])):
            body = (await client.get("/metrics")).text
        # An unescaped quote would break the exposition format for every scraper.
        assert 'account="weird\\"name\\\\here"' in body

    async def test_metrics_do_not_leak_credentials(self):
        await add_account("primary", key="sk-ant-supersecret-value")
        async for client in make_client(ok_json([])):
            body = (await client.get("/metrics")).text
        assert "supersecret" not in body

    async def test_scrape_needs_no_session(self):
        """A Prometheus scraper has no cookie; /metrics must stay reachable."""
        from tests.test_auth import PASSWORD, make_remote_client

        async for client in make_client(ok_json([])):
            await client.post("/api/auth/password", json={"password": PASSWORD})

        async for client in make_remote_client(ok_json([])):
            assert (await client.get("/metrics")).status_code == 200
