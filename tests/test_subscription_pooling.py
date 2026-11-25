from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from claude_lb.core.crypto import encrypt, mask_secret
from claude_lb.db.models import Account, QuotaHistory
from claude_lb.db.session import session_scope
from claude_lb.main import create_app
from claude_lb.modules.proxy import load_balancer as lb
from claude_lb.modules.proxy import quota as quota_mod
from claude_lb.modules.proxy import sticky


def _make_account(
    name: str,
    *,
    plan_type: str = "pro",
    routing_policy: str = "normal",
    priority: int = 0,
    primary_used: float | None = None,
    primary_reset_at: datetime | None = None,
    secondary_used: float | None = None,
    secondary_reset_at: datetime | None = None,
    quota_status: str = "active",
    enabled: bool = True,
) -> Account:
    return Account(
        id=f"id-{name}",
        name=name,
        provider="oauth",
        encrypted_credential=encrypt("tok-" + name),
        credential_hint=mask_secret("tok-" + name),
        auth_scheme="bearer",
        plan_type=plan_type,
        routing_policy=routing_policy,
        priority=priority,
        primary_used_percent=primary_used,
        primary_reset_at=primary_reset_at,
        secondary_used_percent=secondary_used,
        secondary_reset_at=secondary_reset_at,
        quota_status=quota_status,
        enabled=enabled,
    )


def test_unified_headers_fold_and_auto_recover():
    now = datetime(2026, 11, 25, 12, 0, tzinfo=UTC)
    pri_reset = int((now + timedelta(hours=2)).timestamp())
    sec_reset = int((now + timedelta(days=3)).timestamp())

    acct = _make_account("sub-1")
    applied = lb.apply_rate_limit_headers(
        acct,
        {
            "anthropic-ratelimit-unified-status": "allowed_warning",
            "anthropic-ratelimit-unified-5h-utilization": "0.75",
            "anthropic-ratelimit-unified-5h-reset": str(pri_reset),
            "anthropic-ratelimit-unified-7d-utilization": "0.20",
            "anthropic-ratelimit-unified-7d-reset": str(sec_reset),
        },
    )
    assert applied is None  # apply_rate_limit_headers returns None
    assert acct.primary_used_percent == pytest.approx(75.0)
    assert acct.secondary_used_percent == pytest.approx(20.0)
    assert acct.quota_status == "active"
    assert lb.is_available(acct, now=now)
    assert lb.headroom(acct, now=now) == pytest.approx(0.25)

    # Hit 5h limit -> rate_limited until pri_reset
    quota_mod.apply_unified_quota(
        acct,
        {
            "anthropic-ratelimit-unified-status": "rejected",
            "anthropic-ratelimit-unified-5h-utilization": "1.0",
            "anthropic-ratelimit-unified-5h-reset": str(pri_reset),
            "anthropic-ratelimit-unified-7d-utilization": "0.30",
            "anthropic-ratelimit-unified-7d-reset": str(sec_reset),
        },
        now=now,
    )
    assert acct.quota_status == "rate_limited"
    assert not lb.is_available(acct, now=now)
    # After 5h reset passes, account auto-recovers without probe
    after_reset = now + timedelta(hours=2, seconds=1)
    assert lb.is_available(acct, now=after_reset)
    assert lb.headroom(acct, now=after_reset) == pytest.approx(0.70)


def test_unified_quota_overage_allowed_stays_available():
    now = datetime(2026, 11, 25, 12, 0, tzinfo=UTC)
    acct = _make_account("sub-overage")
    quota_mod.apply_unified_quota(
        acct,
        {
            "anthropic-ratelimit-unified-status": "allowed",
            "anthropic-ratelimit-unified-7d-utilization": "1.0",
            "anthropic-ratelimit-unified-overage-status": "allowed",
        },
        now=now,
    )
    assert acct.quota_status == "active"
    assert lb.is_available(acct, now=now)


def test_routing_policy_tiering_burn_first_and_preserve():
    now = datetime(2026, 11, 25, 12, 0, tzinfo=UTC)
    a_preserve = _make_account("preserve", routing_policy="preserve", secondary_used=0.0)
    a_normal = _make_account("normal", routing_policy="normal", secondary_used=50.0)
    a_burn = _make_account("burn", routing_policy="burn_first", secondary_used=80.0)

    picked = lb.select_account([a_preserve, a_normal, a_burn], strategy="usage_weighted", now=now)
    assert picked.name == "burn"

    picked_no_burn = lb.select_account([a_preserve, a_normal], strategy="usage_weighted", now=now)
    assert picked_no_burn.name == "normal"

    picked_only_preserve = lb.select_account([a_preserve], strategy="usage_weighted", now=now)
    assert picked_only_preserve.name == "preserve"


