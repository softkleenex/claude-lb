"""End-to-end tests through the real FastAPI app with a mocked Anthropic upstream."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable

import httpx
import pytest
from sqlalchemy import select

from app.core.config import get_settings
from app.core.crypto import encrypt, mask_secret
from app.db.models import Account, RequestLog
from app.db.session import session_scope
from app.main import create_app

MESSAGE_BODY = {"model": "claude-opus-5", "max_tokens": 64, "messages": [{"role": "user", "content": "hi"}]}

SSE_BODY = (
    b"event: message_start\n"
    b'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-5",'
    b'"usage":{"input_tokens":11,"output_tokens":1}}}\n\n'
    b"event: message_delta\n"
    b'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":33}}\n\n'
    b'event: message_stop\ndata: {"type":"message_stop"}\n\n'
)


async def add_account(name: str, key: str = "sk-ant-test-key", **kwargs) -> str:
    async with session_scope() as session:
        account = Account(
            name=name,
            encrypted_credential=encrypt(key),
            credential_hint=mask_secret(key),
            **kwargs,
        )
        session.add(account)
        await session.flush()
        return account.id


async def get_logs() -> list[RequestLog]:
    async with session_scope() as session:
        result = await session.execute(select(RequestLog).order_by(RequestLog.created_at))
        return list(result.scalars())


async def get_account(account_id: str) -> Account:
    async with session_scope() as session:
        account = await session.get(Account, account_id)
        session.expunge(account)
        return account


def ok_json(calls: list[httpx.Request]) -> Callable[[httpx.Request], httpx.Response]:
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(
            200,
            json={
                "id": "msg_1",
                "model": "claude-opus-5",
                "content": [{"type": "text", "text": "hello"}],
                "usage": {"input_tokens": 11, "output_tokens": 22},
            },
            headers={
                "anthropic-ratelimit-requests-limit": "1000",
                "anthropic-ratelimit-requests-remaining": "997",
            },
        )

    return handler


async def make_client(handler) -> AsyncIterator[httpx.AsyncClient]:
    """Start the app with its upstream client swapped for a MockTransport."""
    app = create_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://lb") as client:
        # Enter lifespan so DB init + state setup run, then override the upstream client.
        async with app.router.lifespan_context(app):
            await app.state.http_client.aclose()
            app.state.http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            yield client


@pytest.fixture
def ordered_routing(monkeypatch):
    """Pin routing to `fill_first` so `priority` fixes the try order.

    The default `capacity_weighted` strategy is deliberately random, which makes any
    assertion about *which* account is tried first non-deterministic.
    """
    monkeypatch.setattr(get_settings(), "routing_strategy", "fill_first")


class TestHappyPath:
    async def test_forwards_and_records_a_non_streaming_request(self, proxy_calls):
        account_id = await add_account("primary")

        async for client in make_client(ok_json(proxy_calls)):
            response = await client.post("/v1/messages", json=MESSAGE_BODY)

        assert response.status_code == 200
        assert response.json()["content"][0]["text"] == "hello"
        assert response.headers["x-claude-lb-account"] == "primary"

        # The upstream saw the decrypted credential, not the client's.
        assert proxy_calls[0].headers["x-api-key"] == "sk-ant-test-key"
        assert proxy_calls[0].headers["anthropic-version"] == "2023-06-01"
        assert str(proxy_calls[0].url) == "https://api.anthropic.com/v1/messages"

        logs = await get_logs()
        assert len(logs) == 1
        assert logs[0].status_code == 200
        assert logs[0].input_tokens == 11
        assert logs[0].output_tokens == 22
        assert logs[0].cost_usd == pytest.approx((11 * 5.0 + 22 * 25.0) / 1_000_000)

        account = await get_account(account_id)
        assert account.total_requests == 1
        assert account.rl_requests_remaining == 997

    async def test_streams_sse_through_and_records_usage_after_completion(self, proxy_calls):
        def handler(request: httpx.Request) -> httpx.Response:
            proxy_calls.append(request)
            return httpx.Response(200, content=SSE_BODY, headers={"content-type": "text/event-stream"})

        await add_account("primary")

        async for client in make_client(handler):
            async with client.stream(
                "POST", "/v1/messages", json={**MESSAGE_BODY, "stream": True}
            ) as response:
                body = b"".join([chunk async for chunk in response.aiter_bytes()])

        assert response.status_code == 200
        assert body == SSE_BODY, "SSE bytes must pass through unmodified"

        logs = await get_logs()
        assert len(logs) == 1
        assert logs[0].streaming is True
        assert logs[0].input_tokens == 11
        assert logs[0].output_tokens == 33

    async def test_client_error_is_relayed_verbatim_without_retrying(self, proxy_calls):
        def handler(request: httpx.Request) -> httpx.Response:
            proxy_calls.append(request)
            return httpx.Response(400, json={"type": "error", "error": {"type": "invalid_request_error"}})

        await add_account("primary")
        async for client in make_client(handler):
            response = await client.post("/v1/messages", json=MESSAGE_BODY)

        assert response.status_code == 400
        assert response.json()["error"]["type"] == "invalid_request_error"
        assert len(proxy_calls) == 1, "a 400 is the caller's fault; do not burn other accounts"


class TestFailover:
    async def test_rate_limited_account_is_skipped_and_the_next_one_serves(
        self, proxy_calls, ordered_routing
    ):
        first_id = await add_account("first", key="sk-ant-first", priority=10)
        await add_account("second", key="sk-ant-second", priority=0)

        def handler(request: httpx.Request) -> httpx.Response:
            proxy_calls.append(request)
            if request.headers["x-api-key"] == "sk-ant-first":
                return httpx.Response(429, json={"error": "slow down"}, headers={"retry-after": "30"})
            return httpx.Response(
                200,
                json={"id": "m", "model": "claude-opus-5", "usage": {"input_tokens": 1, "output_tokens": 2}},
            )

        async for client in make_client(handler):
            response = await client.post("/v1/messages", json=MESSAGE_BODY)

        assert response.status_code == 200
        assert response.headers["x-claude-lb-account"] == "second"
        assert {c.headers["x-api-key"] for c in proxy_calls} == {"sk-ant-first", "sk-ant-second"}

        first = await get_account(first_id)
        assert first.cooldown_until is not None, "429 should put the account in cooldown"
        assert first.enabled is True, "429 is transient — do not permanently disable"

    async def test_auth_failure_disables_the_account(self, proxy_calls):
        bad_id = await add_account("bad", key="sk-ant-bad")

        def handler(request: httpx.Request) -> httpx.Response:
            proxy_calls.append(request)
            return httpx.Response(401, json={"type": "error", "error": {"type": "authentication_error"}})

        async for client in make_client(handler):
            response = await client.post("/v1/messages", json=MESSAGE_BODY)

        assert response.status_code == 401
        bad = await get_account(bad_id)
        assert bad.enabled is False
        assert "401" in (bad.disabled_reason or "")

    async def test_gives_up_after_max_attempts(self, proxy_calls):
        for i in range(5):
            await add_account(f"account-{i}", key=f"sk-ant-{i}")

        def handler(request: httpx.Request) -> httpx.Response:
            proxy_calls.append(request)
            return httpx.Response(503, json={"type": "error", "error": {"type": "overloaded_error"}})

        async for client in make_client(handler):
            response = await client.post("/v1/messages", json=MESSAGE_BODY)

        assert response.status_code == 503
        assert len(proxy_calls) == 3, "CLAUDE_LB_MAX_ATTEMPTS caps the fan-out"

        logs = await get_logs()
        assert logs[0].status_code == 503
        assert logs[0].error

    async def test_no_accounts_configured_returns_503(self):
        async for client in make_client(ok_json([])):
            response = await client.post("/v1/messages", json=MESSAGE_BODY)

        assert response.status_code == 503
        assert "no accounts configured" in response.json()["error"]["message"]

    async def test_transport_error_fails_over(self, proxy_calls, ordered_routing):
        await add_account("flaky", key="sk-ant-flaky", priority=10)
        await add_account("stable", key="sk-ant-stable", priority=0)

        def handler(request: httpx.Request) -> httpx.Response:
            proxy_calls.append(request)
            if request.headers["x-api-key"] == "sk-ant-flaky":
                raise httpx.ConnectError("connection refused")
            return httpx.Response(
                200,
                json={"id": "m", "model": "claude-opus-5", "usage": {"input_tokens": 1, "output_tokens": 1}},
            )

        async for client in make_client(handler):
            response = await client.post("/v1/messages", json=MESSAGE_BODY)

        assert response.status_code == 200
        assert response.headers["x-claude-lb-account"] == "stable"


class TestRouting:
    async def test_unproxied_v1_paths_404_instead_of_being_relayed(self, proxy_calls):
        await add_account("primary")
        async for client in make_client(ok_json(proxy_calls)):
            response = await client.post("/v1/not-a-real-endpoint", json={})

        assert response.status_code == 404
        assert not proxy_calls, "unknown paths must never reach upstream"

    async def test_management_api_is_not_shadowed_by_the_proxy_catch_all(self):
        async for client in make_client(ok_json([])):
            response = await client.get("/api/accounts")
        assert response.status_code == 200
        assert response.json() == []

    async def test_query_string_is_preserved(self, proxy_calls):
        await add_account("primary")
        async for client in make_client(ok_json(proxy_calls)):
            await client.get("/v1/models?limit=5")
        assert proxy_calls[0].url.params["limit"] == "5"


class TestManagementApi:
    async def test_account_credentials_are_never_returned(self):
        async for client in make_client(ok_json([])):
            created = await client.post(
                "/api/accounts", json={"name": "acct", "api_key": "sk-ant-supersecret-value"}
            )
            listed = await client.get("/api/accounts")

        assert created.status_code == 201
        payload = created.json()
        assert "supersecret" not in json.dumps(payload)
        assert payload["credential_hint"].endswith("-value")
        assert "encrypted_credential" not in payload
        assert "supersecret" not in json.dumps(listed.json())

    async def test_duplicate_account_name_is_rejected(self):
        async for client in make_client(ok_json([])):
            await client.post("/api/accounts", json={"name": "dup", "api_key": "sk-ant-1"})
            second = await client.post("/api/accounts", json={"name": "dup", "api_key": "sk-ant-2"})
        assert second.status_code == 409

    async def test_issued_api_key_is_shown_once_then_only_hinted(self):
        async for client in make_client(ok_json([])):
            created = await client.post("/api/keys", json={"name": "team-a"})
            listed = await client.get("/api/keys")

        plaintext = created.json()["api_key"]
        assert plaintext.startswith("clb_")
        assert listed.json()[0]["key_hint"] == plaintext[-6:]
        assert "api_key" not in listed.json()[0]

    async def test_reenabling_an_account_clears_the_breaker(self):
        account_id = await add_account("broken", enabled=False, consecutive_failures=9)
        async with session_scope() as session:
            account = await session.get(Account, account_id)
            account.disabled_reason = "upstream returned 401"

        async for client in make_client(ok_json([])):
            response = await client.patch(f"/api/accounts/{account_id}", json={"enabled": True})

        assert response.status_code == 200
        refreshed = await get_account(account_id)
        assert refreshed.enabled is True
        assert refreshed.disabled_reason is None
        assert refreshed.consecutive_failures == 0

    async def test_usage_summary_aggregates_by_account_and_model(self, proxy_calls):
        await add_account("primary")
        async for client in make_client(ok_json(proxy_calls)):
            await client.post("/v1/messages", json=MESSAGE_BODY)
            await client.post("/v1/messages", json=MESSAGE_BODY)
            summary = (await client.get("/api/usage/summary?window_hours=1")).json()

        assert summary["totals"]["requests"] == 2
        assert summary["totals"]["output_tokens"] == 44
        assert summary["by_account"][0]["account_name"] == "primary"
        assert summary["by_model"][0]["model"] == "claude-opus-5"


class TestErrorEnvelope:
    """Anthropic SDKs read `error.type` off the top level; FastAPI's default
    `{"detail": ...}` wrapper would be unparseable to them."""

    async def test_auth_failure_uses_the_anthropic_error_shape(self, monkeypatch):
        monkeypatch.setattr(get_settings(), "require_api_key", True)
        async for client in make_client(ok_json([])):
            response = await client.post("/v1/messages", json=MESSAGE_BODY)

        assert response.status_code == 401
        body = response.json()
        assert "detail" not in body
        assert body["type"] == "error"
        assert body["error"]["type"] == "authentication_error"

    async def test_unknown_path_uses_the_anthropic_error_shape(self):
        async for client in make_client(ok_json([])):
            response = await client.post("/v1/nope", json={})

        assert response.json()["error"]["type"] == "not_found_error"

    async def test_management_routes_keep_fastapi_error_shape(self):
        async for client in make_client(ok_json([])):
            response = await client.patch("/api/accounts/missing", json={"enabled": True})

        assert response.status_code == 404
        assert response.json() == {"detail": "account not found"}
