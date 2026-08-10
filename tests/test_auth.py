from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
import pytest

from app.core import totp
from app.db.session import session_scope
from app.main import create_app
from app.modules.auth import service as auth
from app.modules.auth.dependencies import BOOTSTRAP_HEADER
from tests.test_proxy_api import MESSAGE_BODY, add_account, make_client, ok_json

PASSWORD = "correct-horse-battery"
GUARDED = ("/api/accounts", "/api/keys", "/api/usage/summary", "/api/settings", "/api/audit")


async def make_remote_client(handler, host: str = "203.0.113.7") -> AsyncIterator[httpx.AsyncClient]:
    """Same app, but the request appears to arrive from off-box.

    ASGITransport reports 127.0.0.1 by default, which silently satisfies the
    loopback bootstrap path — so remote behaviour needs an explicit client.
    """
    app = create_app()
    transport = httpx.ASGITransport(app=app, client=(host, 54321))
    async with httpx.AsyncClient(transport=transport, base_url="http://lb") as client:
        async with app.router.lifespan_context(app):
            await app.state.http_client.aclose()
            app.state.http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            yield client


class TestTotp:
    def test_generated_code_verifies(self):
        secret = totp.generate_secret()
        assert totp.verify(secret, totp.now_code(secret))

    def test_wrong_code_is_rejected(self):
        secret = totp.generate_secret()
        wrong = "000000" if totp.now_code(secret) != "000000" else "111111"
        assert not totp.verify(secret, wrong)

    def test_matches_the_rfc6238_reference_vector(self):
        # RFC 6238 Appendix B: secret "12345678901234567890", T=59 → 94287082 (8 digits).
        # Truncated to the 6 digits this implementation emits.
        import base64

        secret = base64.b32encode(b"12345678901234567890").decode()
        assert totp.now_code(secret, at=59) == "287082"

    def test_tolerates_small_clock_drift(self):
        secret = totp.generate_secret()
        code = totp.now_code(secret, at=1_000_000)
        assert totp.verify(secret, code, at=1_000_000 + totp.PERIOD_SECONDS)
        assert totp.verify(secret, code, at=1_000_000 - totp.PERIOD_SECONDS)

    def test_rejects_a_code_from_far_in_the_past(self):
        secret = totp.generate_secret()
        code = totp.now_code(secret, at=1_000_000)
        assert not totp.verify(secret, code, at=1_000_000 + 600)

    @pytest.mark.parametrize("code", ["", "12345", "1234567", "abcdef", "12 34 56 78"])
    def test_malformed_codes_are_rejected(self, code):
        assert not totp.verify(totp.generate_secret(), code)

    def test_provisioning_uri_is_scannable(self):
        uri = totp.provisioning_uri("ABCDEF", account_name="dashboard")
        assert uri.startswith("otpauth://totp/claude-lb%3Adashboard?")
        assert "secret=ABCDEF" in uri and "issuer=claude-lb" in uri


class TestPasswordHashing:
    def test_same_password_and_salt_are_stable(self):
        assert auth.hash_password("pw", "00" * 16) == auth.hash_password("pw", "00" * 16)

    def test_different_salts_diverge(self):
        assert auth.hash_password("pw", "00" * 16) != auth.hash_password("pw", "11" * 16)

    async def test_password_is_not_stored_in_the_clear(self):
        async with session_scope() as session:
            await auth.set_password(session, PASSWORD)
            credential = await auth.get_credential(session)
        assert PASSWORD not in credential.password_hash
        assert credential.password_hash != PASSWORD

    async def test_short_password_is_rejected(self):
        async with session_scope() as session:
            with pytest.raises(auth.AuthError):
                await auth.set_password(session, "short")


class TestBootstrapAccess:
    async def test_loopback_may_use_the_management_plane_before_a_password_exists(self):
        async for client in make_client(ok_json([])):
            for path in GUARDED:
                assert (await client.get(path)).status_code == 200, path

    async def test_remote_access_is_refused_before_a_password_exists(self):
        async for client in make_remote_client(ok_json([])):
            for path in GUARDED:
                response = await client.get(path)
                assert response.status_code == 401, path
                assert "bootstrap token" in response.json()["detail"]

    async def test_remote_access_works_with_the_bootstrap_token(self):
        async for client in make_remote_client(ok_json([])):
            response = await client.get("/api/accounts", headers={BOOTSTRAP_HEADER: auth.bootstrap_token()})
        assert response.status_code == 200

    async def test_a_wrong_bootstrap_token_is_refused(self):
        async for client in make_remote_client(ok_json([])):
            response = await client.get("/api/accounts", headers={BOOTSTRAP_HEADER: "nope"})
        assert response.status_code == 401

    async def test_status_is_readable_without_authentication(self):
        async for client in make_remote_client(ok_json([])):
            response = await client.get("/api/auth/status")
        assert response.status_code == 200
        assert response.json()["configured"] is False