def test_subscription_strategies_usage_reset_sequential_and_relative():
    now = datetime(2026, 11, 25, 12, 0, tzinfo=UTC)
    a1 = _make_account(
        "a1",
        plan_type="pro",
        priority=1,
        primary_used=10.0,
        secondary_used=60.0,
        secondary_reset_at=now + timedelta(days=5),
    )
    a2 = _make_account(
        "a2",
        plan_type="max_20x",
        priority=2,
        primary_used=20.0,
        secondary_used=10.0,
        secondary_reset_at=now + timedelta(hours=6),
    )

    assert lb.select_account([a1, a2], strategy="usage_weighted", now=now).name == "a2"
    assert lb.select_account([a1, a2], strategy="reset_drain", now=now).name == "a2"
    assert lb.select_account([a1, a2], strategy="sequential_drain", now=now).name == "a1"

    # relative_availability strongly favours a2 (20x capacity, 90% remaining, resets in 6h vs 5d)
    wins = {lb.select_account([a1, a2], strategy="relative_availability", now=now).name for _ in range(10)}
    assert "a2" in wins


def test_ewma_depletion_risk():
    now = datetime(2026, 11, 25, 12, 0, tzinfo=UTC)
    acct = _make_account(
        "risky",
        secondary_used=60.0,
        secondary_reset_at=now + timedelta(hours=10),
    )
    history = [
        QuotaHistory(
            account_id=acct.id,
            recorded_at=now - timedelta(hours=2),
            secondary_used_percent=20.0,
            secondary_reset_at=now + timedelta(hours=10),
        ),
        QuotaHistory(
            account_id=acct.id,
            recorded_at=now - timedelta(hours=1),
            secondary_used_percent=40.0,
            secondary_reset_at=now + timedelta(hours=10),
        ),
        QuotaHistory(
            account_id=acct.id,
            recorded_at=now,
            secondary_used_percent=60.0,
            secondary_reset_at=now + timedelta(hours=10),
        ),
    ]
    risk, level = quota_mod.compute_account_risk(history, acct, now=now)
    assert risk == pytest.approx(1.0)
    assert level == "critical"


