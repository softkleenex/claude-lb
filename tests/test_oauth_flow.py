from __future__ import annotations

import asyncio
import base64
import hashlib
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from app.modules.accounts import oauth_flow

AUTHORIZE = "https://issuer.example.test/oauth/authorize"
TOKEN = "https://issuer.example.test/oauth/token"


def make_request(**kwargs) -> oauth_flow.AuthorizationRequest:
    defaults = dict(
        authorize_url=AUTHORIZE,
        client_id="client-abc",
        redirect_uri="http://127.0.0.1:9999/callback",
    )
    return oauth_flow.AuthorizationRequest(**{**defaults, **kwargs})


class TestPkce:
    def test_challenge_is_the_s256_of_the_verifier(self):
        verifier, challenge = oauth_flow.generate_pkce_pair()
        expected = (
            base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).decode().rstrip("=")
        )
        assert challenge == expected

    def test_pairs_are_unique_per_flow(self):
        pairs = {oauth_flow.generate_pkce_pair()[0] for _ in range(50)}
        assert len(pairs) == 50

    def test_verifier_is_url_safe_and_long_enough(self):
        # RFC 7636 §4.1 requires 43–128 characters from an unreserved alphabet.
        verifier, _ = oauth_flow.generate_pkce_pair()
        assert 43 <= len(verifier) <= 128
        assert "=" not in verifier and "+" not in verifier and "/" not in verifier


class TestAuthorizationUrl:
    def test_contains_the_required_parameters(self):
        request = make_request(scope="a b")
        params = parse_qs(urlparse(request.url()).query)

        assert params["response_type"] == ["code"]
        assert params["client_id"] == ["client-abc"]
        assert params["redirect_uri"] == ["http://127.0.0.1:9999/callback"]
        assert params["code_challenge_method"] == ["S256"]
        assert params["code_challenge"] == [request.code_challenge]
        assert params["state"] == [request.state]
        assert params["scope"] == ["a b"]

    def test_the_verifier_never_appears_in_the_url(self):
        """The whole point of S256 — with `plain`, anything that can read the URL
        can finish the exchange."""
        request = make_request()
        assert request.code_verifier not in request.url()

    def test_optional_parameters_are_omitted_when_unset(self):
        params = parse_qs(urlparse(make_request().url()).query)
        assert "scope" not in params
        assert "audience" not in params

    def test_audience_and_extra_params_are_passed_through(self):
        request = make_request(audience="https://api", extra_params={"prompt": "consent"})
        params = parse_qs(urlparse(request.url()).query)
        assert params["audience"] == ["https://api"]
        assert params["prompt"] == ["consent"]

    def test_an_authorize_url_with_an_existing_query_is_appended_to(self):
        request = make_request(authorize_url=f"{AUTHORIZE}?tenant=acme")
        params = parse_qs(urlparse(request.url()).query)
        assert params["tenant"] == ["acme"]
        assert params["response_type"] == ["code"]

    def test_state_is_unpredictable(self):
        assert len({make_request().state for _ in range(50)}) == 50


class TestCallbackParsing:
    def test_extracts_the_code(self):
        code = oauth_flow.parse_callback(
            "http://127.0.0.1:9999/callback?code=abc123&state=st", expected_state="st"
        )
        assert code == "abc123"

    def test_accepts_a_bare_query_string(self):
        # A human pasting from the address bar may give either form.
        assert oauth_flow.parse_callback("code=abc&state=st", expected_state="st") == "abc"

    def test_accepts_a_path_and_query_without_a_host(self):
        assert oauth_flow.parse_callback("/callback?code=abc&state=st", expected_state="st") == "abc"

    def test_a_mismatched_state_is_rejected(self):
        """Without this a forged redirect can graft an attacker's code onto the flow."""
        with pytest.raises(oauth_flow.OAuthFlowError, match="state parameter did not match"):
            oauth_flow.parse_callback("?code=abc&state=wrong", expected_state="right")

    def test_a_missing_state_is_rejected(self):
        with pytest.raises(oauth_flow.OAuthFlowError, match="state parameter did not match"):
            oauth_flow.parse_callback("?code=abc", expected_state="right")

    def test_an_empty_expected_state_still_requires_a_match(self):
        with pytest.raises(oauth_flow.OAuthFlowError):
            oauth_flow.parse_callback("?code=abc&state=something", expected_state="")

    def test_a_provider_error_is_surfaced(self):
        with pytest.raises(oauth_flow.OAuthFlowError, match="access_denied: user said no"):
            oauth_flow.parse_callback(
                "?error=access_denied&error_description=user+said+no", expected_state="st"
            )

    def test_an_error_is_reported_even_before_the_state_check(self):
        with pytest.raises(oauth_flow.OAuthFlowError, match="access_denied"):
            oauth_flow.parse_callback("?error=access_denied&state=wrong", expected_state="right")

    def test_a_callback_with_no_code_is_rejected(self):
        with pytest.raises(oauth_flow.OAuthFlowError, match="no authorization code"):
            oauth_flow.parse_callback("?state=st", expected_state="st")


