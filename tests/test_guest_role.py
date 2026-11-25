"""Read-only guest role: sign-in, what a guest can read, and that every write is refused."""

from __future__ import annotations

import re

from sqlalchemy import select

from claude_lb.db.models import Account, AuditEvent
from claude_lb.db.session import session_scope
from claude_lb.main import create_app
from claude_lb.modules.auth import service as auth
from tests.test_auth import PASSWORD
from tests.test_proxy_api import add_account, make_client, ok_json

GUEST_PASSWORD = "guest-password-1"
# Routes a guest may call with a write method: they are how you get in and out.
OPEN_WRITES = {"/api/auth/login", "/api/auth/logout", "/api/auth/guest/login"}
SAFE = {"GET", "HEAD", "OPTIONS"}


async def admin_with_guest(client, *, guest_password: str | None = None) -> None:
    """Set the dashboard password, switch guest access on, then drop the admin cookie."""
    assert (await client.post("/api/auth/password", json={"password": PASSWORD})).status_code == 200
    body: dict = {"enabled": True}
    if guest_password:
        body["password"] = guest_password
    response = await client.patch("/api/auth/guest", json=body)
    assert response.status_code == 200, response.text
    client.cookies.clear()


def mutating_routes() -> list[tuple[str, str]]:
    """Every write route of the management API, from the app's own OpenAPI schema
    (newer FastAPI keeps included routers nested, so ``app.routes`` is not flat)."""
    routes: list[tuple[str, str]] = []
    for path, operations in create_app().openapi()["paths"].items():
        if not path.startswith("/api/") or path in OPEN_WRITES:
            continue
        for method in operations:
            if method.upper() not in SAFE:
                routes.append((method.upper(), re.sub(r"\{[^}]+\}", "x", path)))
    return routes


class TestGuestSignIn:
    async def test_status_advertises_guest_access_and_login_without_password(self):
        async for client in make_client(ok_json([])):
            await admin_with_guest(client)
            status = (await client.get("/api/auth/status")).json()
            assert status["authenticated"] is False
            assert status["guest_access_enabled"] is True and status["guest_password_required"] is False

            login = await client.post("/api/auth/guest/login", json={})
            assert login.status_code == 200
            assert login.json()["role"] == "guest" and login.json()["authenticated"] is True

            status = (await client.get("/api/auth/status")).json()
            assert status["role"] == "guest" and status["authenticated"] is True
            assert (await client.get("/api/accounts")).status_code == 200

        async with session_scope() as session:
            events = (
                (await session.execute(select(AuditEvent).where(AuditEvent.action == "auth.guest_login")))
                .scalars()
                .all()
            )
        assert len(events) == 1 and events[0].actor == "guest" and events[0].ok

    async def test_guest_password_is_checked_and_failures_audited(self):
        async for client in make_client(ok_json([])):
            await admin_with_guest(client, guest_password=GUEST_PASSWORD)
            assert (await client.get("/api/auth/status")).json()["guest_password_required"] is True
            wrong = await client.post("/api/auth/guest/login", json={"password": "nope-nope"})
            assert wrong.status_code == 401
            missing = await client.post("/api/auth/guest/login", json={})
            assert missing.status_code == 401
            ok = await client.post("/api/auth/guest/login", json={"password": GUEST_PASSWORD})
            assert ok.status_code == 200
            # The guest password is not the admin password.
            client.cookies.clear()
            assert (
                await client.post("/api/auth/login", json={"password": GUEST_PASSWORD})
            ).status_code == 401

        async with session_scope() as session:
            failed = (
                await session.execute(
                    select(AuditEvent).where(
                        AuditEvent.action == "auth.guest_login", AuditEvent.ok.is_(False)
                    )
                )
            ).scalars()
        assert len(list(failed)) == 2

    async def test_disabled_guest_access_refuses_login_and_ends_guest_sessions(self):
        async for client in make_client(ok_json([])):
            await admin_with_guest(client)
            await client.post("/api/auth/guest/login", json={})
            guest_cookies = dict(client.cookies)
            client.cookies.clear()
            await client.post("/api/auth/login", json={"password": PASSWORD})
            assert (await client.patch("/api/auth/guest", json={"enabled": False})).status_code == 200
            client.cookies.clear()
            assert (await client.post("/api/auth/guest/login", json={})).status_code == 403
            for name, value in guest_cookies.items():
                client.cookies.set(name, value)
            assert (await client.get("/api/accounts")).status_code == 401

    async def test_guest_access_needs_a_dashboard_password(self):
        async for client in make_client(ok_json([])):
            assert (await client.patch("/api/auth/guest", json={"enabled": True})).status_code == 409
            assert (await client.post("/api/auth/guest/login", json={})).status_code == 409

    async def test_settings_reset_keeps_guest_access(self):
        async for client in make_client(ok_json([])):
            await admin_with_guest(client)
            await client.post("/api/auth/login", json={"password": PASSWORD})
            await client.post("/api/settings/reset")
            assert (await client.get("/api/auth/guest")).json() == {"enabled": True, "password_set": False}


class TestGuestIsReadOnly:
    async def test_every_mutating_management_route_refuses_a_guest(self):
        account_id = await add_account("alpha")
        routes = mutating_routes()
        assert len(routes) >= 30, "the sweep must actually see the app's routes"
        for expected in [
            ("POST", "/api/accounts"),
            ("DELETE", "/api/keys/x"),
            ("PATCH", "/api/settings"),
            ("PUT", "/api/firewall/mode"),
            ("POST", "/api/automations/x/run"),
            ("PATCH", "/api/auth/guest"),
        ]:
            assert expected in routes
        async for client in make_client(ok_json([])):
            await admin_with_guest(client)
            await client.post("/api/auth/guest/login", json={})
            failures = []
            for method, path in routes:
                response = await client.request(method, path, json={})
                if response.status_code != 403:
                    failures.append(f"{method} {path} → {response.status_code}")
            assert failures == []
            # Reads still work, and nothing changed.
            assert (await client.get("/api/settings")).status_code == 200
            assert (await client.get("/api/firewall")).status_code == 200
            assert (await client.get("/api/automations")).status_code == 200
        async with session_scope() as session:
            assert (await session.get(Account, account_id)) is not None

    async def test_guest_can_sign_out(self):
        async for client in make_client(ok_json([])):
            await admin_with_guest(client)
            await client.post("/api/auth/guest/login", json={})
            assert (await client.post("/api/auth/logout")).status_code == 204
            assert (await client.get("/api/accounts")).status_code == 401

    async def test_payloads_a_guest_reads_carry_no_secrets(self):
        await add_account("alpha", key="sk-ant-api03-supersecretvalue-abcdefgh")
        async for client in make_client(ok_json([])):
            await admin_with_guest(client, guest_password=GUEST_PASSWORD)
            await client.post("/api/auth/login", json={"password": PASSWORD})
            created = (await client.post("/api/keys", json={"name": "team"})).json()
            secret = created["api_key"]
            client.cookies.clear()
            await client.post("/api/auth/guest/login", json={"password": GUEST_PASSWORD})
            bodies = [
                (await client.get(path)).text
                for path in (
                    "/api/accounts",
                    "/api/keys",
                    "/api/audit/events",
                    "/api/settings",
                    "/api/auth/status",
                    "/api/auth/guest",
                )
            ]
        joined = "\n".join(bodies)
        assert "supersecretvalue" not in joined
        assert secret not in joined
        assert GUEST_PASSWORD not in joined and PASSWORD not in joined
        assert auth.bootstrap_token() not in joined