class TestLogin:
    async def test_setting_a_password_closes_the_loopback_hole(self):
        async for client in make_client(ok_json([])):
            await client.post("/api/auth/password", json={"password": PASSWORD})
            # The same client keeps its session cookie, so drop it to act as a stranger.
            client.cookies.clear()
            response = await client.get("/api/accounts")
        assert response.status_code == 401

    async def test_setting_a_password_invalidates_the_bootstrap_token(self):
        async for client in make_remote_client(ok_json([])):
            token = auth.bootstrap_token()
            await client.post(
                "/api/auth/password",
                json={"password": PASSWORD},
                headers={BOOTSTRAP_HEADER: token},
            )
            client.cookies.clear()
            response = await client.get("/api/accounts", headers={BOOTSTRAP_HEADER: token})
        assert response.status_code == 401

    async def test_login_grants_a_session_cookie(self):
        async for client in make_client(ok_json([])):
            await client.post("/api/auth/password", json={"password": PASSWORD})
            client.cookies.clear()

            login = await client.post("/api/auth/login", json={"password": PASSWORD})
            assert login.status_code == 200
            assert auth.SESSION_COOKIE in login.cookies

            assert (await client.get("/api/accounts")).status_code == 200

    async def test_wrong_password_is_refused(self):
        async for client in make_client(ok_json([])):
            await client.post("/api/auth/password", json={"password": PASSWORD})
            client.cookies.clear()
            response = await client.post("/api/auth/login", json={"password": "wrong-password"})
        assert response.status_code == 401
        assert response.json()["detail"] == "invalid credentials"

    async def test_logout_revokes_the_session(self):
        async for client in make_client(ok_json([])):
            await client.post("/api/auth/password", json={"password": PASSWORD})
            await client.post("/api/auth/logout")
            client.cookies.clear()
            response = await client.get("/api/accounts")
        assert response.status_code == 401

    async def test_rotating_the_password_requires_the_current_one(self):
        async for client in make_client(ok_json([])):
            await client.post("/api/auth/password", json={"password": PASSWORD})
            without = await client.post("/api/auth/password", json={"password": "another-password"})
            with_current = await client.post(
                "/api/auth/password",
                json={"password": "another-password", "current_password": PASSWORD},
            )
        assert without.status_code == 403
        assert with_current.status_code == 200

    async def test_rotating_the_password_ends_other_sessions(self):
        async for client in make_client(ok_json([])):
            await client.post("/api/auth/password", json={"password": PASSWORD})
            stolen = dict(client.cookies)

            await client.post(
                "/api/auth/password",
                json={"password": "another-password", "current_password": PASSWORD},
            )

            client.cookies.clear()
            for name, value in stolen.items():
                client.cookies.set(name, value)
            response = await client.get("/api/accounts")
        assert response.status_code == 401, "the pre-rotation cookie must stop working"

    async def test_session_cookie_is_httponly(self):
        async for client in make_client(ok_json([])):
            response = await client.post("/api/auth/password", json={"password": PASSWORD})
        assert "httponly" in response.headers["set-cookie"].lower()


class TestTotpEnrollment:
    async def _configured_client(self, client):
        await client.post("/api/auth/password", json={"password": PASSWORD})

    async def test_enrollment_requires_a_confirmed_code_before_taking_effect(self):
        async for client in make_client(ok_json([])):
            await self._configured_client(client)
            enrollment = (await client.post("/api/auth/totp/enroll")).json()

            # Not confirmed yet: password alone still logs in.
            client.cookies.clear()
            assert (await client.post("/api/auth/login", json={"password": PASSWORD})).status_code == 200

            confirmed = await client.post(
                "/api/auth/totp/confirm", json={"code": totp.now_code(enrollment["secret"])}
            )
            assert confirmed.status_code == 204

            # Now password alone is not enough.
            client.cookies.clear()
            assert (await client.post("/api/auth/login", json={"password": PASSWORD})).status_code == 401

            with_code = await client.post(
                "/api/auth/login",
                json={"password": PASSWORD, "totp_code": totp.now_code(enrollment["secret"])},
            )
            assert with_code.status_code == 200

    async def test_confirming_with_a_wrong_code_fails(self):
        async for client in make_client(ok_json([])):
            await self._configured_client(client)
            secret = (await client.post("/api/auth/totp/enroll")).json()["secret"]
            wrong = "000000" if totp.now_code(secret) != "000000" else "111111"
            response = await client.post("/api/auth/totp/confirm", json={"code": wrong})
        assert response.status_code == 403

    async def test_disabling_totp_restores_password_only_login(self):
        async for client in make_client(ok_json([])):
            await self._configured_client(client)
            secret = (await client.post("/api/auth/totp/enroll")).json()["secret"]
            await client.post("/api/auth/totp/confirm", json={"code": totp.now_code(secret)})
            await client.delete("/api/auth/totp")

            client.cookies.clear()
            response = await client.post("/api/auth/login", json={"password": PASSWORD})
        assert response.status_code == 200

    async def test_totp_secret_is_encrypted_at_rest(self):
        async for client in make_client(ok_json([])):
            await self._configured_client(client)
            secret = (await client.post("/api/auth/totp/enroll")).json()["secret"]

        async with session_scope() as session:
            credential = await auth.get_credential(session)
        assert secret not in credential.totp_secret_encrypted


