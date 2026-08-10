from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from app.core.crypto import decrypt, encrypt
from app.db.models import Account
from app.db.session import session_scope
from app.modules.accounts import credentials
from tests.test_load_balancer import make_account
from tests.test_proxy_api import MESSAGE_BODY, add_account, get_account, make_client

TOKEN_ENDPOINT = "https://auth.example.test/v1/oauth/token"


async def add_oauth_account(
    name: str,
    *,
    access_token: str = "tok-initial",
    refresh_token: str | None = "refresh-1",
    expires_in: int | None = 3600,
    auth_scheme: str = "bearer",
    extra_headers: dict | None = None,
    **kwargs,
) -> str:
    async with session_scope() as session:
        account = Account(
            name=name,
            provider=credentials.PROVIDER_OAUTH,
            encrypted_credential=encrypt(access_token),
            credential_hint=access_token[-6:],
            auth_scheme=auth_scheme,
            extra_headers_json=json.dumps(extra_headers or {}),
            oauth_refresh_token_encrypted=encrypt(refresh_token) if refresh_token else None,
            oauth_token_endpoint=TOKEN_ENDPOINT if refresh_token else None,
            oauth_client_id="client-abc",
            credential_expires_at=(datetime.now(UTC) + timedelta(seconds=expires_in) if expires_in else None),
            **kwargs,
        )
        session.add(account)
        await session.flush()
        return account.id


def token_server(calls: list[httpx.Request], *, rotate: bool = False, fail: bool = False):
    issued = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if str(request.url) == TOKEN_ENDPOINT:
            if fail:
                return httpx.Response(400, json={"error": "invalid_grant"})
            issued["n"] += 1
            body = {"access_token": f"tok-{issued['n']}", "expires_in": 3600, "token_type": "Bearer"}
            if rotate:
                body["refresh_token"] = f"refresh-{issued['n'] + 1}"
            return httpx.Response(200, json=body)
        return httpx.Response(
            200,
            json={"id": "m", "model": "claude-opus-5", "usage": {"input_tokens": 1, "output_tokens": 1}},
        )

    return handler


class TestHeaderApplication:
    def test_api_key_scheme_uses_x_api_key(self):
        cred = credentials.ResolvedCredential("a", "sk-ant-1", "x-api-key")
        assert cred.apply({})["x-api-key"] == "sk-ant-1"

    def test_bearer_scheme_uses_authorization(self):
        cred = credentials.ResolvedCredential("a", "tok", "bearer")
        headers = cred.apply({})
        assert headers["authorization"] == "Bearer tok"
        assert "x-api-key" not in headers

    def test_a_stale_client_auth_header_is_stripped(self):
        """The client's own key must never survive into the upstream request."""
        cred = credentials.ResolvedCredential("a", "tok", "bearer")
        headers = cred.apply({"x-api-key": "clb_client_key", "Authorization": "Bearer someone-else"})
        assert "x-api-key" not in headers
        assert headers["authorization"] == "Bearer tok"

    def test_extra_headers_are_merged(self):
        cred = credentials.ResolvedCredential("a", "tok", "bearer", {"anthropic-beta": "some-flag"})
        assert cred.apply({})["anthropic-beta"] == "some-flag"

    def test_extra_headers_cannot_override_the_resolved_auth(self):
        cred = credentials.ResolvedCredential("a", "tok", "bearer", {"authorization": "Bearer evil"})
        assert cred.apply({})["authorization"] == "Bearer tok"

    @pytest.mark.parametrize("raw", ["", None, "not json", "[]", '"string"'])
    def test_malformed_extra_headers_are_ignored(self, raw):
        assert credentials.parse_extra_headers(raw) == {}


class TestRefreshDecision:
    def test_api_key_accounts_never_refresh(self):
        account = make_account("a", provider=credentials.PROVIDER_API_KEY)
        assert not credentials.needs_refresh(account)

    def test_oauth_without_a_refresh_token_does_not_refresh(self):
        account = make_account(
            "a",
            provider=credentials.PROVIDER_OAUTH,
            credential_expires_at=datetime.now(UTC) - timedelta(hours=1),
        )
        assert not credentials.needs_refresh(account)

    def test_no_recorded_expiry_means_no_refresh(self):
        account = make_account(
            "a",
            provider=credentials.PROVIDER_OAUTH,
            oauth_refresh_token_encrypted="x",
            oauth_token_endpoint=TOKEN_ENDPOINT,
            credential_expires_at=None,
        )
        assert not credentials.needs_refresh(account)

    def test_a_token_inside_the_skew_window_refreshes_early(self):
        now = datetime.now(UTC)
        account = make_account(
            "a",
            provider=credentials.PROVIDER_OAUTH,
            oauth_refresh_token_encrypted="x",
            oauth_token_endpoint=TOKEN_ENDPOINT,
            credential_expires_at=now + timedelta(seconds=30),
        )
        assert credentials.needs_refresh(account, now=now), "must not wait until the deadline"

    def test_a_healthy_token_is_left_alone(self):
        now = datetime.now(UTC)
        account = make_account(
            "a",
            provider=credentials.PROVIDER_OAUTH,
            oauth_refresh_token_encrypted="x",
            oauth_token_endpoint=TOKEN_ENDPOINT,
            credential_expires_at=now + timedelta(hours=1),
        )
        assert not credentials.needs_refresh(account, now=now)

    def test_naive_expiry_from_sqlite_is_handled(self):
        now = datetime.now(UTC)
        account = make_account(
            "a",
            provider=credentials.PROVIDER_OAUTH,
            oauth_refresh_token_encrypted="x",
            oauth_token_endpoint=TOKEN_ENDPOINT,
            credential_expires_at=(now + timedelta(hours=1)).replace(tzinfo=None),
        )
        assert not credentials.needs_refresh(account, now=now)


