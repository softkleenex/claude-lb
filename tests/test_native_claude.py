from __future__ import annotations

import json
from pathlib import Path

import httpx

from claude_lb.core.crypto import encrypt, mask_secret
from claude_lb.db.models import Account
from claude_lb.db.session import session_scope
from claude_lb.main import create_app
from claude_lb.modules.proxy import native_claude, sticky
from claude_lb.modules.proxy.usage_parser import StreamUsageCollector, Usage


def test_prompt_preserves_conversation_and_client_tools():
    prompt, names, forced = native_claude._render_prompt(
        {
            "system": "Be concise.",
            "messages": [
                {"role": "user", "content": "weather?"},
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "toolu_1",
                            "name": "weather",
                            "input": {"city": "Seoul"},
                        }
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "toolu_1",
                            "content": "sunny",
                        }
                    ],
                },
            ],
            "tools": [
                {
                    "name": "weather",
                    "description": "weather lookup",
                    "input_schema": {"type": "object"},
                }
            ],
            "tool_choice": {"type": "tool", "name": "weather"},
        }
    )
    assert "<system>\nBe concise." in prompt
    assert '"tool_use_id": "toolu_1"' in prompt
    assert "weather lookup" in prompt
    assert names == {"weather"}
    assert forced == "weather"


def test_message_and_buffered_sse_are_anthropic_compatible():
    usage = Usage(input_tokens=10, output_tokens=4, model="claude-sonnet-5-5")
    content, stop = native_claude._content(
        {
            "stop_reason": "tool_use",
            "content": [
                {"type": "text", "text": "checking"},
                {"type": "tool_use", "name": "weather", "input": {"city": "Seoul"}},
            ],
        },
        {"weather"},
    )
    message = native_claude._message("claude-sonnet-5-5", content, stop, usage)
    assert message["stop_reason"] == "tool_use"
    assert message["content"][1]["id"].startswith("toolu_")

    encoded = native_claude._sse(message)
    assert b"event: message_start" in encoded
    assert b'"type":"input_json_delta"' in encoded
    assert encoded.endswith(b'event: message_stop\ndata: {"type":"message_stop"}\n\n')
    collector = StreamUsageCollector()
    collector.feed(encoded)
    collector.close()
    assert collector.usage.input_tokens == 10
    assert collector.usage.output_tokens == 4
    assert collector.usage.model == "claude-sonnet-5-5"


async def test_invoke_isolates_profile_and_keeps_token_out_of_argv(monkeypatch, tmp_path):
    token = "sk-ant-oat01-secret-value"
    captured = {}

    class Process:
        returncode = 0

        async def communicate(self, prompt):
            captured["prompt"] = prompt
            return (
                json.dumps(
                    {
                        "structured_output": {
                            "stop_reason": "end_turn",
                            "content": [{"type": "text", "text": "X"}],
                        },
                        "usage": {"input_tokens": 2, "output_tokens": 1},
                    }
                ).encode(),
                b"",
            )

    async def fake_process(*argv, **kwargs):
        captured["argv"] = argv
        captured["env"] = kwargs["env"]
        captured["cwd"] = kwargs["cwd"]
        return Process()

    class Settings:
        data_dir = Path(tmp_path)
        upstream_timeout_seconds = 5.0

    monkeypatch.setattr(native_claude, "get_settings", lambda: Settings())
    monkeypatch.setattr(native_claude, "claude_cli", lambda: "/usr/local/bin/claude")
    monkeypatch.setattr(native_claude.asyncio, "create_subprocess_exec", fake_process)

    result = await native_claude.invoke(
        account_id="account-1",
        token=token,
        payload={
            "model": "claude-opus-5-5",
            "max_tokens": 8,
            "messages": [{"role": "user", "content": "reply X"}],
        },
    )

    assert token not in captured["argv"]
    assert captured["argv"][captured["argv"].index("--mcp-config") + 1] == '{"mcpServers":{}}'
    assert captured["env"]["CLAUDE_CODE_OAUTH_TOKEN"] == token
    assert "ANTHROPIC_API_KEY" not in captured["env"]
    assert captured["env"]["CLAUDE_CONFIG_DIR"] == str(tmp_path / "claude-code-accounts/account-1")
    assert captured["cwd"] == tmp_path / "claude-code-accounts/account-1"
    assert json.loads(result.body)["content"] == [{"type": "text", "text": "X"}]


