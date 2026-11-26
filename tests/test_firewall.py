"""Proxy IP firewall: rules, management API, and enforcement on /v1/*."""

from __future__ import annotations

import pytest

from claude_lb.db.models import AuditEvent
from claude_lb.db.session import session_scope
from claude_lb.modules.firewall import service as fw
from tests.test_auth import make_remote_client
from tests.test_proxy_api import MESSAGE_BODY, add_account, make_client, ok_json


class TestRules:
    @pytest.mark.parametrize(
        ("raw", "normalized"),
        [
            ("10.0.0.5", "10.0.0.5"),
            (" 10.0.0.5/32 ", "10.0.0.5"),
            ("10.0.0.0/8", "10.0.0.0/8"),
            ("2001:DB8::1", "2001:db8::1"),
            ("2001:db8::/32", "2001:db8::/32"),
        ],
    )
    def test_normalize(self, raw, normalized):
        assert fw.normalize(raw) == normalized

    @pytest.mark.parametrize(
        "raw", ["", "10.0.0", "300.1.1.1", "10.0.0.0/33", "example.com", "::ffff:1.2.3.4"]
    )
    def test_rejects_invalid(self, raw):
        with pytest.raises(fw.FirewallError):
            fw.normalize(raw)

    def test_host_bits_suggest_the_network(self):
        with pytest.raises(fw.FirewallError, match="10.0.0.0/8"):
            fw.normalize("10.1.2.3/8")

    def test_matching(self):
        rules = fw.Rules("allowlist", (fw.to_network("10.0.0.0/8"), fw.to_network("2001:db8::/32")))
        assert rules.allows("10.20.30.40")
        assert rules.allows("::ffff:10.1.1.1"), "IPv4-mapped clients match IPv4 entries"
        assert rules.allows("2001:db8::abcd")
        assert not rules.allows("11.0.0.1")
        assert not rules.allows("127.0.0.1"), "loopback gets no exemption on the proxy"
        assert not rules.allows("")
        assert not rules.allows("not-an-ip")
        assert fw.Rules("allow_all", ()).allows("203.0.113.9")
        assert not fw.Rules("allowlist", ()).allows("10.0.0.1"), "an empty allowlist refuses everyone"


class TestManagementApi:
    async def test_add_check_note_remove_and_mode_with_audit(self):
        async for client in make_client(ok_json([])):
            state = (await client.get("/api/firewall")).json()
            assert state == {
                "mode": "allow_all",
                "entries": [],
                "client_ip": "127.0.0.1",
                "client_allowed": True,
                "client_covered": False,
            }

            check = (await client.get("/api/firewall/check", params={"network": "10.0.0.0/8"})).json()
            assert check == {
                "network": "10.0.0.0/8",
                "client_ip": "127.0.0.1",
                "covers_client": False,
                "client_allowed_after": True,
            }
            assert (await client.get("/api/firewall/check", params={"network": "nope"})).status_code == 422

            created = await client.post(
                "/api/firewall/entries", json={"network": "10.0.0.0/8", "note": "office"}
            )
            assert created.status_code == 201
            entry = created.json()
            assert entry["network"] == "10.0.0.0/8" and entry["version"] == 4 and entry["addresses"] == 2**24
            dup = await client.post("/api/firewall/entries", json={"network": "10.0.0.0/8"})
            assert dup.status_code == 409
            bad = await client.post("/api/firewall/entries", json={"network": "10.1.2.3/8"})
            assert bad.status_code == 422 and "10.0.0.0/8" in bad.json()["detail"]

            v6 = (await client.post("/api/firewall/entries", json={"network": "::1"})).json()
            assert v6["addresses"] == 1 and v6["version"] == 6

            patched = await client.patch(f"/api/firewall/entries/{entry['id']}", json={"note": "HQ"})
            assert patched.json()["note"] == "HQ"

            mode = await client.put("/api/firewall/mode", json={"mode": "allowlist"})
            assert mode.status_code == 200
            assert mode.json()["mode"] == "allowlist" and mode.json()["client_allowed"] is False
            assert (await client.put("/api/firewall/mode", json={"mode": "deny"})).status_code == 422

            check = (await client.get("/api/firewall/check", params={"network": "127.0.0.0/8"})).json()
            assert check["covers_client"] is True and check["client_allowed_after"] is True

            assert (await client.delete(f"/api/firewall/entries/{v6['id']}")).status_code == 204
            assert (await client.delete(f"/api/firewall/entries/{v6['id']}")).status_code == 404

            # Reset-to-defaults is about runtime settings and must not open the firewall.
            await client.post("/api/settings/reset")
            assert (await client.get("/api/firewall")).json()["mode"] == "allowlist"

        async with session_scope() as session:
            from sqlalchemy import select

            actions = [a for (a,) in (await session.execute(select(AuditEvent.action))).all()]
        assert actions.count("firewall.entry_added") == 2
        assert {"firewall.entry_updated", "firewall.mode_changed", "firewall.entry_removed"} <= set(actions)


class TestEnforcement:
    async def _setup(self, client, *entries: str, mode: str = "allowlist") -> None:
        async with session_scope() as session:
            for entry in entries:
                await fw.add_entry(session, entry)
            await fw.set_mode(session, mode)

    async def test_blocked_client_gets_anthropic_403_and_never_reaches_upstream(self):
        await add_account("alpha")
        calls: list = []
        async for client in make_remote_client(ok_json(calls), host="203.0.113.7"):
            await self._setup(client, "10.0.0.0/8")
            response = await client.post("/v1/messages", json=MESSAGE_BODY)
            assert response.status_code == 403
            body = response.json()
            assert body["type"] == "error"
            assert body["error"]["type"] == "permission_error"
            assert "203.0.113.7" in body["error"]["message"]
            assert calls == []
            # The management plane is not firewalled (its own gate answers instead).
            assert (await client.get("/api/auth/status")).status_code == 200

    async def test_allowed_client_gets_through(self):
        await add_account("alpha")
        calls: list = []
        async for client in make_remote_client(ok_json(calls), host="10.9.8.7"):
            await self._setup(client, "10.0.0.0/8")
            response = await client.post("/v1/messages", json=MESSAGE_BODY)
            assert response.status_code == 200
            assert len(calls) == 1

    async def test_allow_all_ignores_entries_and_empty_allowlist_blocks(self):
        await add_account("alpha")
        calls: list = []
        async for client in make_client(ok_json(calls)):
            await self._setup(client, "10.0.0.0/8", mode="allow_all")
            assert (await client.post("/v1/messages", json=MESSAGE_BODY)).status_code == 200
            async with session_scope() as session:
                await fw.set_mode(session, "allowlist")
            assert (await client.post("/v1/messages", json=MESSAGE_BODY)).status_code == 403
            assert (await client.get("/v1/models")).status_code == 403, "every /v1 route is guarded"
            # Loopback can still manage the firewall and fix it.
            entry = await client.post("/api/firewall/entries", json={"network": "127.0.0.1"})
            assert entry.status_code == 201
            assert (await client.post("/v1/messages", json=MESSAGE_BODY)).status_code == 200