async def test_accounts_and_quota_summary_api(monkeypatch):
    from claude_lb.core.config import get_settings

    monkeypatch.setenv("CLAUDE_LB_DASHBOARD_AUTH_ENABLED", "false")
    get_settings.cache_clear()
    try:
        app = create_app()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                "/api/accounts",
                json={
                    "name": "claude-max",
                    "api_key": "tok-secret-12345",
                    "provider": "oauth",
                    "plan_type": "max_5x",
                    "routing_policy": "burn_first",
                },
            )
            assert resp.status_code == 201, resp.text
            created = resp.json()
            assert created["plan_type"] == "max_5x"
            assert created["routing_policy"] == "burn_first"
            assert created["effective_capacity"] == 500.0

            # Update routing policy
            patch = await client.patch(
                f"/api/accounts/{created['id']}",
                json={"routing_policy": "preserve"},
            )
            assert patch.status_code == 200
            assert patch.json()["routing_policy"] == "preserve"

            # Seed unified quota on the account
            async with session_scope() as session:
                row = await session.get(Account, created["id"])
                assert row is not None
                row.primary_used_percent = 35.0
                row.secondary_used_percent = 12.0

            quota_resp = await client.get("/api/usage/quota")
            assert quota_resp.status_code == 200
            qdata = quota_resp.json()
            assert qdata["total_accounts"] == 1
            assert qdata["total_capacity_credits"] == 500.0
            assert qdata["accounts"][0]["primary_used_percent"] == pytest.approx(35.0)
            assert qdata["accounts"][0]["secondary_used_percent"] == pytest.approx(12.0)

            metrics_resp = await client.get("/metrics")
            assert metrics_resp.status_code == 200
            assert "claude_lb_account_primary_used_percent" in metrics_resp.text
            assert "claude_lb_account_capacity_credits" in metrics_resp.text

            # Seed QuotaHistory and verify history endpoint
            async with session_scope() as session:
                session.add(
                    QuotaHistory(
                        account_id=created["id"],
                        primary_used_percent=35.0,
                        secondary_used_percent=12.0,
                        unified_status="allowed",
                    )
                )
            hist_resp = await client.get(f"/api/usage/quota/{created['id']}/history")
            assert hist_resp.status_code == 200
            assert len(hist_resp.json()) == 1
            assert hist_resp.json()[0]["primary_used_percent"] == pytest.approx(35.0)

            # Reset quota
            reset_resp = await client.post(f"/api/accounts/{created['id']}/reset-quota")
            assert reset_resp.status_code == 200
            assert reset_resp.json()["primary_used_percent"] is None
            assert reset_resp.json()["quota_status"] == "active"

            # Import claudeAiOauth credential bundle
            expires_ms = int((datetime.now(UTC) + timedelta(hours=2)).timestamp() * 1000)
            imp_resp = await client.post(
                "/api/accounts/import",
                json={
                    "name": "imported-max-20x",
                    "routing_policy": "burn_first",
                    "credentials": {
                        "claudeAiOauth": {
                            "accessToken": "sk-ant-oat01-imported-token",
                            "refreshToken": "sk-ant-ort01-refresh-token",
                            "expiresAt": expires_ms,
                            "subscriptionType": "max",
                            "rateLimitTier": "default_claude_max_20x",
                        }
                    },
                },
            )
            assert imp_resp.status_code == 201, imp_resp.text
            imported = imp_resp.json()
            assert imported["plan_type"] == "max_20x"
            assert imported["effective_capacity"] == 2000.0
            assert imported["routing_policy"] == "burn_first"
    finally:
        monkeypatch.delenv("CLAUDE_LB_DASHBOARD_AUTH_ENABLED", raising=False)
        get_settings.cache_clear()


async def test_health_reconciles_expired_quota_status():
    from claude_lb.modules.health.service import run_health_probes

    past = datetime.now(UTC) - timedelta(minutes=5)
    async with session_scope() as session:
        acct = _make_account(
            "expired-rl",
            quota_status="rate_limited",
            primary_used=100.0,
            primary_reset_at=past,
        )
        session.add(acct)
        await session.flush()
        acct_id = acct.id

    async with httpx.AsyncClient() as client:
        await run_health_probes(client)

    async with session_scope() as session:
        refreshed = await session.get(Account, acct_id)
        assert refreshed is not None
        assert refreshed.quota_status == "active"
        assert refreshed.primary_used_percent == 0.0