class TestSkewScaling:
    """A provider issuing tokens shorter than REFRESH_SKEW would otherwise be
    re-granted on every single request — a fast way to get the token endpoint to
    start refusing you."""

    def _short_lived(self, *, lifetime: int, remaining: int, now: datetime) -> Account:
        return make_account(
            "a",
            provider=credentials.PROVIDER_OAUTH,
            oauth_refresh_token_encrypted="x",
            oauth_token_endpoint=TOKEN_ENDPOINT,
            credential_lifetime_seconds=lifetime,
            credential_expires_at=now + timedelta(seconds=remaining),
        )

    def test_skew_is_capped_at_half_the_token_lifetime(self):
        account = make_account("a", credential_lifetime_seconds=40)
        assert credentials.effective_skew(account) == timedelta(seconds=20)

    def test_a_long_lived_token_uses_the_full_skew(self):
        account = make_account("a", credential_lifetime_seconds=3600)
        assert credentials.effective_skew(account) == credentials.REFRESH_SKEW

    def test_unknown_lifetime_falls_back_to_the_full_skew(self):
        assert credentials.effective_skew(make_account("a")) == credentials.REFRESH_SKEW

    def test_a_fresh_short_lived_token_is_not_refreshed(self):
        now = datetime.now(UTC)
        account = self._short_lived(lifetime=40, remaining=35, now=now)
        assert not credentials.needs_refresh(account, now=now)

    def test_a_short_lived_token_still_refreshes_near_its_deadline(self):
        now = datetime.now(UTC)
        account = self._short_lived(lifetime=40, remaining=15, now=now)
        assert credentials.needs_refresh(account, now=now)

    async def test_short_lived_tokens_do_not_refresh_on_every_request(self, proxy_calls):
        account_id = await add_oauth_account("sub", access_token="tok-fresh", expires_in=40)
        async with session_scope() as session:
            account = await session.get(Account, account_id)
            account.credential_lifetime_seconds = 40

        async for client in make_client(token_server(proxy_calls)):
            for _ in range(5):
                await client.post("/v1/messages", json=MESSAGE_BODY)

        grants = [c for c in proxy_calls if str(c.url) == TOKEN_ENDPOINT]
        assert grants == [], f"a fresh 40s token should serve all 5 requests, saw {len(grants)} grants"


