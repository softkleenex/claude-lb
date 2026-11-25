"""Add a Claude subscription by letting Claude Code itself do the login.

claude-lb never speaks claude.ai's OAuth flow: it ships no client id and does not pose
as Claude Code. ``claude setup-token`` is Anthropic's own command for minting a
long-lived subscription token; we run it in a throwaway config directory (so the
operator's existing Claude Code login and sessions are untouched), pick the token out of
its output, and confirm it works before storing it.
"""

from __future__ import annotations

import os
import pty
import re
import shutil
import tempfile
from dataclasses import dataclass

import httpx

TOKEN_PREFIX = "sk-ant-oat"
_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[@-Z\\-_]")
_TOKEN = re.compile(r"sk-ant-oat\d*-[A-Za-z0-9_\-]+")
_CONTINUATION = re.compile(r"[A-Za-z0-9_\-]+")
VERIFY_MODEL = "claude-haiku-4-5"


class SubscriptionLoginError(RuntimeError):
    pass


def claude_cli() -> str | None:
    return shutil.which("claude")


def run_setup_token(claude_path: str) -> str:
    """Run ``claude setup-token`` interactively and return everything it printed.

    A pty keeps it fully interactive (browser hand-off, the code prompt) while we see the
    same bytes the operator does.
    """
    captured: list[bytes] = []

    def _read(fd: int) -> bytes:
        data = os.read(fd, 4096)
        captured.append(data)
        return data

    with tempfile.TemporaryDirectory(prefix="claude-lb-login-") as config_dir:
        previous = os.environ.get("CLAUDE_CONFIG_DIR")
        os.environ["CLAUDE_CONFIG_DIR"] = config_dir
        try:
            status = pty.spawn([claude_path, "setup-token"], _read)
        finally:
            if previous is None:
                os.environ.pop("CLAUDE_CONFIG_DIR", None)
            else:
                os.environ["CLAUDE_CONFIG_DIR"] = previous
    if os.waitstatus_to_exitcode(status) != 0:
        raise SubscriptionLoginError("claude setup-token did not finish (cancelled or failed)")
    return b"".join(captured).decode("utf-8", errors="replace")


def token_candidates(output: str) -> list[str]:
    """Tokens found in terminal output, most likely first.

    A terminal can wrap a long token across lines. Following lines made only of token
    characters are treated as continuations; every shorter reading is offered too, and
    verification decides which (if any) is real.
    """
    lines = [line.strip() for line in _ANSI.sub("", output).replace("\r", "\n").split("\n")]
    lines = [line for line in lines if line]
    found: list[str] = []
    for index, line in enumerate(lines):
        for match in _TOKEN.finditer(line):
            pieces = [match.group(0)]
            if match.end() == len(line):  # token runs to the end of the line: may wrap
                for follow in lines[index + 1 :]:
                    if not _CONTINUATION.fullmatch(follow):
                        break
                    pieces.append(follow)
            for size in range(len(pieces), 0, -1):
                candidate = "".join(pieces[:size])
                if candidate not in found:
                    found.append(candidate)
    return found


@dataclass
class VerifyResult:
    ok: bool
    status_code: int | None
    headers: dict[str, str]
    detail: str


async def verify_token(client: httpx.AsyncClient, base_url: str, token: str) -> VerifyResult:
    """One tiny request: proves the token works and reads the 5h/7d quota headers."""
    try:
        response = await client.post(
            f"{base_url.rstrip('/')}/v1/messages",
            headers={
                "authorization": f"Bearer {token}",
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={"model": VERIFY_MODEL, "max_tokens": 1, "messages": [{"role": "user", "content": "hi"}]},
            timeout=30,
        )
    except httpx.HTTPError as exc:
        return VerifyResult(False, None, {}, f"{type(exc).__name__}: {exc}")
    return VerifyResult(
        response.status_code == 200,
        response.status_code,
        dict(response.headers),
        "ok" if response.status_code == 200 else response.text[:200],
    )
