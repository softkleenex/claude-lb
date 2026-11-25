"""Regressions for failures that only show up under concurrency or partial streams.

Each of these shipped: the unit tests passed because every one of them sent a single
request and read it to the end.
"""

from __future__ import annotations

import asyncio
import json
import time

import httpx
import pytest
from sqlalchemy import select

from app.core.config import get_settings
from app.db.models import Account, ApiKey, ModelCatalogEntry, UsageDaily
from app.db.session import session_scope
from app.modules.api_keys import service as key_service
from app.modules.health import service as health_service
from app.modules.proxy import service as proxy_service
from app.modules.proxy.service import record_request, wrap_stream_for_accounting
from app.modules.proxy.usage_parser import Usage
from tests.test_proxy_api import (
    MESSAGE_BODY,
    SSE_BODY,
    add_account,
    get_account,
    get_logs,
    make_client,
    ok_json,
    ordered_routing,  # noqa: F401 - fixture
)

STREAM_BODY = {**MESSAGE_BODY, "stream": True}


async def issue_key(**limits) -> str:
    async with session_scope() as session:
        issued = await key_service.create_api_key(session, name=f"k{len(limits)}", **limits)
        return issued.plaintext


async def drain_finalizers() -> None:
    while proxy_service._finalizers:
        await asyncio.gather(*list(proxy_service._finalizers), return_exceptions=True)


def slow_stream(delay: float):
    async def handler(request: httpx.Request) -> httpx.Response:
        async def body():
            head, _, tail = SSE_BODY.partition(b"event: message_delta")
            yield head
            await asyncio.sleep(delay)
            yield b"event: message_delta" + tail

        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body())

    return handler


class TestConnectionPool:
    async def test_concurrent_authenticated_streams_do_not_exhaust_the_pool(self, monkeypatch):
        """The key check used to hold a request-scoped connection for the whole
        response while the proxy opened more. Fifteen concurrent requests then held
        all 5+10 pooled connections and waited on each other until a 30 s timeout."""
        monkeypatch.setattr(get_settings(), "require_api_key", True)
        await add_account("primary")
        key = await issue_key()

        async for client in make_client(slow_stream(0.3)):
            responses = await asyncio.wait_for(
                asyncio.gather(
                    *(
                        client.post("/v1/messages", json=STREAM_BODY, headers={"x-api-key": key})
                        for _ in range(24)
                    )
                ),
                timeout=20,
            )
        await drain_finalizers()

        assert [r.status_code for r in responses] == [200] * 24
        assert len(await get_logs()) == 24


class TestAbortedStreams:
    async def _account(self) -> str:
        return await add_account("primary")

    @staticmethod
    async def _upstream():
        yield SSE_BODY.partition(b"event: message_delta")[0]
        await asyncio.sleep(3600)
        yield b"never"

    async def test_client_hangup_via_aclose_is_still_logged(self):
        account_id = await self._account()
        stream = wrap_stream_for_accounting(
            self._upstream(),
            account_id=account_id,
            api_key_id=None,
            path="/v1/messages",
            model="claude-opus-5",
            status_code=200,
            started_at=time.perf_counter(),
            attempts=1,
        )
        await stream.__anext__()
        await stream.aclose()
        await drain_finalizers()

        [log] = await get_logs()
        assert log.input_tokens == 11, "input tokens are billed upstream even when the stream is cut"
        assert "disconnected" in (log.error or "")

    async def test_cancellation_mid_stream_is_still_logged_and_releases_the_slot(self):
        account_id = await self._account()
        released = []
        stream = wrap_stream_for_accounting(
            self._upstream(),
            account_id=account_id,
            api_key_id=None,
            path="/v1/messages",
            model="claude-opus-5",
            status_code=200,
            started_at=time.perf_counter(),
            attempts=1,
            on_finished=lambda: released.append(True),
        )

        async def consume():
            async for _ in stream:
                pass

        task = asyncio.create_task(consume())
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await drain_finalizers()

        assert len(await get_logs()) == 1
        assert released == [True]