class TestCallbackServer:
    async def test_receives_the_redirect_and_returns_a_page(self):
        server = oauth_flow.CallbackServer()
        await server.start()
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(f"http://127.0.0.1:{server.port}/callback?code=abc&state=st")
            target = await server.wait(timeout=5)
        finally:
            await server.close()

        assert response.status_code == 200
        assert b"Signed in" in response.content
        assert oauth_flow.parse_callback(target, expected_state="st") == "abc"

    async def test_binds_to_loopback_only(self):
        """Anything off-box must not be able to deliver a callback."""
        server = oauth_flow.CallbackServer()
        await server.start()
        try:
            host = server._server.sockets[0].getsockname()[0]
        finally:
            await server.close()
        assert host in ("127.0.0.1", "::1")

    async def test_a_request_without_parameters_does_not_complete_the_flow(self):
        # Browsers also fetch /favicon.ico against this listener.
        server = oauth_flow.CallbackServer()
        await server.start()
        try:
            async with httpx.AsyncClient() as client:
                await client.get(f"http://127.0.0.1:{server.port}/favicon.ico")
            with pytest.raises(oauth_flow.OAuthFlowError, match="no callback received"):
                await server.wait(timeout=0.3)
        finally:
            await server.close()

    async def test_waiting_times_out_cleanly(self):
        server = oauth_flow.CallbackServer()
        await server.start()
        try:
            with pytest.raises(oauth_flow.OAuthFlowError, match="was not completed"):
                await server.wait(timeout=0.2)
        finally:
            await server.close()

    async def test_the_first_callback_wins(self):
        server = oauth_flow.CallbackServer()
        await server.start()
        try:
            async with httpx.AsyncClient() as client:
                await client.get(f"http://127.0.0.1:{server.port}/callback?code=first&state=st")
                await client.get(f"http://127.0.0.1:{server.port}/callback?code=second&state=st")
            target = await server.wait(timeout=5)
        finally:
            await server.close()
        assert "code=first" in target

    async def test_a_fixed_port_is_honoured(self):
        # Some providers only allow a pre-registered redirect URI.
        server = oauth_flow.CallbackServer(port=8765)
        await server.start()
        try:
            assert server.port == 8765
        finally:
            await server.close()

    async def test_close_is_safe_to_call_twice(self):
        server = oauth_flow.CallbackServer()
        await server.start()
        await server.close()
        await server.close()