async def test_proxy_e2e_subscription_headers_and_429_failover():
    """Account 1 (subscription burn_first) -> 200 unified headers -> 429 failover to Account 2 (preserve)."""
    from sqlalchemy import select

    now = datetime.now(UTC)
    pri_reset = int((now + timedelta(hours=4)).timestamp())
    sec_reset = int((now + timedelta(days=5)).timestamp())

    async with session_scope() as session:
        sub_acct = _make_account(
            "claude-code-sub",
            plan_type="max_5x",
            routing_policy="burn_first",
        )
        free_acct = _make_account(
            "free-backup",
            plan_type="free",
            routing_policy="preserve",
        )
        session.add_all([sub_acct, free_acct])
        await session.flush()
        sub_id = sub_acct.id

    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        auth = request.headers.get("authorization", "")
        if "tok-claude-code-sub" in auth:
            if call_count == 1:
                return httpx.Response(
                    200,
                    json={
                        "id": "msg_sub_1",
                        "model": "claude-sonnet-5-5",
                        "content": [{"type": "text", "text": "ok"}],
                        "usage": {"input_tokens": 10, "output_tokens": 20},
                    },
                    headers={
                        "anthropic-ratelimit-unified-status": "allowed",
                        "anthropic-ratelimit-unified-5h-utilization": "0.45",
                        "anthropic-ratelimit-unified-5h-reset": str(pri_reset),
                        "anthropic-ratelimit-unified-7d-utilization": "0.18",
                        "anthropic-ratelimit-unified-7d-reset": str(sec_reset),
                    },
                )
            return httpx.Response(
                429,
                json={"type": "error", "error": {"type": "rate_limit_error", "message": "5h limit"}},
                headers={
                    "anthropic-ratelimit-unified-status": "rejected",
                    "anthropic-ratelimit-unified-5h-utilization": "1.0",
                    "anthropic-ratelimit-unified-5h-reset": str(pri_reset),
                    "anthropic-ratelimit-unified-7d-utilization": "0.22",
                    "anthropic-ratelimit-unified-7d-reset": str(sec_reset),
                },
            )
        return httpx.Response(
            200,
            json={
                "id": "msg_free_1",
                "model": "claude-sonnet-5-5",
                "content": [{"type": "text", "text": "fallback"}],
                "usage": {"input_tokens": 10, "output_tokens": 15},
            },
            headers={
                "anthropic-ratelimit-unified-status": "allowed",
                "anthropic-ratelimit-unified-5h-utilization": "0.10",
                "anthropic-ratelimit-unified-5h-reset": str(pri_reset),
            },
        )

    app = create_app()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://localhost"
    ) as client:
        async with app.router.lifespan_context(app):
            await app.state.http_client.aclose()
            app.state.http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

            body = {
                "model": "claude-sonnet-5-5",
                "max_tokens": 64,
                "messages": [{"role": "user", "content": "hi"}],
            }

            r1 = await client.post("/v1/messages", json=body)
            assert r1.status_code == 200
            assert r1.headers["x-claude-lb-account"] == "claude-code-sub"

            r2 = await client.post("/v1/messages", json=body)
            assert r2.status_code == 200
            assert r2.headers["x-claude-lb-account"] == "free-backup"

    async with session_scope() as session:
        refreshed = await session.get(Account, sub_id)
        assert refreshed is not None
        assert refreshed.quota_status == "rate_limited"
        assert refreshed.primary_used_percent == pytest.approx(100.0)
        hist = list(
            (await session.execute(select(QuotaHistory).where(QuotaHistory.account_id == sub_id))).scalars()
        )
        assert len(hist) == 2


def _api_key_account(name: str, *, spend_cap_usd: float | None = None) -> Account:
    return Account(
        id=f"id-{name}",
        name=name,
        encrypted_credential=encrypt("sk-ant-" + name),
        credential_hint=mask_secret("sk-ant-" + name),
        plan_type="api",
        routing_policy="burn_first",
        spend_cap_usd=spend_cap_usd,
    )


def _ok(text: str) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "id": f"msg_{text}",
            "model": "claude-opus-5-5",
            "content": [{"type": "text", "text": text}],
            "usage": {"input_tokens": 1000, "output_tokens": 1000},
        },
    )


async def _send_twice(handler) -> tuple[httpx.Response, httpx.Response]:
    sticky.clear()  # affinity is process-global; a previous test's pick must not leak in

    def only_messages(request: httpx.Request) -> httpx.Response:
        # Background model-catalog sync also hits this transport; keep it out of the picture.
        if request.url.path != "/v1/messages":
            return httpx.Response(404)
        return handler(request)

    app = create_app()
    body = {"model": "claude-opus-5-5", "max_tokens": 64, "messages": [{"role": "user", "content": "hi"}]}
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://localhost"
    ) as client:
        async with app.router.lifespan_context(app):
            await app.state.http_client.aclose()
            app.state.http_client = httpx.AsyncClient(transport=httpx.MockTransport(only_messages))
            r1 = await client.post("/v1/messages", json=body)
            r2 = await client.post("/v1/messages", json=body)
    return r1, r2


async def test_spend_cap_moves_traffic_from_api_key_to_subscription():
    """Console key (burn_first, $0.01 cap) serves until its spend reaches the cap, then the
    subscription (preserve) takes over."""
    async with session_scope() as session:
        session.add_all(
            [
                _api_key_account("console-first", spend_cap_usd=0.01),
                _make_account("sub-backup", plan_type="max_5x", routing_policy="preserve"),
            ]
        )

    def handler(request: httpx.Request) -> httpx.Response:
        return _ok("api" if request.headers.get("x-api-key") else "sub")

    r1, r2 = await _send_twice(handler)
    # 1000 in + 1000 out on claude-opus-5-5 is $0.024 — over the $0.01 cap after one call.
    assert r1.headers["x-claude-lb-account"] == "console-first"
    assert r2.headers["x-claude-lb-account"] == "sub-backup"

    async with session_scope() as session:
        console_acct = await session.get(Account, "id-console-first")
        assert console_acct.enabled  # capped, not disabled: raising the cap resumes it
        assert lb.spend_cap_reached(console_acct)
        assert not lb.is_available(console_acct)