class TestBudgetsUnderConcurrency:
    async def test_request_cap_holds_against_a_burst(self, monkeypatch):
        """Only logged requests were counted, and nothing in a burst is logged yet when
        the rest check — a cap of 3 served 10 of 10."""
        monkeypatch.setattr(get_settings(), "require_api_key", True)
        await add_account("primary")
        key = await issue_key(max_requests_per_window=3)

        async def slow_ok(request: httpx.Request) -> httpx.Response:
            await asyncio.sleep(0.2)
            return ok_json([])(request)

        async for client in make_client(slow_ok):
            responses = await asyncio.gather(
                *(
                    client.post("/v1/messages", json=MESSAGE_BODY, headers={"x-api-key": key})
                    for _ in range(10)
                )
            )

        codes = sorted(r.status_code for r in responses)
        assert codes == [200] * 3 + [429] * 7
        assert key_service._inflight == {}, "every admitted request gave its slot back"

    async def test_token_cap_counts_cache_traffic(self, monkeypatch):
        monkeypatch.setattr(get_settings(), "require_api_key", True)
        account_id = await add_account("primary")
        key = await issue_key(max_tokens_per_window=1_000)
        async with session_scope() as session:
            key_id = (await session.execute(select(ApiKey.id))).scalar_one()
        await record_request(
            account_id=account_id,
            api_key_id=key_id,
            path="/v1/messages",
            model="claude-opus-5",
            status_code=200,
            streaming=False,
            started_at=time.perf_counter(),
            attempts=1,
            usage=Usage(input_tokens=10, output_tokens=10, cache_read_input_tokens=5_000),
        )

        async for client in make_client(ok_json([])):
            response = await client.post("/v1/messages", json=MESSAGE_BODY, headers={"x-api-key": key})
        assert response.status_code == 429


class TestForbiddenIsNotRevoked:
    async def test_a_403_fails_over_without_disabling_anyone(self, ordered_routing):  # noqa: F811
        first = await add_account("first", priority=10)
        second = await add_account("second", priority=0)
        calls: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            if len(calls) == 1:
                return httpx.Response(403, json={"type": "error", "error": {"type": "permission_error"}})
            return ok_json([])(request)

        async for client in make_client(handler):
            response = await client.post("/v1/messages", json=MESSAGE_BODY)

        assert response.status_code == 200
        assert (await get_account(first)).enabled
        assert (await get_account(second)).enabled

    async def test_a_403_from_everyone_reaches_the_client_and_disables_no_one(self):
        ids = [await add_account(f"a{i}") for i in range(3)]

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(403, json={"type": "error", "error": {"type": "permission_error"}})

        async for client in make_client(handler):
            response = await client.post("/v1/messages", json=MESSAGE_BODY)

        assert response.status_code == 403
        assert json.loads(response.content)["error"]["type"] == "permission_error"
        for account_id in ids:
            assert (await get_account(account_id)).enabled

    async def test_admin_api_is_not_relayed(self):
        account_id = await add_account("primary")
        async for client in make_client(ok_json([])):
            response = await client.get("/v1/organizations/me")
        assert response.status_code == 404
        assert (await get_account(account_id)).enabled


class TestHeaderHygiene:
    async def test_cookies_and_connection_scoped_headers_stay_local(self):
        await add_account("primary")
        calls: list[httpx.Request] = []
        async for client in make_client(ok_json(calls)):
            await client.post(
                "/v1/messages",
                json=MESSAGE_BODY,
                headers={"cookie": "clb_session=secret", "connection": "x-hop", "x-hop": "1"},
            )
        [sent] = calls
        assert "cookie" not in sent.headers
        assert "x-hop" not in sent.headers


class TestModelCatalogAliases:
    async def test_an_alias_matches_its_dated_snapshot(self):
        account_id = await add_account("synced")
        async with session_scope() as session:
            session.add(ModelCatalogEntry(account_id=account_id, model_id="claude-sonnet-4-5-20250929"))
        async with session_scope() as session:
            assert await health_service.unsupported_accounts(session, "claude-sonnet-4-5") == set()
            assert await health_service.unsupported_accounts(session, "claude-haiku-4-5") == {account_id}

    async def test_like_wildcards_in_the_request_are_literal(self):
        account_id = await add_account("synced")
        async with session_scope() as session:
            session.add(ModelCatalogEntry(account_id=account_id, model_id="claude-opus-5-20260101"))
        async with session_scope() as session:
            assert await health_service.unsupported_accounts(session, "claude%") == {account_id}


class TestCounters:
    async def test_counters_and_rollups_add_up_under_concurrency(self):
        account_id = await add_account("primary")

        async def one():
            await record_request(
                account_id=account_id,
                api_key_id=None,
                path="/v1/messages",
                model=None,
                status_code=200,
                streaming=False,
                started_at=time.perf_counter(),
                attempts=1,
                usage=Usage(input_tokens=1, output_tokens=2),
            )

        await asyncio.gather(*(one() for _ in range(20)))

        async with session_scope() as session:
            account = await session.get(Account, account_id)
            assert account.total_requests == 20
            assert account.total_output_tokens == 40
            rows = list((await session.execute(select(UsageDaily))).scalars())
        assert sum(r.requests for r in rows) == 20

    async def test_an_oversized_client_model_string_is_clipped_not_fatal(self):
        await record_request(
            account_id=None,
            api_key_id=None,
            path="/v1/messages",
            model="x" * 500,
            status_code=400,
            streaming=False,
            started_at=time.perf_counter(),
            attempts=1,
            usage=Usage(),
        )
        [log] = await get_logs()
        assert len(log.model) == 128
