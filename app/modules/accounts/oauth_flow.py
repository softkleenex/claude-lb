"""Authorization Code + PKCE, for adding an account by signing in through a browser.

Provider-neutral by construction: the authorize URL, token endpoint, client id, and
scopes all come from the operator. Nothing here knows about any particular provider.

The redirect lands on a loopback listener this process owns for the duration of the
flow (RFC 8252's native-app pattern). For a headless box there is a manual mode: run
the flow, open the printed URL somewhere with a browser, and paste the redirected URL
back.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import logging
import secrets
from dataclasses import dataclass, field
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT_SECONDS = 300.0
EXCHANGE_TIMEOUT_SECONDS = 30.0

_SUCCESS_PAGE = b"""<!doctype html><meta charset="utf-8"><title>claude-lb</title>
<style>body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;margin:0;display:grid;
place-items:center;height:100vh;background:#fbfaf9;color:#1c1b1a}
@media(prefers-color-scheme:dark){body{background:#171614;color:#eeeae5}}
div{text-align:center}h1{font-size:18px;margin:0 0 6px}p{color:#6b6560;margin:0}</style>
<div><h1>Signed in</h1><p>You can close this tab and return to the terminal.</p></div>"""

_FAILURE_PAGE = b"""<!doctype html><meta charset="utf-8"><title>claude-lb</title>
<style>body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;margin:0;display:grid;
place-items:center;height:100vh;background:#fbfaf9;color:#b3402e}
@media(prefers-color-scheme:dark){body{background:#171614;color:#e0705c}}</style>
<div><h1>Sign-in failed</h1><p>Check the terminal for details.</p></div>"""


class OAuthFlowError(RuntimeError):
    """The browser flow could not be completed."""


@dataclass
class TokenSet:
    access_token: str
    refresh_token: str | None = None
    expires_in: int | None = None
    scope: str | None = None
    token_type: str = "Bearer"
    raw: dict = field(default_factory=dict)


def generate_pkce_pair() -> tuple[str, str]:
    """``(verifier, challenge)`` for PKCE S256.

    S256 rather than ``plain``: with ``plain`` the verifier travels in the authorize
    request, so anything that can read that URL can complete the exchange.
    """
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(64)).decode().rstrip("=")
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    return verifier, challenge


@dataclass
class AuthorizationRequest:
    authorize_url: str
    client_id: str
    redirect_uri: str
    scope: str | None = None
    audience: str | None = None
    extra_params: dict[str, str] = field(default_factory=dict)

    state: str = field(default_factory=lambda: secrets.token_urlsafe(24))
    _pkce: tuple[str, str] = field(default_factory=generate_pkce_pair)

    @property
    def code_verifier(self) -> str:
        return self._pkce[0]

    @property
    def code_challenge(self) -> str:
        return self._pkce[1]

    def url(self) -> str:
        params = {
            "response_type": "code",
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "state": self.state,
            "code_challenge": self.code_challenge,
            "code_challenge_method": "S256",
        }
        if self.scope:
            params["scope"] = self.scope
        if self.audience:
            params["audience"] = self.audience
        params.update(self.extra_params)

        separator = "&" if urlparse(self.authorize_url).query else "?"
        return f"{self.authorize_url}{separator}{urlencode(params)}"


def parse_callback(url_or_query: str, *, expected_state: str) -> str:
    """Pull the authorization code out of a redirect URL, validating ``state``.

    Accepts a whole redirect URL or just its query string, because a human pasting
    from a browser bar may give either.
    """
    parsed = urlparse(url_or_query.strip())
    query = parsed.query or (url_or_query.strip() if "=" in url_or_query else "")
    params = parse_qs(query)

    if "error" in params:
        description = params.get("error_description", [""])[0]
        raise OAuthFlowError(
            f"authorization server returned {params['error'][0]}"
            + (f": {description}" if description else "")
        )

    state = params.get("state", [""])[0]
    # Constant-time, and mandatory: without it a forged redirect can graft an
    # attacker's code onto this flow.
    if not hmac.compare_digest(state, expected_state):
        raise OAuthFlowError("state parameter did not match; discarding this callback")

    code = params.get("code", [""])[0]
    if not code:
        raise OAuthFlowError("callback contained no authorization code")
    return code


class CallbackServer:
    """One-shot loopback listener for the redirect.

    Bound to 127.0.0.1 so nothing off-box can deliver a callback, and it stops after
    the first request that carries a code or an error.
    """

    def __init__(self, *, host: str = "127.0.0.1", port: int = 0) -> None:
        self._host = host
        self._port = port
        self._server: asyncio.AbstractServer | None = None
        self._result: asyncio.Future[str] = asyncio.get_event_loop().create_future()

    @property
    def port(self) -> int:
        if self._server is None:  # pragma: no cover - guarded by call order
            raise RuntimeError("server not started")
        return self._server.sockets[0].getsockname()[1]

    async def start(self) -> None:
        self._server = await asyncio.start_server(self._handle, self._host, self._port)

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            request_line = await asyncio.wait_for(reader.readline(), timeout=10)
            target = request_line.decode("latin-1").split(" ")[1] if b" " in request_line else "/"

            # A browser also asks for /favicon.ico; only the redirect carries params.
            has_params = "?" in target
            body = _SUCCESS_PAGE if has_params else _FAILURE_PAGE
            writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
                b"Content-Length: " + str(len(body)).encode() + b"\r\n"
                b"Connection: close\r\n\r\n" + body
            )
            await writer.drain()

            if has_params and not self._result.done():
                self._result.set_result(target)
        except (TimeoutError, ConnectionError, IndexError, UnicodeDecodeError):
            pass
        finally:
            writer.close()

    async def wait(self, timeout: float) -> str:
        try:
            return await asyncio.wait_for(asyncio.shield(self._result), timeout=timeout)
        except TimeoutError as exc:
            raise OAuthFlowError(
                f"no callback received within {timeout:.0f}s — the sign-in was not completed"
            ) from exc

    async def close(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None


async def exchange_code(
    client: httpx.AsyncClient,
    *,
    token_endpoint: str,
    code: str,
    code_verifier: str,
    client_id: str,
    redirect_uri: str,
    client_secret: str | None = None,
) -> TokenSet:
    """Trade the authorization code for tokens (RFC 6749 §4.1.3, RFC 7636 §4.5)."""
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": client_id,
        "code_verifier": code_verifier,
    }
    if client_secret:
        form["client_secret"] = client_secret

    try:
        response = await client.post(
            token_endpoint,
            data=form,
            headers={
                "content-type": "application/x-www-form-urlencoded",
                "accept": "application/json",
            },
            timeout=EXCHANGE_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as exc:
        raise OAuthFlowError(f"could not reach the token endpoint: {exc}") from exc

    if response.status_code >= 400:
        # Bodies here name the grant problem (invalid_grant, redirect_uri_mismatch...)
        # and contain no secret, so surfacing them is what makes this debuggable.
        raise OAuthFlowError(f"token endpoint returned {response.status_code}: {response.text[:300]}")

    try:
        payload = response.json()
    except ValueError as exc:
        raise OAuthFlowError("token endpoint did not return JSON") from exc
    if not isinstance(payload, dict) or not payload.get("access_token"):
        raise OAuthFlowError("token response contained no access_token")

    expires_in = payload.get("expires_in")
    return TokenSet(
        access_token=str(payload["access_token"]),
        refresh_token=payload.get("refresh_token") or None,
        expires_in=int(expires_in) if str(expires_in).isdigit() else None,
        scope=payload.get("scope"),
        token_type=str(payload.get("token_type") or "Bearer"),
        raw=payload,
    )