async def test_out_of_credit_400_fails_over_instead_of_reaching_the_caller():
    async with session_scope() as session:
        session.add_all(
            [
                _api_key_account("console-first"),
                _make_account("sub-backup", plan_type="max_5x", routing_policy="preserve"),
            ]
        )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.headers.get("x-api-key"):
            return httpx.Response(
                400,
                json={
                    "type": "error",
                    "error": {
                        "type": "invalid_request_error",
                        "message": "Your credit balance is too low to access the Anthropic API. "
                        "Please go to Plans & Billing to upgrade or purchase credits.",
                    },
                },
            )
        return _ok("sub")

    r1, r2 = await _send_twice(handler)
    assert r1.status_code == 200
    assert r1.headers["x-claude-lb-account"] == "sub-backup"
    assert r2.headers["x-claude-lb-account"] == "sub-backup"

    async with session_scope() as session:
        console_acct = await session.get(Account, "id-console-first")
        assert not console_acct.enabled
        assert console_acct.disabled_reason == "upstream account is out of credit"


async def test_ordinary_400_still_goes_back_to_the_caller():
    async with session_scope() as session:
        session.add(_api_key_account("console-first"))

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={
                "type": "error",
                "error": {"type": "invalid_request_error", "message": "max_tokens: required"},
            },
        )

    r1, _ = await _send_twice(handler)
    assert r1.status_code == 400
    assert "max_tokens" in r1.text
    async with session_scope() as session:
        assert (await session.get(Account, "id-console-first")).enabled


async def test_spend_cap_api_roundtrip():
    app = create_app()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://localhost"
    ) as client:
        async with app.router.lifespan_context(app):
            created = await client.post(
                "/api/accounts", json={"name": "capped", "api_key": "sk-ant-capped-123", "spend_cap_usd": 1.5}
            )
            assert created.status_code == 201, created.text
            assert created.json()["spend_cap_usd"] == 1.5
            acct_id = created.json()["id"]

            raised = await client.patch(f"/api/accounts/{acct_id}", json={"spend_cap_usd": 3})
            assert raised.json()["spend_cap_usd"] == 3
            untouched = await client.patch(f"/api/accounts/{acct_id}", json={"weight": 2})
            assert untouched.json()["spend_cap_usd"] == 3
            cleared = await client.patch(f"/api/accounts/{acct_id}", json={"spend_cap_usd": None})
            assert cleared.json()["spend_cap_usd"] is None


async def test_subscription_model_refusal_routes_that_model_elsewhere_only():
    """A subscription that refuses Sonnet (429, no unified headers) keeps serving Haiku;
    Sonnet goes to the API key without the subscription being cooled down."""
    from claude_lb.modules.proxy import model_blocks

    async with session_scope() as session:
        session.add_all(
            [
                _make_account("sub", plan_type="max_5x", routing_policy="burn_first"),
                _api_key_account("console"),
            ]
        )
        # _api_key_account defaults to burn_first; make the subscription the first choice.
        (await session.get(Account, "id-console")).routing_policy = "preserve"

    calls: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        model = json.loads(request.content)["model"]
        who = "sub" if request.headers.get("authorization") else "console"
        calls.append((who, model))
        if who == "sub" and "haiku" not in model:
            return httpx.Response(
                429, json={"type": "error", "error": {"type": "rate_limit_error", "message": "Error"}}
            )
        return _ok(who)

    app = create_app()
    sticky.clear()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://localhost"
    ) as client:
        async with app.router.lifespan_context(app):
            await app.state.http_client.aclose()

            def only_messages(request: httpx.Request) -> httpx.Response:
                if request.url.path != "/v1/messages":
                    return httpx.Response(404)
                return handler(request)

            app.state.http_client = httpx.AsyncClient(transport=httpx.MockTransport(only_messages))

            def body(model: str, n: int) -> dict:
                return {"model": model, "max_tokens": 8, "messages": [{"role": "user", "content": f"q{n}"}]}

            r1 = await client.post("/v1/messages", json=body("claude-sonnet-5-5", 1))
            r2 = await client.post("/v1/messages", json=body("claude-sonnet-5-5", 2))
            r3 = await client.post("/v1/messages", json=body("claude-haiku-4-5", 3))

    assert [r1.status_code, r2.status_code, r3.status_code] == [200, 200, 200]
    assert r1.headers["x-claude-lb-account"] == "console"
    assert r2.headers["x-claude-lb-account"] == "console"
    assert r3.headers["x-claude-lb-account"] == "sub"
    # The refusal was learned once; the second Sonnet request never touched the subscription.
    assert calls == [
        ("sub", "claude-sonnet-5-5"),
        ("console", "claude-sonnet-5-5"),
        ("console", "claude-sonnet-5-5"),
        ("sub", "claude-haiku-4-5"),
    ]
    async with session_scope() as session:
        sub = await session.get(Account, "id-sub")
        assert model_blocks.active_blocks(sub) == ["claude-sonnet-5-5"]
        assert sub.cooldown_until is None
        assert lb.is_available(sub)


