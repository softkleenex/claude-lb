"""`claude-lb demo`: the real server, a simulated upstream, and synthetic traffic.

Nothing leaves the machine and no API key is needed. The upstream is a small fake of
the Messages API mounted on the same app, and it behaves like the real one in the
way that matters here: its prompt cache is scoped to the *credential*, so a cached
prefix only reads cheaply on the account that wrote it. That makes the dashboard's
"saved by prompt cache" figure a live demonstration of why cache affinity matters.

It runs against a throwaway data directory, so it never touches a real instance.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import random
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

# Module-level, not inside the factory: with postponed annotations FastAPI resolves a
# route's parameter types from module globals, and a locally imported `Request` would
# be read as a query parameter.
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

DEMO_UPSTREAM_PREFIX = "/__demo-upstream"

MODELS = [
    # id, display name, share of traffic
    ("claude-opus-5-5", "Claude Opus 5.5", 0.45),
    ("claude-sonnet-5-5", "Claude Sonnet 5.5", 0.40),
    ("claude-haiku-5-5", "Claude Haiku 5.5", 0.15),
]

ACCOUNTS = [
    # name, weight, priority, simulated rate limit (requests per minute), plan_type, routing_policy
    ("prod-us", 2.0, 10, 4000, "api", "normal"),
    ("prod-eu", 1.0, 5, 2000, "api", "normal"),
    ("claude-max-5x", 1.0, 8, 1000, "max_5x", "burn_first"),
    ("claude-pro", 1.0, 6, 500, "pro", "normal"),
]

KEYS = [
    # name, budget kwargs
    ("claude-code-team", {}),
    ("ci-review-bot", {"max_cost_usd_per_window": 25.0, "window_seconds": 3600}),
    (
        "support-agent",
        {
            "limits": [
                {"metric": "requests", "window": "5h", "max_value": 5000},
                {"metric": "cost_usd", "window": "monthly", "max_value": 250.0},
                {
                    "metric": "output_tokens",
                    "window": "daily",
                    "max_value": 2_000_000,
                    "model_filter": "claude-opus-5-5",
                },
            ]
        },
    ),
]

USER_AGENTS = ["claude-cli/2.1.3 (external, cli)", "anthropic-python/0.72.0", "ci-review-bot/1.4"]

# Conversations differ in their cacheable prefix (system + tools + first turn); a
# client keeps adding turns to one, which is what sticky routing keys on.
# Repeated to roughly the size of a real agent's system prompt and tool definitions
# (Claude Code's runs to tens of thousands of tokens), where caching pays off.
SYSTEM_PROMPTS = [
    "You are a senior code reviewer for a large Python monorepo. " * 320,
    "You are a customer-support agent with the following policy handbook. " * 480,
    "You are a data analyst. The warehouse schema follows. " * 400,
    "You are a release-notes writer. House style guide: " * 240,
]


def default_host() -> str:
    # Inside a container, 127.0.0.1 is unreachable through a published port.
    return "0.0.0.0" if os.environ.get("CLAUDE_LB_IN_DOCKER") == "1" else "127.0.0.1"


def is_loopback_bind(host: str) -> bool:
    return host in ("127.0.0.1", "::1", "localhost")


def prepare_environment(port: int, host: str = "127.0.0.1") -> Path:
    """Point settings at a fresh temp dir. Must run before anything reads settings."""
    data_dir = Path(tempfile.mkdtemp(prefix="claude-lb-demo-"))
    os.environ["CLAUDE_LB_DATA_DIR"] = str(data_dir)
    os.environ["CLAUDE_LB_DATABASE_URL"] = f"sqlite+aiosqlite:///{data_dir / 'demo.db'}"
    os.environ["CLAUDE_LB_REQUIRE_API_KEY"] = "true"
    os.environ["CLAUDE_LB_HOST"] = host
    os.environ["CLAUDE_LB_PORT"] = str(port)
    # Reached from outside (a published container port), requests do not come from
    # loopback, so the dashboard would demand the bootstrap token. The demo holds only
    # simulated data and fake credentials, so it opens the dashboard instead.
    os.environ["CLAUDE_LB_DASHBOARD_AUTH_ENABLED"] = "true" if is_loopback_bind(host) else "false"
    os.environ.pop("CLAUDE_LB_SECRET_KEY", None)

    from claude_lb.core import crypto
    from claude_lb.core.config import get_settings

    get_settings.cache_clear()
    crypto._fernet.cache_clear()
    return data_dir


# ---- simulated upstream --------------------------------------------------------


def mount_fake_upstream(app) -> None:
    """Add the fake upstream to ``app`` ahead of every existing route.

    The dashboard's SPA fallback (registered last by ``create_app``) answers any other
    GET, so appended upstream routes would never see ``GET /v1/models`` — the health
    probe and model sync would get the dashboard's HTML and find no models.
    """
    existing = list(app.router.routes)
    app.include_router(build_fake_upstream())
    added = app.router.routes[len(existing) :]
    app.router.routes[:] = added + existing


def build_fake_upstream():
    router = APIRouter(prefix=DEMO_UPSTREAM_PREFIX, include_in_schema=False)
    # (credential, prefix hash) -> cached prefix size. Scoped per credential, as
    # Anthropic's prompt cache is.
    cache: dict[tuple[str, str], int] = {}
    calls: dict[str, int] = {}

    def _rate_headers(credential: str, limit: int, *, is_subscription: bool = False) -> dict[str, str]:
        calls[credential] = calls.get(credential, 0) + 1
        used = calls[credential] % limit
        now_dt = datetime.now(UTC)
        reset = (now_dt + timedelta(seconds=60 - now_dt.second)).isoformat()
        if is_subscription:
            pri_util = min(0.92, (calls[credential] % 80) / 100.0 + 0.12)
            sec_util = min(0.65, (calls[credential] % 200) / 400.0 + 0.08)
            pri_reset = int((now_dt + timedelta(hours=3, minutes=42)).timestamp())
            sec_reset = int((now_dt + timedelta(days=4, hours=6)).timestamp())
            return {
                "anthropic-ratelimit-unified-status": "allowed_warning" if pri_util >= 0.75 else "allowed",
                "anthropic-ratelimit-unified-5h-utilization": f"{pri_util:.2f}",
                "anthropic-ratelimit-unified-5h-reset": str(pri_reset),
                "anthropic-ratelimit-unified-7d-utilization": f"{sec_util:.2f}",
                "anthropic-ratelimit-unified-7d-reset": str(sec_reset),
            }
        return {
            "anthropic-ratelimit-requests-limit": str(limit),
            "anthropic-ratelimit-requests-remaining": str(max(limit - used * 7, limit // 10)),
            "anthropic-ratelimit-tokens-limit": str(limit * 2000),
            "anthropic-ratelimit-tokens-remaining": str(max(limit * 2000 - used * 9000, limit * 200)),
            "anthropic-ratelimit-requests-reset": reset,
        }

    @router.get("/v1/models")
    async def models() -> dict:
        return {
            "data": [
                {
                    "type": "model",
                    "id": mid,
                    "display_name": name,
                    "max_input_tokens": 1_000_000,
                    "max_tokens": 128_000,
                }
                for mid, name, _ in MODELS
            ],
            "has_more": False,
        }

    @router.post("/v1/messages")
    async def messages(request: Request):
        auth_header = request.headers.get("authorization", "")
        credential = auth_header.removeprefix("Bearer ").strip() or request.headers.get("x-api-key", "")
        is_sub = bool(auth_header)
        limit = next((rpm for name, _, _, rpm, _, _ in ACCOUNTS if credential.endswith(name)), 1000)
        body = await request.json()
        model = body.get("model", MODELS[0][0])

        await asyncio.sleep(random.uniform(0.15, 0.6))
        if random.random() < 0.02:
            return JSONResponse(
                status_code=529,
                content={"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}},
            )

        prefix = json.dumps([body.get("system"), body.get("messages", [{}])[:1]], sort_keys=True)
        prefix_key = (credential, hashlib.sha256(prefix.encode()).hexdigest())
        prefix_tokens = len(prefix) // 4
        cached = cache.get(prefix_key)
        if cached:
            usage = {"cache_read_input_tokens": cached, "cache_creation_input_tokens": 0}
        else:
            cache[prefix_key] = prefix_tokens
            usage = {"cache_read_input_tokens": 0, "cache_creation_input_tokens": prefix_tokens}
        usage["input_tokens"] = random.randint(40, 900)
        output_tokens = random.randint(80, 1600)
        headers = _rate_headers(credential, limit, is_subscription=is_sub)
        message_id = f"msg_demo_{random.getrandbits(48):012x}"

        if not body.get("stream"):
            return JSONResponse(
                headers=headers,
                content={
                    "id": message_id,
                    "type": "message",
                    "role": "assistant",
                    "model": model,
                    "content": [{"type": "text", "text": "(simulated response)"}],
                    "stop_reason": "end_turn",
                    "usage": {**usage, "output_tokens": output_tokens},
                },
            )

        async def events():
            start = {
                "type": "message_start",
                "message": {"id": message_id, "model": model, "usage": {**usage, "output_tokens": 1}},
            }
            yield f"event: message_start\ndata: {json.dumps(start)}\n\n".encode()
            for _ in range(3):
                await asyncio.sleep(0.05)
                delta = {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": "…"},
                }
                yield f"event: content_block_delta\ndata: {json.dumps(delta)}\n\n".encode()
            end = {
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn"},
                "usage": {"output_tokens": output_tokens},
            }
            yield f"event: message_delta\ndata: {json.dumps(end)}\n\n".encode()
            yield b'event: message_stop\ndata: {"type":"message_stop"}\n\n'

        return StreamingResponse(events(), media_type="text/event-stream", headers=headers)

    return router


# ---- seed data -----------------------------------------------------------------


async def seed(port: int) -> list[str]:
    """Accounts, keys, a day of request history, and four weeks of rollups."""
    from sqlalchemy import func, select, update

    from claude_lb.core.crypto import encrypt, mask_secret
    from claude_lb.core.pricing import estimate_cost_usd
    from claude_lb.db.models import Account, RequestLog, UsageDaily
    from claude_lb.db.session import session_scope
    from claude_lb.modules.api_keys.service import LimitRuleInput, create_api_key
    from claude_lb.modules.usage import rollup

    rng = random.Random(7)
    base_url = f"http://127.0.0.1:{port}{DEMO_UPSTREAM_PREFIX}"
    account_ids: list[str] = []
    key_ids: list[str] = []
    plaintext_keys: list[str] = []

    async with session_scope() as session:
        for name, weight, priority, _, plan_type, routing_policy in ACCOUNTS:
            is_sub = plan_type != "api"
            secret = f"tok-demo-{name}" if is_sub else f"sk-ant-demo-{name}"
            account = Account(
                name=name,
                provider="oauth" if is_sub else "anthropic_api_key",
                auth_scheme="bearer" if is_sub else "x-api-key",
                encrypted_credential=encrypt(secret),
                credential_hint=mask_secret(secret),
                base_url=base_url,
                weight=weight,
                priority=priority,
                plan_type=plan_type,
                routing_policy=routing_policy,
                primary_used_percent=28.0 if is_sub else None,
                primary_reset_at=datetime.now(UTC) + timedelta(hours=3) if is_sub else None,
                secondary_used_percent=14.0 if is_sub else None,
                secondary_reset_at=datetime.now(UTC) + timedelta(days=5) if is_sub else None,
            )
            session.add(account)
            await session.flush()
            account_ids.append(account.id)
        for name, limits in KEYS:
            rules = [LimitRuleInput(**rule) for rule in limits.get("limits", [])]
            budget = {k: v for k, v in limits.items() if k != "limits"}
            issued = await create_api_key(session, name=name, limits=rules, **budget)
            key_ids.append(issued.record.id)
            plaintext_keys.append(issued.plaintext)

    now = datetime.now(UTC)
    model_ids = [m[0] for m in MODELS]
    weights = [m[2] for m in MODELS]
    async with session_scope() as session:
        for _ in range(900):
            model = rng.choices(model_ids, weights)[0]
            hit = rng.random() < 0.82
            prefix = rng.randint(6_000, 30_000)
            usage = {
                "input_tokens": rng.randint(40, 900),
                "output_tokens": rng.randint(80, 1600),
                "cache_read_input_tokens": prefix if hit else 0,
                "cache_creation_input_tokens": 0 if hit else prefix,
            }
            status = 200 if rng.random() > 0.015 else 529
            streaming = rng.random() < 0.7
            duration_ms = rng.randint(400, 9000)
            session.add(
                RequestLog(
                    created_at=now - timedelta(seconds=rng.randint(60, 86_000)),
                    account_id=rng.choices(account_ids, [2, 1, 1, 1])[0],
                    api_key_id=rng.choices(key_ids, [5, 2, 3])[0],
                    path="/v1/messages",
                    model=model,
                    status_code=status,
                    streaming=streaming,
                    duration_ms=duration_ms,
                    ttft_ms=rng.randint(250, min(duration_ms, 2500)) if streaming else None,
                    session_key=f"{rng.randrange(60):02x}".rjust(64, "d"),
                    user_agent=rng.choice(USER_AGENTS),
                    client_ip=f"10.0.0.{rng.randint(2, 40)}",
                    error="Overloaded" if status == 529 else None,
                    attempts=1 if status == 200 else 3,
                    cost_usd=estimate_cost_usd(model, **usage) if status == 200 else 0.0,
                    **(usage if status == 200 else {}),
                )
            )

    async with session_scope() as session:
        await rollup.backfill(session, days=2)
        for account_id in account_ids:
            totals = (
                await session.execute(
                    select(
                        func.count(RequestLog.id),
                        func.sum(RequestLog.input_tokens),
                        func.sum(RequestLog.output_tokens),
                        func.sum(RequestLog.cost_usd),
                    ).where(RequestLog.account_id == account_id)
                )
            ).one()
            await session.execute(
                update(Account)
                .where(Account.id == account_id)
                .values(
                    total_requests=totals[0] or 0,
                    total_input_tokens=totals[1] or 0,
                    total_output_tokens=totals[2] or 0,
                    total_cost_usd=totals[3] or 0.0,
                )
            )

        # Older days: rollups only, as if request logs had been pruned.
        for offset in range(2, 28):
            day = (now - timedelta(days=offset)).date().isoformat()
            weekday_factor = 0.45 if (now - timedelta(days=offset)).weekday() >= 5 else 1.0
            growth = 1 - offset / 45
            for account_id, share in zip(account_ids, (0.45, 0.2, 0.2, 0.15), strict=True):
                for model, model_share in zip(model_ids, weights, strict=True):
                    requests = int(
                        900 * weekday_factor * growth * share * model_share * rng.uniform(0.8, 1.2)
                    )
                    if requests == 0:
                        continue
                    cache_read = requests * rng.randint(9_000, 20_000)
                    cost = estimate_cost_usd(
                        model,
                        input_tokens=requests * 450,
                        output_tokens=requests * 800,
                        cache_read_input_tokens=cache_read,
                        cache_creation_input_tokens=cache_read // 6,
                    )
                    session.add(
                        UsageDaily(
                            day=day,
                            account_id=account_id,
                            api_key_id=None,
                            model=model,
                            requests=requests,
                            errors=max(0, requests // 80),
                            input_tokens=requests * 450,
                            output_tokens=requests * 800,
                            cache_creation_input_tokens=cache_read // 6,
                            cache_read_input_tokens=cache_read,
                            cost_usd=cost,
                        )
                    )
    return plaintext_keys


# ---- live traffic --------------------------------------------------------------


async def generate_traffic(port: int, keys: list[str], stop: asyncio.Event) -> None:
    import httpx

    rng = random.Random()
    conversations: list[list[dict]] = []
    async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}", timeout=30) as client:
        while not stop.is_set():
            if not conversations or rng.random() < 0.15:
                system = rng.choice(SYSTEM_PROMPTS)
                conversations.append(
                    [{"system": system}, {"role": "user", "content": f"task #{rng.randint(1, 10_000)}"}]
                )
                conversations[:] = conversations[-12:]
            convo = rng.choice(conversations)
            convo.append({"role": "assistant", "content": "…"})
            convo.append({"role": "user", "content": "continue"})
            body = {
                "model": rng.choices([m[0] for m in MODELS], [m[2] for m in MODELS])[0],
                "max_tokens": 1024,
                "system": convo[0]["system"],
                "messages": convo[1:],
                "stream": rng.random() < 0.6,
            }
            try:
                await client.post(
                    "/v1/messages",
                    json=body,
                    headers={
                        "x-api-key": rng.choice(keys),
                        "anthropic-version": "2023-06-01",
                        "user-agent": rng.choice(USER_AGENTS),
                    },
                )
            except httpx.HTTPError:
                pass
            try:
                await asyncio.wait_for(stop.wait(), timeout=rng.uniform(0.4, 1.6))
            except TimeoutError:
                pass


async def run(port: int, *, traffic: bool, on_ready, host: str = "127.0.0.1") -> None:
    import logging

    import uvicorn

    # Every simulated call would otherwise log twice (client side and proxy side).
    logging.getLogger("httpx").setLevel(logging.WARNING)

    from claude_lb.main import create_app

    app = create_app()
    mount_fake_upstream(app)

    config = uvicorn.Config(app, host=host, port=port, log_level="warning")
    server = uvicorn.Server(config)
    serve_task = asyncio.create_task(server.serve())
    while not server.started:
        if serve_task.done():
            await serve_task  # surfaces a bind error
            return
        await asyncio.sleep(0.05)

    keys = await seed(port)
    on_ready(keys)

    stop = asyncio.Event()
    traffic_task = asyncio.create_task(generate_traffic(port, keys, stop)) if traffic else None
    try:
        await serve_task
    finally:
        stop.set()
        if traffic_task is not None:
            await traffic_task