async def test_native_account_routes_messages_without_direct_upstream(monkeypatch):
    async with session_scope() as session:
        session.add(
            Account(
                id="native-id",
                name="subscription",
                provider="oauth",
                encrypted_credential=encrypt("sk-ant-oat-test"),
                credential_hint=mask_secret("sk-ant-oat-test"),
                auth_scheme="bearer",
                transport="claude_code",
                plan_type="max_5x",
                routing_policy="burn_first",
            )
        )

    calls = []

    async def fake_invoke(**kwargs):
        calls.append(kwargs)
        usage = Usage(input_tokens=12, output_tokens=3, model=kwargs["payload"]["model"])
        body = json.dumps(
            native_claude._message(
                kwargs["payload"]["model"], [{"type": "text", "text": "X"}], "end_turn", usage
            )
        ).encode()
        return native_claude.NativeResult(body=body, stream=False, usage=usage)

    monkeypatch.setattr(native_claude, "invoke", fake_invoke)
    app = create_app()
    sticky.clear()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://localhost"
    ) as client:
        async with app.router.lifespan_context(app):
            await app.state.http_client.aclose()

            def direct_upstream_was_not_used(_request: httpx.Request) -> httpx.Response:
                raise AssertionError("native Messages request reached the direct HTTP upstream")

            app.state.http_client = httpx.AsyncClient(
                transport=httpx.MockTransport(direct_upstream_was_not_used)
            )
            response = await client.post(
                "/v1/messages",
                json={
                    "model": "claude-sonnet-5-5",
                    "max_tokens": 8,
                    "messages": [{"role": "user", "content": "reply X"}],
                },
            )

    assert response.status_code == 200
    assert response.headers["x-claude-lb-account"] == "subscription"
    assert response.json()["content"] == [{"type": "text", "text": "X"}]
    assert calls[0]["account_id"] == "native-id"
    assert calls[0]["token"] == "sk-ant-oat-test"


async def test_native_failure_falls_back_to_http_account(monkeypatch):
    async with session_scope() as session:
        session.add_all(
            [
                Account(
                    id="native-id",
                    name="subscription",
                    provider="oauth",
                    encrypted_credential=encrypt("sk-ant-oat-test"),
                    credential_hint=mask_secret("sk-ant-oat-test"),
                    auth_scheme="bearer",
                    transport="claude_code",
                    plan_type="max_5x",
                    routing_policy="burn_first",
                ),
                Account(
                    id="api-id",
                    name="console-backup",
                    provider="anthropic_api_key",
                    encrypted_credential=encrypt("sk-ant-api-test"),
                    credential_hint=mask_secret("sk-ant-api-test"),
                    auth_scheme="x-api-key",
                    transport="http",
                    plan_type="api",
                    routing_policy="preserve",
                ),
            ]
        )

    async def fail_native(**_kwargs):
        raise native_claude.NativeClaudeError("native backend unavailable")

    direct_calls = []

    def direct_upstream(request: httpx.Request) -> httpx.Response:
        direct_calls.append(request)
        return httpx.Response(
            200,
            json={
                "id": "msg_fallback",
                "type": "message",
                "role": "assistant",
                "content": [{"type": "text", "text": "fallback"}],
                "model": "claude-opus-5-5",
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 2, "output_tokens": 1},
            },
        )

    monkeypatch.setattr(native_claude, "invoke", fail_native)
    app = create_app()
    sticky.clear()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://localhost"
    ) as client:
        async with app.router.lifespan_context(app):
            await app.state.http_client.aclose()
            app.state.http_client = httpx.AsyncClient(transport=httpx.MockTransport(direct_upstream))
            response = await client.post(
                "/v1/messages",
                json={
                    "model": "claude-opus-5-5",
                    "max_tokens": 8,
                    "messages": [{"role": "user", "content": "reply"}],
                },
            )

    assert response.status_code == 200
    assert response.headers["x-claude-lb-account"] == "console-backup"
    assert response.json()["content"] == [{"type": "text", "text": "fallback"}]
    assert len(direct_calls) == 1
    assert direct_calls[0].headers["x-api-key"] == "sk-ant-api-test"


async def test_switching_transport_clears_model_blocks():
    from claude_lb.modules.proxy import model_blocks

    async with session_scope() as session:
        account = Account(
            id="switch-id",
            name="subscription",
            provider="oauth",
            encrypted_credential=encrypt("sk-ant-oat-test"),
            credential_hint=mask_secret("sk-ant-oat-test"),
            auth_scheme="bearer",
            transport="http",
            plan_type="max_5x",
        )
        model_blocks.add_block(account, "claude-sonnet-4-6")
        session.add(account)

    app = create_app()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://localhost"
    ) as client:
        async with app.router.lifespan_context(app):
            res = await client.patch("/api/accounts/switch-id", json={"transport": "claude_code"})

    assert res.status_code == 200
    body = res.json()
    assert body["transport"] == "claude_code"
    assert body["blocked_models"] == []
    assert body["model_blocks"] == []
