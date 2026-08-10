"""Guards the dashboard against silent breakage.

The dashboard is hand-written JS with no build step or type checking, so a renamed
API field fails only at runtime, in the browser, as a blank table. These tests read the
paths and field names straight out of `index.html` and check them against live
responses, so a backend rename breaks CI instead of the page.
"""

from __future__ import annotations

import re
from pathlib import Path

from tests.test_proxy_api import MESSAGE_BODY, add_account, make_client, ok_json

INDEX = Path("app/modules/dashboard/index.html").read_text(encoding="utf-8")


def test_dashboard_html_is_served_intact():
    assert "<title>claude-lb</title>" in INDEX
    assert "prefers-color-scheme: dark" in INDEX, "dashboard must render in both themes"


class TestEndpointsExist:
    async def test_every_endpoint_the_dashboard_calls_responds(self):
        # api("/path") and api(`/path?...`) — strip any template interpolation.
        raw = re.findall(r"""api\(\s*[`"']([^`"']+)""", INDEX)
        # Cutting at `${` can leave a dangling `?window_hours=`; drop the partial param.
        candidates = {re.sub(r"[?&][A-Za-z_]*=?$", "", p.split("${")[0]) for p in raw if p.startswith("/")}
        # Drop per-resource URLs like `/api/accounts/${id}`; they are covered by
        # TestMutationsTheDashboardPerforms, and a bare collection GET is all this asserts.
        paths = sorted(p for p in candidates if not p.endswith("/"))
        assert paths, "no API calls found — did the dashboard markup change shape?"

        await add_account("primary")
        async for client in make_client(ok_json([])):
            results = {path: (await client.get(path)).status_code for path in paths}

        # A 405 means the route exists but is POST/DELETE-only, which is fine — the
        # failure this guards against is the dashboard calling a path that isn't routed.
        missing = {path: status for path, status in results.items() if status == 404}
        assert not missing, f"dashboard calls unrouted path(s): {missing}"
        unexpected = {path: status for path, status in results.items() if status not in (200, 405)}
        assert not unexpected, unexpected

    async def test_the_documented_endpoint_set_is_covered(self):
        for path in ("/health", "/api/accounts", "/api/keys", "/api/usage/summary", "/api/usage/requests"):
            assert path in INDEX, f"dashboard no longer calls {path}"


class TestFieldNamesMatchResponses:
    async def test_account_fields_read_by_the_dashboard_exist(self):
        await add_account("primary")
        async for client in make_client(ok_json([])):
            account = (await client.get("/api/accounts")).json()[0]

        for field in (
            "id",
            "name",
            "credential_hint",
            "available",
            "enabled",
            "disabled_reason",
            "headroom",
            "total_requests",
            "total_cost_usd",
        ):
            assert field in account, f"dashboard reads a.{field}"

    async def test_usage_summary_fields_read_by_the_dashboard_exist(self, proxy_calls):
        await add_account("primary")
        async for client in make_client(ok_json(proxy_calls)):
            await client.post("/v1/messages", json=MESSAGE_BODY)
            summary = (await client.get("/api/usage/summary?window_hours=1")).json()

        # The tile list in the dashboard is keyed on these exact names.
        for field in (
            "requests",
            "errors",
            "input_tokens",
            "output_tokens",
            "cache_read_input_tokens",
            "cost_usd",
        ):
            assert field in summary["totals"], f"dashboard tile reads totals.{field}"

        assert {"account_id", "account_name", "cost_usd"} <= summary["by_account"][0].keys()
        assert {"model", "requests", "input_tokens", "output_tokens", "cost_usd"} <= summary["by_model"][
            0
        ].keys()

    async def test_request_log_fields_read_by_the_dashboard_exist(self, proxy_calls):
        await add_account("primary")
        async for client in make_client(ok_json(proxy_calls)):
            await client.post("/v1/messages", json=MESSAGE_BODY)
            row = (await client.get("/api/usage/requests?limit=1")).json()[0]

        for field in (
            "created_at",
            "account_id",
            "model",
            "status_code",
            "streaming",
            "input_tokens",
            "output_tokens",
            "duration_ms",
            "cost_usd",
            "error",
        ):
            assert field in row, f"dashboard reads r.{field}"

    async def test_api_key_fields_read_by_the_dashboard_exist(self):
        async for client in make_client(ok_json([])):
            created = (await client.post("/api/keys", json={"name": "k"})).json()
            key = (await client.get("/api/keys")).json()[0]

        assert "api_key" in created, "dashboard shows the plaintext once on create"
        for field in (
            "id",
            "name",
            "key_hint",
            "enabled",
            "max_cost_usd_per_window",
            "window_seconds",
            "total_requests",
            "total_cost_usd",
        ):
            assert field in key, f"dashboard reads k.{field}"