def test_real_quota_429_is_not_mistaken_for_a_model_refusal():
    from claude_lb.modules.proxy import model_blocks

    sub = _make_account("sub", plan_type="pro")
    assert model_blocks.is_model_refusal(sub, 429, {})
    assert not model_blocks.is_model_refusal(sub, 429, {"anthropic-ratelimit-unified-status": "rejected"})
    assert not model_blocks.is_model_refusal(_api_key_account("k"), 429, {})
    assert not model_blocks.is_model_refusal(sub, 500, {})


def test_token_candidates_survive_ansi_and_line_wrapping():
    from claude_lb.modules.accounts.subscription_login import token_candidates

    token = "sk-ant-oat01-" + "A1b2_C3d4-" * 9 + "xyzAA"
    wrapped = (
        "\x1b[32m✓ Token created\x1b[0m\r\n" + token[:40] + "\r\n" + token[40:] + "\r\n\r\nStore it safely"
    )
    assert token_candidates(wrapped)[0] == token
    assert token_candidates("no token here") == []


def test_add_subscription_cli_logs_in_verifies_and_stores(monkeypatch):
    from typer.testing import CliRunner

    from claude_lb.cli import app
    from claude_lb.modules.accounts import subscription_login

    token = "sk-ant-oat01-" + "Z" * 90 + "AA"
    monkeypatch.setattr(subscription_login, "claude_cli", lambda: "/usr/bin/true")
    monkeypatch.setattr(
        subscription_login,
        "run_setup_token",
        lambda _path: f"Your token:\r\n{token[:50]}\r\n{token[50:]}\r\n",
    )
    seen: list[str] = []

    async def fake_verify(_client, _base, tok):
        seen.append(tok)
        return subscription_login.VerifyResult(
            True,
            200,
            {
                "anthropic-ratelimit-unified-status": "allowed",
                "anthropic-ratelimit-unified-5h-utilization": "0.23",
            },
            "ok",
        )

    monkeypatch.setattr(subscription_login, "verify_token", fake_verify)

    result = CliRunner().invoke(app, ["account", "add-subscription", "alice", "--plan-type", "max_5x"])
    assert result.exit_code == 0, result.output
    assert "Added" in result.output and "5h 23%" in result.output
    assert seen == [token]

    async def _check():
        from sqlalchemy import select

        from claude_lb.core.crypto import decrypt

        async with session_scope() as session:
            acct = (await session.execute(select(Account).where(Account.name == "alice"))).scalar_one()
            return acct.plan_type, acct.auth_scheme, decrypt(acct.encrypted_credential)

    import asyncio as _asyncio

    from claude_lb.db.session import dispose_db, init_db

    async def _run_check():
        await init_db()
        try:
            return await _check()
        finally:
            await dispose_db()

    assert _asyncio.run(_run_check()) == ("max_5x", "bearer", token)


def test_unavailable_message_names_the_actual_reasons():
    from claude_lb.modules.proxy import model_blocks
    from claude_lb.modules.proxy.service import explain_unavailable

    capped = _api_key_account("console", spend_cap_usd=1.0)
    capped.total_cost_usd = 1.2
    capped.enabled = True
    sub = _make_account("sub")
    model_blocks.add_block(sub, "claude-sonnet-5-5")
    message = explain_unavailable([capped, sub], "claude-sonnet-5-5")
    assert "console: spend cap $1.00 reached" in message
    assert "sub: subscription does not serve claude-sonnet-5-5" in message
    assert "add one" in explain_unavailable([], "x")
