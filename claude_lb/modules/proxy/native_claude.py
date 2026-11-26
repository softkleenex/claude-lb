"""Run subscription requests through Anthropic's unmodified Claude Code CLI.

Claude subscription credentials can expose a different model set through Claude Code
than through the public Messages endpoint.  This transport keeps Claude Code in charge
of that authenticated request, then converts its result back to the Messages response
shape expected by claude-lb clients.  Built-in Claude Code tools are disabled: client
tools remain client tools and are returned as ``tool_use`` blocks instead of being run
on the gateway host.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import uuid
from dataclasses import dataclass
from typing import Any

from claude_lb.core.config import get_settings
from claude_lb.modules.proxy.usage_parser import Usage

TRANSPORT_HTTP = "http"
TRANSPORT_CLAUDE_CODE = "claude_code"
TRANSPORTS = (TRANSPORT_HTTP, TRANSPORT_CLAUDE_CODE)

_OUTPUT_SCHEMA = json.dumps(
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["stop_reason", "content"],
        "properties": {
            "stop_reason": {"enum": ["end_turn", "tool_use", "max_tokens"]},
            "content": {
                "type": "array",
                "items": {
                    "oneOf": [
                        {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["type", "text"],
                            "properties": {
                                "type": {"const": "text"},
                                "text": {"type": "string"},
                            },
                        },
                        {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["type", "name", "input"],
                            "properties": {
                                "type": {"const": "tool_use"},
                                "name": {"type": "string"},
                                "input": {"type": "object"},
                            },
                        },
                    ]
                },
            },
        },
    },
    separators=(",", ":"),
)

_SYSTEM_PROMPT = """You are the model backend for an Anthropic Messages API compatibility layer.
Follow the supplied conversation and system instructions. Return only the structured
output requested by the JSON schema. Never invoke Claude Code built-in tools. When the
conversation requires one of the supplied client tools, return a tool_use item with its
exact name and JSON input; the client, not you, executes it. Otherwise return text.
Do not mention this compatibility layer."""


class NativeClaudeError(RuntimeError):
    """Claude Code could not produce a usable Messages response."""


class NativeRequestError(NativeClaudeError):
    """The client request cannot be represented safely by this transport."""


@dataclass
class NativeResult:
    body: bytes
    stream: bool
    usage: Usage


def claude_cli() -> str | None:
    return shutil.which("claude")


def _text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        raise NativeRequestError("message content must be a string or content-block list")
    rendered: list[str] = []
    for block in value:
        if not isinstance(block, dict):
            raise NativeRequestError("message content blocks must be objects")
        kind = block.get("type")
        if kind == "text" and isinstance(block.get("text"), str):
            rendered.append(block["text"])
        elif kind == "tool_use":
            rendered.append(
                "<tool_use>"
                + json.dumps(
                    {
                        "id": block.get("id"),
                        "name": block.get("name"),
                        "input": block.get("input"),
                    },
                    ensure_ascii=False,
                )
                + "</tool_use>"
            )
        elif kind == "tool_result":
            rendered.append(
                "<tool_result>"
                + json.dumps(
                    {
                        "tool_use_id": block.get("tool_use_id"),
                        "content": block.get("content"),
                        "is_error": bool(block.get("is_error", False)),
                    },
                    ensure_ascii=False,
                )
                + "</tool_result>"
            )
        else:
            raise NativeRequestError(f"content block type {kind!r} is not supported by claude_code transport")
    return "\n".join(rendered)


def _render_prompt(payload: dict[str, Any]) -> tuple[str, set[str], str | None]:
    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        raise NativeRequestError("messages must be a non-empty list")

    sections: list[str] = []
    system = payload.get("system")
    if system is not None:
        sections.append("<system>\n" + _text(system) + "\n</system>")

    for message in messages:
        if not isinstance(message, dict) or message.get("role") not in {"user", "assistant"}:
            raise NativeRequestError("each message needs a user or assistant role")
        sections.append(f"<{message['role']}>\n{_text(message.get('content'))}\n</{message['role']}>")

    tool_names: set[str] = set()
    tools = payload.get("tools", [])
    if tools is not None:
        if not isinstance(tools, list):
            raise NativeRequestError("tools must be a list")
        normalized: list[dict[str, Any]] = []
        for tool in tools:
            if not isinstance(tool, dict) or not isinstance(tool.get("name"), str):
                raise NativeRequestError("claude_code transport supports client tools with a name")
            tool_names.add(tool["name"])
            normalized.append(
                {
                    "name": tool["name"],
                    "description": tool.get("description", ""),
                    "input_schema": tool.get("input_schema", {"type": "object"}),
                }
            )
        if normalized:
            sections.append(
                "<available_client_tools>\n"
                + json.dumps(normalized, ensure_ascii=False)
                + "\n</available_client_tools>"
            )

    forced_tool: str | None = None
    choice = payload.get("tool_choice")
    if isinstance(choice, dict):
        choice_type = choice.get("type")
        if choice_type == "tool":
            forced_tool = choice.get("name")
            if forced_tool not in tool_names:
                raise NativeRequestError("tool_choice names a tool that is not present")
            sections.append(
                f'You must return a tool_use item in content with name "{forced_tool}" '
                'and stop_reason "tool_use".'
            )
        elif choice_type in {"any", "auto"}:
            if choice_type == "any":
                forced_tool = "*"
                sections.append(
                    "You must return at least one tool_use item from available_client_tools "
                    'in content and stop_reason "tool_use".'
                )
        elif choice_type == "none":
            tool_names.clear()
            sections.append("Do not call a tool; return text.")
        elif choice_type is not None:
            raise NativeRequestError(f"unsupported tool_choice type {choice_type!r}")

    return "\n\n".join(sections), tool_names, forced_tool


def _usage(raw: Any, model: str) -> Usage:
    usage = Usage(model=model)
    if not isinstance(raw, dict):
        return usage
    usage.merge(raw)
    return usage


def _content(raw: Any, allowed_tools: set[str]) -> tuple[list[dict[str, Any]], str]:
    if not isinstance(raw, dict):
        raise NativeClaudeError("Claude Code returned no structured output")
    items = raw.get("content")
    if not isinstance(items, list):
        raise NativeClaudeError("Claude Code structured output has no content list")
    content: list[dict[str, Any]] = []
    saw_tool = False
    for item in items:
        if not isinstance(item, dict):
            raise NativeClaudeError("Claude Code returned an invalid content item")
        if item.get("type") == "text" and isinstance(item.get("text"), str):
            content.append({"type": "text", "text": item["text"]})
        elif (
            item.get("type") == "tool_use"
            and isinstance(item.get("name"), str)
            and isinstance(item.get("input"), dict)
            and item["name"] in allowed_tools
        ):
            saw_tool = True
            content.append(
                {
                    "type": "tool_use",
                    "id": f"toolu_{uuid.uuid4().hex}",
                    "name": item["name"],
                    "input": item["input"],
                }
            )
        else:
            raise NativeClaudeError("Claude Code returned an unknown or unavailable tool")
    stop_reason = "tool_use" if saw_tool else raw.get("stop_reason", "end_turn")
    if stop_reason not in {"end_turn", "tool_use", "max_tokens"}:
        stop_reason = "end_turn"
    return content, stop_reason


def _message(model: str, content: list[dict[str, Any]], stop_reason: str, usage: Usage) -> dict[str, Any]:
    return {
        "id": f"msg_{uuid.uuid4().hex}",
        "type": "message",
        "role": "assistant",
        "content": content,
        "model": model,
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": usage.as_dict(),
    }


def _sse(message: dict[str, Any]) -> bytes:
    start = {**message, "content": [], "stop_reason": None, "stop_sequence": None}
    events: list[tuple[str, dict[str, Any]]] = [
        ("message_start", {"type": "message_start", "message": start})
    ]
    for index, block in enumerate(message["content"]):
        if block["type"] == "text":
            events.extend(
                [
                    (
                        "content_block_start",
                        {
                            "type": "content_block_start",
                            "index": index,
                            "content_block": {"type": "text", "text": ""},
                        },
                    ),
                    (
                        "content_block_delta",
                        {
                            "type": "content_block_delta",
                            "index": index,
                            "delta": {"type": "text_delta", "text": block["text"]},
                        },
                    ),
                    ("content_block_stop", {"type": "content_block_stop", "index": index}),
                ]
            )
        else:
            events.extend(
                [
                    (
                        "content_block_start",
                        {
                            "type": "content_block_start",
                            "index": index,
                            "content_block": {
                                "type": "tool_use",
                                "id": block["id"],
                                "name": block["name"],
                                "input": {},
                            },
                        },
                    ),
                    (
                        "content_block_delta",
                        {
                            "type": "content_block_delta",
                            "index": index,
                            "delta": {
                                "type": "input_json_delta",
                                "partial_json": json.dumps(block["input"], ensure_ascii=False),
                            },
                        },
                    ),
                    ("content_block_stop", {"type": "content_block_stop", "index": index}),
                ]
            )
    events.extend(
        [
            (
                "message_delta",
                {
                    "type": "message_delta",
                    "delta": {"stop_reason": message["stop_reason"], "stop_sequence": None},
                    "usage": {"output_tokens": message["usage"]["output_tokens"]},
                },
            ),
            ("message_stop", {"type": "message_stop"}),
        ]
    )
    return b"".join(
        f"event: {name}\ndata: {json.dumps(data, ensure_ascii=False, separators=(',', ':'))}\n\n".encode()
        for name, data in events
    )


async def invoke(*, account_id: str, token: str, payload: dict[str, Any]) -> NativeResult:
    model = payload.get("model")
    if not isinstance(model, str) or not model:
        raise NativeRequestError("model must be a non-empty string")
    prompt, allowed_tools, required_tool = _render_prompt(payload)
    executable = claude_cli()
    if executable is None:
        raise NativeClaudeError("Claude Code is not installed on the gateway host")

    profile = get_settings().data_dir / "claude-code-accounts" / account_id
    profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        profile.chmod(0o700)
    except OSError:
        pass

    env = os.environ.copy()
    env.pop("ANTHROPIC_API_KEY", None)
    env.pop("ANTHROPIC_AUTH_TOKEN", None)
    env["CLAUDE_CONFIG_DIR"] = str(profile)
    env["CLAUDE_CODE_OAUTH_TOKEN"] = token
    env["NO_COLOR"] = "1"

    try:
        process = await asyncio.create_subprocess_exec(
            executable,
            "-p",
            "--model",
            model,
            "--output-format",
            "json",
            "--tools",
            "",
            "--permission-mode",
            "dontAsk",
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
            "--system-prompt",
            _SYSTEM_PROMPT,
            "--json-schema",
            _OUTPUT_SCHEMA,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=profile,
            env=env,
        )
    except OSError as exc:
        raise NativeClaudeError(f"could not start Claude Code: {exc}") from exc
    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(prompt.encode()), timeout=get_settings().upstream_timeout_seconds
        )
    except TimeoutError as exc:
        process.kill()
        await process.wait()
        raise NativeClaudeError("Claude Code timed out") from exc
    except asyncio.CancelledError:
        process.kill()
        await process.wait()
        raise
    if process.returncode != 0:
        detail = stderr.decode(errors="replace").strip().splitlines()[-1:] or ["unknown error"]
        raise NativeClaudeError(f"Claude Code exited with {process.returncode}: {detail[0][:300]}")
    try:
        raw = json.loads(stdout)
    except (ValueError, UnicodeDecodeError) as exc:
        raise NativeClaudeError("Claude Code returned unreadable JSON") from exc

    structured = raw.get("structured_output")
    if structured is None and isinstance(raw.get("result"), str):
        try:
            structured = json.loads(raw["result"])
        except ValueError:
            structured = {"stop_reason": "end_turn", "content": [{"type": "text", "text": raw["result"]}]}
    content, stop_reason = _content(structured, allowed_tools)
    if required_tool == "*" and not any(block["type"] == "tool_use" for block in content):
        raise NativeClaudeError("Claude Code did not return the required client tool call")
    if required_tool not in {None, "*"} and not any(
        block["type"] == "tool_use" and block["name"] == required_tool for block in content
    ):
        raise NativeClaudeError(f"Claude Code did not call the required client tool {required_tool}")
    usage = _usage(raw.get("usage"), model)
    message = _message(model, content, stop_reason, usage)
    wants_stream = bool(payload.get("stream"))
    return NativeResult(
        body=_sse(message) if wants_stream else json.dumps(message, ensure_ascii=False).encode(),
        stream=wants_stream,
        usage=usage,
    )


async def one_chunk(body: bytes):
    yield body