class TestProxyIsUnaffected:
    async def test_proxy_routes_do_not_require_a_dashboard_session(self, proxy_calls):
        """The dashboard gate must not lock out API clients."""
        await add_account("primary")
        async for client in make_client(ok_json(proxy_calls)):
            await client.post("/api/auth/password", json={"password": PASSWORD})
            client.cookies.clear()
            response = await client.post("/v1/messages", json=MESSAGE_BODY)
        assert response.status_code == 200

    async def test_dashboard_html_is_served_so_the_login_form_can_render(self):
        async for client in make_remote_client(ok_json([])):
            response = await client.get("/")
        assert response.status_code == 200
        assert "<title>claude-lb</title>" in response.text

    async def test_health_stays_open_for_probes(self):
        async for client in make_remote_client(ok_json([])):
            assert (await client.get("/health")).status_code == 200


class TestAuditLog:
    async def test_mutations_are_recorded(self):
        async for client in make_client(ok_json([])):
            await client.post("/api/accounts", json={"name": "audited", "api_key": "sk-ant-secret-value"})
            await client.post("/api/keys", json={"name": "audited-key"})
            await client.patch("/api/settings", json={"routing_strategy": "round_robin"})
            events = (await client.get("/api/audit")).json()

        actions = {e["action"] for e in events}
        assert {"account.created", "api_key.created", "settings.updated"} <= actions

    async def test_audit_never_stores_the_credential(self):
        async for client in make_client(ok_json([])):
            await client.post("/api/accounts", json={"name": "acct", "api_key": "sk-ant-supersecret"})
            created = (await client.post("/api/keys", json={"name": "k"})).json()
            events = (await client.get("/api/audit")).json()

        blob = str(events)
        assert "supersecret" not in blob
        assert created["api_key"] not in blob

    async def test_failed_login_is_recorded(self):
        async for client in make_client(ok_json([])):
            await client.post("/api/auth/password", json={"password": PASSWORD})
            await client.post("/api/auth/login", json={"password": "wrong-password"})
            events = (await client.get("/api/audit")).json()

        failures = [e for e in events if e["action"] == "auth.login" and not e["ok"]]
        assert failures, "a failed sign-in must leave a trace"


class TestGateFailsClosed:
    """The bootstrap path opens the management plane to loopback when no password
    exists. That is only safe while none exists — so once this process has seen one,
    a read that comes up empty must mean "sign in", never "unprotected"."""

    async def test_a_missing_credential_row_does_not_reopen_the_gate(self):
        async for client in make_client(ok_json([])):
            await client.post("/api/auth/password", json={"password": PASSWORD})
            client.cookies.clear()

            # Simulate the read that started this: the row is gone as far as this
            # request can tell.
            async with session_scope() as session:
                credential = await auth.get_credential(session)
                await session.delete(credential)

            status = (await client.get("/api/auth/status")).json()
            accounts = await client.get("/api/accounts")

        assert status["configured"] is True, "the latch must survive a missing row"
        assert status["authenticated"] is False
        assert accounts.status_code == 401, "loopback must not become a free pass again"

    async def test_the_latch_is_set_by_observing_a_password_not_only_by_setting_one(self):
        # A process that restarts against an already-configured database learns the
        # latch from its first read.
        async with session_scope() as session:
            await auth.set_password(session, PASSWORD)
        auth._reset_latch_for_tests()
        assert auth.password_ever_seen() is False

        async with session_scope() as session:
            await auth.get_credential(session)
        assert auth.password_ever_seen() is True

    async def test_a_fresh_instance_still_allows_loopback_bootstrap(self):
        """The hardening must not break first-run usability."""
        assert auth.password_ever_seen() is False
        async for client in make_client(ok_json([])):
            assert (await client.get("/api/accounts")).status_code == 200
