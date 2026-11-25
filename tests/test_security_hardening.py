"""Browser-borne attacks on the management plane, and brute force against login."""

from __future__ import annotations

import time

from app.core import totp
from app.db.session import session_scope
from app.modules.auth import service as auth
from app.modules.usage import reports
from tests.test_auth import PASSWORD
from tests.test_proxy_api import make_client, ok_json


async def configure(client, *, with_totp: bool = False) -> str | None:
    assert (await client.post("/api/auth/password", json={"password": PASSWORD})).status_code == 200
    if not with_totp:
        return None
    secret = (await client.post("/api/auth/totp/enroll")).json()["secret"]
    assert (
        await client.post("/api/auth/totp/confirm", json={"code": totp.now_code(secret)})
    ).status_code == 204
    return secret


class TestDnsRebinding:
    async def test_loopback_peer_with_a_foreign_host_is_not_trusted(self):
        """Under DNS rebinding a hostile page's domain resolves to 127.0.0.1: the
        request arrives from loopback, but names that domain in Host."""
        async for client in make_client(ok_json([])):
            rebound = await client.get("/api/accounts", headers={"host": "attacker.example:2456"})
            local = await client.get("/api/accounts", headers={"host": "127.0.0.1:2456"})
            ipv6 = await client.get("/api/accounts", headers={"host": "[::1]:2456"})
        assert rebound.status_code == 401
        assert local.status_code == 200
        assert ipv6.status_code == 200

    def test_host_header_parsing(self):
        assert auth.is_loopback_host_header("localhost")
        assert auth.is_loopback_host_header("LOCALHOST:2456")
        assert auth.is_loopback_host_header("127.0.0.1:2456")
        assert auth.is_loopback_host_header("[::1]:2456")
        assert not auth.is_loopback_host_header("localhost.attacker.example")
        assert not auth.is_loopback_host_header("127.0.0.1.nip.io")
        assert not auth.is_loopback_host_header(None)


class TestCrossSiteWrites:
    async def test_a_cross_origin_post_is_refused_before_a_password_exists(self):
        async for client in make_client(ok_json([])):
            response = await client.post(
                "/api/auth/password",
                json={"password": "attacker-chosen-1"},
                headers={"origin": "https://attacker.example"},
            )
            status = (await client.get("/api/auth/status")).json()
        assert response.status_code == 403
        assert status["configured"] is False, "the attacker did not get to set the password"

    async def test_fetch_metadata_cross_site_is_refused(self):
        async for client in make_client(ok_json([])):
            response = await client.post("/api/settings/reset", headers={"sec-fetch-site": "cross-site"})
        assert response.status_code == 403

    async def test_same_origin_and_non_browser_writes_pass(self):
        async for client in make_client(ok_json([])):
            same = await client.post("/api/settings/reset", headers={"origin": "http://localhost"})
            cli = await client.post("/api/settings/reset")
        assert same.status_code != 403
        assert cli.status_code != 403

    async def test_a_reverse_proxy_that_rewrites_host_still_works(self):
        async for client in make_client(ok_json([])):
            response = await client.post(
                "/api/settings/reset",
                headers={
                    "origin": "https://lb.example.com",
                    "host": "127.0.0.1:2456",
                    "x-forwarded-host": "lb.example.com",
                },
            )
        assert response.status_code != 403

    async def test_proxy_routes_are_not_subject_to_it(self):
        """Browser-based SDK clients legitimately call /v1 cross-origin."""
        async for client in make_client(ok_json([])):
            response = await client.post("/v1/messages", json={}, headers={"origin": "https://app.example"})
        assert response.status_code != 403


class TestTotpReplay:
    async def test_a_code_cannot_be_used_twice(self):
        async for client in make_client(ok_json([])):
            secret = await configure(client, with_totp=True)
            code = totp.now_code(secret, at=time.time() + totp.PERIOD_SECONDS)
            client.cookies.clear()
            first = await client.post("/api/auth/login", json={"password": PASSWORD, "totp_code": code})
            client.cookies.clear()
            replay = await client.post("/api/auth/login", json={"password": PASSWORD, "totp_code": code})
        assert first.status_code == 200
        assert replay.status_code == 401

    async def test_starting_a_new_enrollment_leaves_the_current_factor_on(self):
        async for client in make_client(ok_json([])):
            await configure(client, with_totp=True)
            await client.post("/api/auth/totp/enroll")
            client.cookies.clear()
            password_only = await client.post("/api/auth/login", json={"password": PASSWORD})
        assert password_only.status_code == 401
        async with session_scope() as session:
            assert (await auth.get_credential(session)).totp_enabled


class TestLoginThrottle:
    async def test_repeated_failures_are_throttled_and_success_is_then_refused_too(self):
        async for client in make_client(ok_json([])):
            await configure(client)
            client.cookies.clear()
            codes = [
                (await client.post("/api/auth/login", json={"password": "wrong-password"})).status_code
                for _ in range(auth.LOGIN_MAX_FAILURES_PER_CLIENT)
            ]
            blocked = await client.post("/api/auth/login", json={"password": PASSWORD})
        assert codes == [401] * auth.LOGIN_MAX_FAILURES_PER_CLIENT
        assert blocked.status_code == 429

    def test_the_window_expires(self, monkeypatch):
        clock = [1000.0]
        monkeypatch.setattr(auth.time, "monotonic", lambda: clock[0])
        for _ in range(auth.LOGIN_MAX_FAILURES_PER_CLIENT):
            auth.record_login_failure("198.51.100.1")
        try:
            auth.check_login_allowed("198.51.100.1")
            raise AssertionError("should be throttled")
        except auth.AuthError as exc:
            assert exc.status_code == 429
        clock[0] += auth.LOGIN_WINDOW_SECONDS + 1
        auth.check_login_allowed("198.51.100.1")


class TestCsvFormulaInjection:
    def test_formula_like_labels_are_neutralized(self):
        assert reports._cell('=HYPERLINK("http://x")').startswith("'")
        assert reports._cell("@SUM(A1)") == "'@SUM(A1)"
        assert reports._cell("claude-opus-5") == "claude-opus-5"