class TestRefreshExecution:
    async def test_an_expired_token_is_refreshed_before_the_request(self, proxy_calls):
        account_id = await add_oauth_account("sub", access_token="tok-old", expires_in=10)

        async for client in make_client(token_server(proxy_calls)):
            response = await client.post("/v1/messages", json=MESSAGE_BODY)

        assert response.status_code == 200
        # First upstream call is the token grant, second carries the new token.
        assert str(proxy_calls[0].url) == TOKEN_ENDPOINT
        assert proxy_calls[1].headers["authorization"] == "Bearer tok-1"

        account = await get_account(account_id)
        assert decrypt(account.encrypted_credential) == "tok-1"
        assert account.last_refresh_at is not None

    async def test_a_healthy_token_is_used_without_a_refresh(self, proxy_calls):
        await add_oauth_account("sub", access_token="tok-good", expires_in=3600)

        async for client in make_client(token_server(proxy_calls)):
            await client.post("/v1/messages", json=MESSAGE_BODY)

        assert all(str(c.url) != TOKEN_ENDPOINT for c in proxy_calls), "no refresh was needed"
        assert proxy_calls[0].headers["authorization"] == "Bearer tok-good"

    async def test_the_refresh_grant_is_rfc6749_shaped(self, proxy_calls):
        await add_oauth_account("sub", expires_in=10)

        async for client in make_client(token_server(proxy_calls)):
            await client.post("/v1/messages", json=MESSAGE_BODY)

        grant = proxy_calls[0]
        assert grant.method == "POST"
        assert grant.headers["content-type"] == "application/x-www-form-urlencoded"
        body = grant.content.decode()
        assert "grant_type=refresh_token" in body
        assert "refresh_token=refresh-1" in body
        assert "client_id=client-abc" in body

    async def test_a_rotated_refresh_token_is_persisted(self, proxy_calls):
        """Providers that rotate invalidate the old token; losing it bricks the account."""
        account_id = await add_oauth_account("sub", expires_in=10)

        async for client in make_client(token_server(proxy_calls, rotate=True)):
            await client.post("/v1/messages", json=MESSAGE_BODY)

        account = await get_account(account_id)
        assert decrypt(account.oauth_refresh_token_encrypted) == "refresh-2"

    async def test_credentials_are_encrypted_at_rest(self):
        account_id = await add_oauth_account("sub", access_token="tok-secret", refresh_token="rt-secret")
        account = await get_account(account_id)
        assert "tok-secret" not in account.encrypted_credential
        assert "rt-secret" not in account.oauth_refresh_token_encrypted

    async def test_concurrent_requests_refresh_only_once(self, proxy_calls):
        """Without the per-account lock, a burst would refresh N times — and with a
        rotating provider, invalidate all but one of the new tokens."""
        await add_oauth_account("sub", expires_in=10)

        async for client in make_client(token_server(proxy_calls)):
            await asyncio.gather(*(client.post("/v1/messages", json=MESSAGE_BODY) for _ in range(8)))

        grants = [c for c in proxy_calls if str(c.url) == TOKEN_ENDPOINT]
        assert len(grants) == 1, f"expected one token grant, got {len(grants)}"


class TestRefreshFailure:
    async def test_a_rejected_refresh_fails_the_attempt(self, proxy_calls):
        await add_oauth_account("sub", expires_in=10)

        async for client in make_client(token_server(proxy_calls, fail=True)):
            response = await client.post("/v1/messages", json=MESSAGE_BODY)

        assert response.status_code >= 400
        assert all(str(c.url) == TOKEN_ENDPOINT for c in proxy_calls), "never reached the API"

    async def test_repeated_refresh_failures_disable_the_account(self, proxy_calls):
        account_id = await add_oauth_account("sub", expires_in=10)

        async for client in make_client(token_server(proxy_calls, fail=True)):
            for _ in range(credentials.MAX_REFRESH_FAILURES):
                await client.post("/v1/messages", json=MESSAGE_BODY)

        account = await get_account(account_id)
        assert account.enabled is False
        assert "refresh failed" in (account.disabled_reason or "")

    async def test_a_successful_refresh_clears_the_failure_count(self, proxy_calls):
        account_id = await add_oauth_account("sub", expires_in=10)
        state = {"fail": True}

        def handler(request: httpx.Request) -> httpx.Response:
            proxy_calls.append(request)
            if str(request.url) == TOKEN_ENDPOINT:
                if state["fail"]:
                    return httpx.Response(400, json={"error": "temporarily_unavailable"})
                return httpx.Response(200, json={"access_token": "tok-ok", "expires_in": 3600})
            return httpx.Response(
                200,
                json={"id": "m", "model": "claude-opus-5", "usage": {"input_tokens": 1, "output_tokens": 1}},
            )

        async for client in make_client(handler):
            await client.post("/v1/messages", json=MESSAGE_BODY)
            state["fail"] = False
            await client.post("/v1/messages", json=MESSAGE_BODY)

        account = await get_account(account_id)
        assert account.refresh_failures == 0
        assert account.enabled is True