class TestMutationsTheDashboardPerforms:
    async def test_add_account_form_payload_is_accepted(self):
        async for client in make_client(ok_json([])):
            # Mirrors the fields in the dashboard's #account-form.
            response = await client.post(
                "/api/accounts",
                json={"name": "from-form", "api_key": "sk-ant-x", "weight": 1, "priority": 0},
            )
        assert response.status_code == 201

    async def test_issue_key_form_payload_is_accepted(self):
        async for client in make_client(ok_json([])):
            response = await client.post(
                "/api/keys",
                json={"name": "from-form", "max_cost_usd_per_window": 5.0, "window_seconds": 3600},
            )
        assert response.status_code == 201

    async def test_toggle_and_delete_buttons_hit_real_routes(self):
        account_id = await add_account("toggle-me")
        async for client in make_client(ok_json([])):
            disabled = await client.patch(f"/api/accounts/{account_id}", json={"enabled": False})
            removed = await client.delete(f"/api/accounts/{account_id}")

        assert disabled.status_code == 200
        assert disabled.json()["enabled"] is False
        assert removed.status_code == 204


class TestDashboardAuthWiring:
    """The dashboard must be able to render its own login gate."""

    def test_it_calls_the_auth_status_endpoint(self):
        assert "/api/auth/status" in INDEX

    def test_it_has_both_a_login_and_a_first_run_setup_path(self):
        assert "/api/auth/login" in INDEX
        assert "/api/auth/password" in INDEX
        assert 'dataset.mode === "setup"' in INDEX

    def test_it_sends_the_bootstrap_token_header_when_one_is_entered(self):
        assert "x-claude-lb-bootstrap" in INDEX

    def test_it_distinguishes_401_from_other_errors(self):
        # Otherwise an expired session renders as a generic red toast instead of the gate.
        assert "AuthRequired" in INDEX
        assert "res.status === 401" in INDEX

    async def test_auth_status_fields_read_by_the_gate_exist(self):
        async for client in make_client(ok_json([])):
            status = (await client.get("/api/auth/status")).json()
        for field in ("configured", "totp_enabled", "authenticated"):
            assert field in status, f"login gate reads status.{field}"

    async def test_settings_fields_rendered_as_controls_exist(self):
        async for client in make_client(ok_json([])):
            payload = (await client.get("/api/settings")).json()
        assert "available_strategies" in payload
        for field in (
            "routing_strategy",
            "max_attempts",
            "sticky_sessions_enabled",
            "sticky_ttl_seconds",
            "health_probe_enabled",
            "model_sync_enabled",
        ):
            assert field in payload["settings"], f"dashboard renders a control for {field}"

    async def test_audit_fields_read_by_the_dashboard_exist(self):
        async for client in make_client(ok_json([])):
            await client.post("/api/accounts", json={"name": "x", "api_key": "sk-ant-y"})
            row = (await client.get("/api/audit?limit=1")).json()[0]
        for field in ("created_at", "action", "target", "detail", "client_ip", "ok"):
            assert field in row, f"dashboard reads e.{field}"


class TestChartAndCatalogWiring:
    def test_chart_columns_do_not_reuse_the_headroom_bar_class(self):
        """`.bar` is a 6px-tall div; SVG rects honour CSS height, so sharing the
        class would flatten every chart column."""
        assert 'class="col"' in INDEX
        assert 'rect class="bar"' not in INDEX

    def test_chart_is_inline_svg_with_no_external_dependency(self):
        assert "<svg" in INDEX
        assert "cdn." not in INDEX and "https://unpkg" not in INDEX

    def test_chart_has_an_accessible_label(self):
        assert 'role="img"' in INDEX and "aria-label" in INDEX

    async def test_trend_fields_read_by_the_chart_exist(self):
        async for client in make_client(ok_json([])):
            points = (await client.get("/api/usage/trend?days=3")).json()
        assert len(points) == 3
        for field in ("day", "cost_usd", "requests"):
            assert field in points[0], f"chart reads point.{field}"

    async def test_catalog_fields_read_by_the_dashboard_exist(self):
        await add_account("primary")
        async for client in make_client(ok_json([])):
            # Empty catalog is fine; the shape check is on the account payload the
            # "last synced" note reads.
            assert (await client.get("/api/health/models")).status_code == 200
            account = (await client.get("/api/accounts")).json()[0]
        assert "models_synced_at" in account, "dashboard reads a.models_synced_at"


class TestHeadroomBarHonesty:
    def test_an_unavailable_account_gets_a_muted_headroom_bar(self):
        """A disabled account painted in the accent colour reads as healthy."""
        assert ".bar.inactive" in INDEX
        assert 'a.available ? "" : " inactive"' in INDEX

    def test_the_headroom_bar_explains_itself_on_hover(self):
        assert "out of rotation — headroom is not being tracked" in INDEX
