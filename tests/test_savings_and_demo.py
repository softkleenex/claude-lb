"""Cache-savings reporting, the demo's simulated upstream, and `setup claude-code`."""

from __future__ import annotations

import json
import time

import httpx
import pytest
from fastapi import FastAPI
from typer.testing import CliRunner

from claude_lb import demo
from claude_lb.modules.proxy.service import record_request
from claude_lb.modules.proxy.usage_parser import Usage
from tests.test_proxy_api import add_account, make_client, ok_json


async def log(account_id: str, model: str, **usage) -> None:
    await record_request(
        account_id=account_id,
        api_key_id=None,
        path="/v1/messages",
        model=model,
        status_code=200,
        streaming=False,
        started_at=time.perf_counter(),
        attempts=1,
        usage=Usage(**usage),
    )


class TestCacheSavings:
    async def test_summary_reports_savings_and_hit_rate_per_model_and_account(self):
        account_id = await add_account("primary")
        await log(account_id, "claude-opus-5-5", input_tokens=100_000, cache_read_input_tokens=900_000)
        await log(account_id, "claude-haiku-4-5", input_tokens=0, cache_read_input_tokens=1_000_000)

        async for client in make_client(ok_json([])):
            summary = (await client.get("/api/usage/summary")).json()

        opus_saved = 900_000 * (4.00 - 0.20) / 1e6
        haiku_saved = 1_000_000 * (1.00 - 0.10) / 1e6
        by_model = {m["model"]: m for m in summary["by_model"]}
        assert by_model["claude-opus-5-5"]["cache_savings_usd"] == pytest.approx(opus_saved)
        assert by_model["claude-opus-5-5"]["cache_hit_rate"] == pytest.approx(0.9)
        assert summary["totals"]["cache_savings_usd"] == pytest.approx(opus_saved + haiku_saved)
        assert summary["by_account"][0]["cache_savings_usd"] == pytest.approx(opus_saved + haiku_saved)

    async def test_no_cache_traffic_means_no_savings(self):
        account_id = await add_account("primary")
        await log(account_id, "claude-opus-5-5", input_tokens=1_000)
        async for client in make_client(ok_json([])):
            totals = (await client.get("/api/usage/summary")).json()["totals"]
        assert totals["cache_savings_usd"] == 0.0
        assert totals["cache_hit_rate"] == 0.0


class TestDemoUpstream:
    @pytest.fixture
    async def upstream(self):
        app = FastAPI()
        app.include_router(demo.build_fake_upstream())
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://up") as client:
            yield client

    @staticmethod
    async def call(client, credential: str, *, stream: bool = False) -> httpx.Response:
        body = {
            "model": "claude-opus-5-5",
            "system": "s" * 4000,
            "messages": [{"role": "user", "content": "hi"}],
        }
        for _ in range(20):  # the simulator returns an occasional 529
            response = await client.post(
                f"{demo.DEMO_UPSTREAM_PREFIX}/v1/messages",
                json={**body, "stream": stream},
                headers={"x-api-key": credential},
            )
            if response.status_code == 200:
                return response
        raise AssertionError("simulated upstream kept failing")

    async def test_its_cache_is_scoped_to_the_credential(self, upstream):
        """The property the demo exists to show: a prefix cached on one account is a
        cache *write* again on another."""
        first = (await self.call(upstream, "sk-ant-demo-prod-us")).json()["usage"]
        again = (await self.call(upstream, "sk-ant-demo-prod-us")).json()["usage"]
        elsewhere = (await self.call(upstream, "sk-ant-demo-prod-eu")).json()["usage"]
        assert first["cache_creation_input_tokens"] > 0 and first["cache_read_input_tokens"] == 0
        assert again["cache_read_input_tokens"] == first["cache_creation_input_tokens"]
        assert elsewhere["cache_creation_input_tokens"] > 0

    async def test_streams_carry_usage_and_rate_limit_headers(self, upstream):
        response = await self.call(upstream, "sk-ant-demo-prod-us", stream=True)
        assert "anthropic-ratelimit-requests-remaining" in response.headers
        assert b'"message_delta"' in response.content and b'"output_tokens"' in response.content

    async def test_model_list_is_not_shadowed_by_the_dashboard(self, tmp_path, monkeypatch):
        """Regression: the SPA fallback used to answer the fake upstream's GETs with HTML."""
        from claude_lb.main import create_app
        from claude_lb.modules.dashboard import api as dashboard_api

        (tmp_path / "index.html").write_text("<!doctype html><title>spa</title>")
        monkeypatch.setattr(dashboard_api, "STATIC_DIR", tmp_path)
        app = create_app()
        demo.mount_fake_upstream(app)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://up") as client:
            response = await client.get(f"{demo.DEMO_UPSTREAM_PREFIX}/v1/models")
            assert response.headers["content-type"].startswith("application/json")
            assert len(response.json()["data"]) == len(demo.MODELS)
            assert "spa" in (await client.get("/dashboard")).text

    async def test_model_list(self, upstream):
        models = (await upstream.get(f"{demo.DEMO_UPSTREAM_PREFIX}/v1/models")).json()["data"]
        assert {m["id"] for m in models} == {m[0] for m in demo.MODELS}


class TestSetupClaudeCode:
    def test_issues_a_key_and_prints_both_forms_of_config(self, monkeypatch):
        from claude_lb.cli import app
        from claude_lb.db import session as db_session

        # The CLI runs its own event loop, as it does in real use; the engine the
        # test fixture opened belongs to pytest's loop, and asyncpg refuses to share.
        monkeypatch.setattr(db_session, "_engine", None)
        monkeypatch.setattr(db_session, "_sessionmaker", None)

        result = CliRunner().invoke(app, ["setup", "claude-code", "--base-url", "http://lb.internal:2456/"])
        assert result.exit_code == 0, result.output
        assert "export ANTHROPIC_BASE_URL=http://lb.internal:2456\n" in result.output
        key_line = next(line for line in result.output.splitlines() if "ANTHROPIC_API_KEY=" in line)
        assert key_line.split("=", 1)[1].startswith("clb_")
        settings = json.loads(result.output[result.output.index("{") : result.output.rindex("}") + 1])
        assert settings["env"]["ANTHROPIC_BASE_URL"] == "http://lb.internal:2456"

        again = CliRunner().invoke(app, ["setup", "claude-code"])
        assert again.exit_code == 1, "a second key under the same name is refused"


class TestDemoBinding:
    def test_binds_where_a_published_container_port_can_reach_it(self, monkeypatch):
        monkeypatch.setenv("CLAUDE_LB_IN_DOCKER", "1")
        assert demo.default_host() == "0.0.0.0"
        monkeypatch.delenv("CLAUDE_LB_IN_DOCKER")
        assert demo.default_host() == "127.0.0.1"

    def test_dashboard_auth_only_relaxes_off_loopback(self):
        # prepare_environment opens the dashboard exactly when this is False.
        assert demo.is_loopback_bind("127.0.0.1")
        assert demo.is_loopback_bind("localhost")
        assert not demo.is_loopback_bind("0.0.0.0")