class TestReauthOn401:
    async def test_an_oauth_account_gets_one_forced_refresh_before_being_written_off(self, proxy_calls):
        """An access token can be rejected earlier than its advertised expiry."""
        account_id = await add_oauth_account("sub", access_token="tok-stale", expires_in=3600)
        state = {"accept": "tok-1"}

        def handler(request: httpx.Request) -> httpx.Response:
            proxy_calls.append(request)
            if str(request.url) == TOKEN_ENDPOINT:
                return httpx.Response(200, json={"access_token": "tok-1", "expires_in": 3600})
            if request.headers.get("authorization") != f"Bearer {state['accept']}":
                return httpx.Response(401, json={"type": "error", "error": {"type": "authentication_error"}})
            return httpx.Response(
                200,
                json={"id": "m", "model": "claude-opus-5", "usage": {"input_tokens": 1, "output_tokens": 1}},
            )

        async for client in make_client(handler):
            response = await client.post("/v1/messages", json=MESSAGE_BODY)

        assert response.status_code == 200, "the retry after re-auth should succeed"
        account = await get_account(account_id)
        assert account.enabled is True, "a recoverable 401 must not disable the account"

    async def test_re_auth_is_attempted_only_once_per_request(self, proxy_calls):
        await add_oauth_account("sub", access_token="tok-stale", expires_in=3600)

        def always_401(request: httpx.Request) -> httpx.Response:
            proxy_calls.append(request)
            if str(request.url) == TOKEN_ENDPOINT:
                return httpx.Response(200, json={"access_token": "tok-new", "expires_in": 3600})
            return httpx.Response(401, json={"type": "error", "error": {"type": "authentication_error"}})

        async for client in make_client(always_401):
            response = await client.post("/v1/messages", json=MESSAGE_BODY)

        assert response.status_code == 401
        grants = [c for c in proxy_calls if str(c.url) == TOKEN_ENDPOINT]
        assert len(grants) == 1, "must not loop refreshing against a genuinely dead credential"

    async def test_a_static_api_key_is_not_re_authenticated(self, proxy_calls):
        """A rejected API key will be rejected again; retrying just burns requests."""
        account_id = await add_account("plain", key="sk-ant-dead")

        def handler(request: httpx.Request) -> httpx.Response:
            proxy_calls.append(request)
            return httpx.Response(401, json={"type": "error", "error": {"type": "authentication_error"}})

        async for client in make_client(handler):
            await client.post("/v1/messages", json=MESSAGE_BODY)

        assert len(proxy_calls) == 1
        assert (await get_account(account_id)).enabled is False


class TestMixedPool:
    async def test_api_key_and_oauth_accounts_coexist(self, proxy_calls):
        await add_account("console", key="sk-ant-console", priority=0)
        await add_oauth_account("oauth", access_token="tok-good", expires_in=3600, priority=0)

        seen: set[str] = set()

        def handler(request: httpx.Request) -> httpx.Response:
            proxy_calls.append(request)
            if "authorization" in request.headers:
                seen.add("bearer")
            elif "x-api-key" in request.headers:
                seen.add("x-api-key")
            return httpx.Response(
                200,
                json={"id": "m", "model": "claude-opus-5", "usage": {"input_tokens": 1, "output_tokens": 1}},
            )

        async for client in make_client(handler):
            for i in range(20):
                await client.post(
                    "/v1/messages",
                    json={**MESSAGE_BODY, "messages": [{"role": "user", "content": f"topic {i}"}]},
                )

        assert seen == {"bearer", "x-api-key"}, f"both auth schemes should be exercised, saw {seen}"


class TestAccountsApiForOauth:
    async def test_creating_an_oauth_account_defaults_to_bearer(self):
        async for client in make_client(token_server([])):
            created = (
                await client.post(
                    "/api/accounts",
                    json={
                        "name": "sub",
                        "api_key": "tok-access",
                        "provider": "oauth",
                        "oauth_refresh_token": "rt",
                        "oauth_token_endpoint": TOKEN_ENDPOINT,
                        "expires_in_seconds": 3600,
                    },
                )
            ).json()

        assert created["provider"] == "oauth"
        assert created["auth_scheme"] == "bearer"
        assert created["credential_expires_at"] is not None

    async def test_a_refresh_token_without_an_endpoint_is_rejected(self):
        async for client in make_client(token_server([])):
            response = await client.post(
                "/api/accounts",
                json={
                    "name": "sub",
                    "api_key": "tok",
                    "provider": "oauth",
                    "oauth_refresh_token": "rt",
                },
            )
        assert response.status_code == 422

    async def test_oauth_fields_are_rejected_on_an_api_key_account(self):
        async for client in make_client(token_server([])):
            response = await client.post(
                "/api/accounts",
                json={"name": "x", "api_key": "sk-ant-1", "oauth_refresh_token": "rt"},
            )
        assert response.status_code == 422

    async def test_the_response_never_echoes_the_tokens(self):
        async for client in make_client(token_server([])):
            created = (
                await client.post(
                    "/api/accounts",
                    json={
                        "name": "sub",
                        "api_key": "tok-supersecret",
                        "provider": "oauth",
                        "oauth_refresh_token": "rt-supersecret",
                        "oauth_token_endpoint": TOKEN_ENDPOINT,
                    },
                )
            ).json()
        blob = json.dumps(created)
        assert "supersecret" not in blob

    async def test_extra_headers_round_trip_to_the_upstream(self, proxy_calls):
        async for client in make_client(token_server(proxy_calls)):
            await client.post(
                "/api/accounts",
                json={
                    "name": "sub",
                    "api_key": "tok-good",
                    "provider": "oauth",
                    "extra_headers": {"anthropic-beta": "some-flag-2026-01-01"},
                    "expires_in_seconds": 3600,
                },
            )
            await client.post("/v1/messages", json=MESSAGE_BODY)

        api_calls = [c for c in proxy_calls if str(c.url) != TOKEN_ENDPOINT]
        assert api_calls[0].headers["anthropic-beta"] == "some-flag-2026-01-01"