class TestCodeExchange:
    def _handler(self, calls: list[httpx.Request], response: httpx.Response):
        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return response

        return handler

    async def test_sends_an_rfc7636_shaped_grant(self):
        calls: list[httpx.Request] = []
        response = httpx.Response(200, json={"access_token": "at", "refresh_token": "rt", "expires_in": 3600})
        async with httpx.AsyncClient(transport=httpx.MockTransport(self._handler(calls, response))) as c:
            tokens = await oauth_flow.exchange_code(
                c,
                token_endpoint=TOKEN,
                code="the-code",
                code_verifier="the-verifier",
                client_id="client-abc",
                redirect_uri="http://127.0.0.1:9999/callback",
            )

        body = calls[0].content.decode()
        assert "grant_type=authorization_code" in body
        assert "code=the-code" in body
        assert "code_verifier=the-verifier" in body
        assert "client_id=client-abc" in body
        assert calls[0].headers["content-type"] == "application/x-www-form-urlencoded"

        assert tokens.access_token == "at"
        assert tokens.refresh_token == "rt"
        assert tokens.expires_in == 3600

    async def test_a_client_secret_is_included_only_when_supplied(self):
        calls: list[httpx.Request] = []
        response = httpx.Response(200, json={"access_token": "at"})
        async with httpx.AsyncClient(transport=httpx.MockTransport(self._handler(calls, response))) as c:
            await oauth_flow.exchange_code(
                c,
                token_endpoint=TOKEN,
                code="c",
                code_verifier="v",
                client_id="id",
                redirect_uri="r",
            )
            await oauth_flow.exchange_code(
                c,
                token_endpoint=TOKEN,
                code="c",
                code_verifier="v",
                client_id="id",
                redirect_uri="r",
                client_secret="shh",
            )
        assert "client_secret" not in calls[0].content.decode()
        assert "client_secret=shh" in calls[1].content.decode()

    async def test_a_public_client_flow_works_without_a_refresh_token(self):
        response = httpx.Response(200, json={"access_token": "at"})
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: response)) as c:
            tokens = await oauth_flow.exchange_code(
                c, token_endpoint=TOKEN, code="c", code_verifier="v", client_id="id", redirect_uri="r"
            )
        assert tokens.refresh_token is None
        assert tokens.expires_in is None

    async def test_a_grant_error_is_surfaced_with_the_providers_reason(self):
        response = httpx.Response(400, json={"error": "invalid_grant"})
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: response)) as c:
            with pytest.raises(oauth_flow.OAuthFlowError, match="invalid_grant"):
                await oauth_flow.exchange_code(
                    c, token_endpoint=TOKEN, code="c", code_verifier="v", client_id="id", redirect_uri="r"
                )

    async def test_a_non_json_response_is_reported_clearly(self):
        response = httpx.Response(200, content=b"<html>oops</html>")
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: response)) as c:
            with pytest.raises(oauth_flow.OAuthFlowError, match="did not return JSON"):
                await oauth_flow.exchange_code(
                    c, token_endpoint=TOKEN, code="c", code_verifier="v", client_id="id", redirect_uri="r"
                )

    async def test_a_response_without_an_access_token_is_rejected(self):
        response = httpx.Response(200, json={"token_type": "Bearer"})
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: response)) as c:
            with pytest.raises(oauth_flow.OAuthFlowError, match="no access_token"):
                await oauth_flow.exchange_code(
                    c, token_endpoint=TOKEN, code="c", code_verifier="v", client_id="id", redirect_uri="r"
                )

    async def test_a_transport_error_is_wrapped(self):
        def boom(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("no route")

        async with httpx.AsyncClient(transport=httpx.MockTransport(boom)) as c:
            with pytest.raises(oauth_flow.OAuthFlowError, match="could not reach the token endpoint"):
                await oauth_flow.exchange_code(
                    c, token_endpoint=TOKEN, code="c", code_verifier="v", client_id="id", redirect_uri="r"
                )


class TestEndToEndFlow:
    async def test_authorize_redirect_and_exchange(self):
        """Drives the whole flow the way the CLI does, with a stand-in browser."""
        server = oauth_flow.CallbackServer()
        await server.start()
        request = oauth_flow.AuthorizationRequest(
            authorize_url=AUTHORIZE,
            client_id="client-abc",
            redirect_uri=f"http://127.0.0.1:{server.port}/callback",
            scope="user:inference",
        )

        seen: dict[str, str] = {}

        async def browser() -> None:
            """Reads the authorize URL, then redirects to the callback like a provider."""
            params = parse_qs(urlparse(request.url()).query)
            seen.update(
                challenge=params["code_challenge"][0],
                state=params["state"][0],
                redirect=params["redirect_uri"][0],
            )
            async with httpx.AsyncClient() as client:
                await client.get(f"{seen['redirect']}?code=granted&state={seen['state']}")

        _, target = await asyncio.gather(browser(), server.wait(timeout=5))
        await server.close()

        code = oauth_flow.parse_callback(target, expected_state=request.state)
        assert code == "granted"

        calls: list[httpx.Request] = []

        def token_handler(req: httpx.Request) -> httpx.Response:
            calls.append(req)
            form = dict(p.split("=", 1) for p in req.content.decode().split("&"))
            # The provider verifies S256(verifier) == the challenge it stored.
            digest = hashlib.sha256(form["code_verifier"].encode()).digest()
            recomputed = base64.urlsafe_b64encode(digest).decode().rstrip("=")
            if recomputed != seen["challenge"]:
                return httpx.Response(400, json={"error": "invalid_grant"})
            return httpx.Response(200, json={"access_token": "at-final", "expires_in": 3600})

        async with httpx.AsyncClient(transport=httpx.MockTransport(token_handler)) as client:
            tokens = await oauth_flow.exchange_code(
                client,
                token_endpoint=TOKEN,
                code=code,
                code_verifier=request.code_verifier,
                client_id="client-abc",
                redirect_uri=seen["redirect"],
            )

        assert tokens.access_token == "at-final", "the PKCE verifier must satisfy the challenge"


class TestCliUrlRendering:
    def test_the_authorize_url_is_printed_unwrapped(self):
        """A URL folded at the terminal width is broken the moment it is copied."""
        import io

        from rich.console import Console

        request = make_request(scope="user:inference profile", audience="https://api.example.test")
        buffer = io.StringIO()
        # Deliberately narrower than the URL.
        Console(file=buffer, width=40, no_color=True).print(request.url(), soft_wrap=True)

        printed = buffer.getvalue().strip()
        assert "\n" not in printed, "the URL must occupy a single line"
        assert printed == request.url()
