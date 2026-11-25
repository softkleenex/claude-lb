from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated

import httpx
import typer
from rich.console import Console
from rich.table import Table
from sqlalchemy import select

from claude_lb.core.config import get_settings
from claude_lb.core.crypto import encrypt, mask_secret
from claude_lb.db.models import Account
from claude_lb.db.session import dispose_db, init_db, session_scope
from claude_lb.modules.accounts import credentials, importer, oauth_flow, subscription_login
from claude_lb.modules.api_keys.service import create_api_key
from claude_lb.modules.proxy import model_blocks
from claude_lb.modules.proxy.load_balancer import STRATEGIES, headroom, is_available, spend_cap_reached
from claude_lb.modules.proxy.quota import (
    PLAN_TYPES,
    ROUTING_POLICIES,
    apply_unified_quota,
    effective_primary_used,
    effective_secondary_used,
)

app = typer.Typer(help="Anthropic API key load balancer & proxy.", no_args_is_help=True)
account_app = typer.Typer(help="Manage upstream Anthropic accounts.", no_args_is_help=True)


def _print_version(value: bool) -> None:
    if value:
        from claude_lb import __version__

        print(f"claude-lb {__version__}")
        raise typer.Exit()


@app.callback()
def _main(
    version: bool = typer.Option(
        False, "--version", "-V", callback=_print_version, is_eager=True, help="Show the version and exit."
    ),
) -> None:
    """Anthropic API key load balancer & proxy."""


key_app = typer.Typer(help="Manage locally issued proxy API keys.", no_args_is_help=True)
app.add_typer(account_app, name="account")
app.add_typer(key_app, name="key")

console = Console()


def _parse_headers(items: list[str] | None) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for item in items or []:
        if "=" not in item:
            console.print(f"[red]--header must be key=value, got {item!r}.[/red]")
            raise typer.Exit(1)
        key, value = item.split("=", 1)
        parsed[key.strip()] = value.strip()
    return parsed


def _open_browser(url: str) -> None:
    """Best effort: a headless box just leaves the printed URL for the operator."""
    import webbrowser

    try:
        webbrowser.open(url)
    except Exception:  # pragma: no cover - platform dependent
        pass


def _run(coro):
    async def _wrapped():
        await init_db()
        try:
            return await coro
        finally:
            await dispose_db()

    return asyncio.run(_wrapped())


@app.command()
def serve(
    host: Annotated[str | None, typer.Option(help="Bind address.")] = None,
    port: Annotated[int | None, typer.Option(help="Bind port.")] = None,
    reload: Annotated[bool, typer.Option(help="Auto-reload on code changes.")] = False,
) -> None:
    """Start the proxy and dashboard."""
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "claude_lb.main:app",
        host=host or settings.host,
        port=port or settings.port,
        reload=reload,
        log_level=settings.log_level.lower(),
    )


@app.command()
def demo(
    port: Annotated[int, typer.Option(help="Port for the demo server.")] = 2457,
    host: Annotated[
        str | None, typer.Option(help="Bind address (default 127.0.0.1; 0.0.0.0 inside Docker).")
    ] = None,
    traffic: Annotated[bool, typer.Option(help="Send simulated requests continuously.")] = True,
    open_browser: Annotated[bool, typer.Option("--open/--no-open", help="Open the dashboard.")] = True,
) -> None:
    """Try claude-lb with no API key: a simulated upstream and live synthetic traffic.

    Runs on a throwaway data directory, so it never touches a real instance, and no
    request leaves this machine.
    """
    from claude_lb import demo as demo_mode

    host = host or demo_mode.default_host()
    data_dir = demo_mode.prepare_environment(port, host)
    url = f"http://127.0.0.1:{port}"

    def ready(keys: list[str]) -> None:
        console.print(f"\n[bold green]claude-lb demo[/bold green] running at [bold]{url}[/bold]")
        console.print("  Upstream is simulated, so no request leaves this machine.")
        if not demo_mode.is_loopback_bind(host):
            console.print(f"  Bound to {host}: dashboard auth is off (demo data only).")
        console.print(f"  Data: {data_dir} (throwaway)", soft_wrap=True)
        console.print(
            "  Watch [green]Saved by prompt cache[/green] grow as sticky routing keeps caches warm."
        )
        console.print(
            f"\n  Point a client at it: base URL {url}, API key [bold]{keys[0]}[/bold]", soft_wrap=True
        )
        console.print("\n[dim]Ctrl+C to stop.[/dim]")
        if open_browser:
            _open_browser(url)

    try:
        asyncio.run(demo_mode.run(port, traffic=traffic, on_ready=ready, host=host))
    except KeyboardInterrupt:
        pass


setup_app = typer.Typer(help="Connect a client to claude-lb.", no_args_is_help=True)
app.add_typer(setup_app, name="setup")


@setup_app.command("claude-code")
def setup_claude_code(
    name: Annotated[str, typer.Option(help="Name for the key this creates.")] = "claude-code",
    base_url: Annotated[str | None, typer.Option(help="URL clients reach claude-lb on.")] = None,
    max_cost: Annotated[float | None, typer.Option(help="USD budget per window for this key.")] = None,
    window: Annotated[int, typer.Option(help="Budget window in seconds.")] = 3600,
) -> None:
    """Issue a key for Claude Code and print the settings that route it through claude-lb."""
    settings = get_settings()
    host = "127.0.0.1" if settings.host in ("0.0.0.0", "::") else settings.host
    url = (base_url or f"http://{host}:{settings.port}").rstrip("/")

    async def _create() -> str:
        from claude_lb.db.models import ApiKey

        async with session_scope() as session:
            existing = await session.execute(select(ApiKey).where(ApiKey.name == name))
            if existing.scalar_one_or_none() is not None:
                console.print(
                    f"[red]A key named {name!r} already exists.[/red] Pass --name to issue another."
                )
                raise typer.Exit(1)
            issued = await create_api_key(
                session, name=name, max_cost_usd_per_window=max_cost, window_seconds=window
            )
            return issued.plaintext

    key = _run(_create())
    env = {"ANTHROPIC_BASE_URL": url, "ANTHROPIC_API_KEY": key}

    console.print(f"[green]Issued key[/green] {name} — shown once, copy it now.\n")
    console.print("[bold]Shell[/bold] (current session):")
    for k, v in env.items():
        print(f"  export {k}={v}")
    console.print("\n[bold]Or[/bold] add to [bold]~/.claude/settings.json[/bold] (every session):")
    print(json.dumps({"env": env}, indent=2))
    console.print(
        "\nThen run [bold]claude[/bold]. Each response names the account that served it in the "
        "x-claude-lb-account header, and spend for this key shows under Cost reports → API key."
    )


@app.command()
def config() -> None:
    """Show the resolved configuration."""
    settings = get_settings()
    table = Table(show_header=False, box=None)
    for field in (
        "host",
        "port",
        "data_dir",
        "upstream_base_url",
        "routing_strategy",
        "max_attempts",
        "require_api_key",
        "request_log_retention_days",
    ):
        table.add_row(f"[dim]{field}[/dim]", str(getattr(settings, field)))
    table.add_row("[dim]database[/dim]", settings.resolved_database_url)
    table.add_row("[dim]strategies[/dim]", ", ".join(STRATEGIES))
    console.print(table)


@account_app.command("add")
def account_add(
    name: Annotated[str, typer.Argument(help="Label for this account.")],
    api_key: Annotated[str, typer.Option(prompt=True, hide_input=True, help="Anthropic API key.")],
    weight: Annotated[float, typer.Option(help="Relative share under weighted routing.")] = 1.0,
    priority: Annotated[int, typer.Option(help="Higher drains first under fill_first.")] = 0,
    plan_type: Annotated[str, typer.Option(help=f"Plan tier ({', '.join(PLAN_TYPES)}).")] = "api",
    routing_policy: Annotated[
        str, typer.Option(help=f"Routing policy ({', '.join(ROUTING_POLICIES)}).")
    ] = "normal",
    base_url: Annotated[str | None, typer.Option(help="Override the upstream base URL.")] = None,
    spend_cap_usd: Annotated[
        float | None,
        typer.Option(help="Stop routing here once estimated spend reaches this many USD."),
    ] = None,
) -> None:
    """Add an upstream account."""
    if plan_type not in PLAN_TYPES:
        console.print(f"[red]--plan-type must be one of {', '.join(PLAN_TYPES)}.[/red]")
        raise typer.Exit(1)
    if routing_policy not in ROUTING_POLICIES:
        console.print(f"[red]--routing-policy must be one of {', '.join(ROUTING_POLICIES)}.[/red]")
        raise typer.Exit(1)

    async def _add() -> None:
        async with session_scope() as session:
            existing = await session.execute(select(Account).where(Account.name == name))
            if existing.scalar_one_or_none() is not None:
                console.print(f"[red]An account named {name!r} already exists.[/red]")
                raise typer.Exit(1)
            session.add(
                Account(
                    name=name,
                    encrypted_credential=encrypt(api_key),
                    credential_hint=mask_secret(api_key),
                    weight=weight,
                    priority=priority,
                    plan_type=plan_type,
                    routing_policy=routing_policy,
                    base_url=base_url,
                    spend_cap_usd=spend_cap_usd,
                )
            )
        console.print(f"[green]Added account[/green] {name} ({mask_secret(api_key)})")

    _run(_add())


@account_app.command("add-oauth")
def account_add_oauth(
    name: Annotated[str, typer.Argument(help="Label for this account.")],
    access_token: Annotated[str, typer.Option(prompt=True, hide_input=True, help="Current access token.")],
    token_endpoint: Annotated[str | None, typer.Option(help="Where to POST the refresh_token grant.")] = None,
    refresh_token: Annotated[str | None, typer.Option(help="Refresh token, if you have one.")] = None,
    client_id: Annotated[str | None, typer.Option(help="OAuth client id.")] = None,
    client_secret: Annotated[str | None, typer.Option(help="OAuth client secret, if required.")] = None,
    scope: Annotated[str | None, typer.Option(help="Scope to request on refresh.")] = None,
    expires_in: Annotated[int | None, typer.Option(help="Lifetime of the access token, in seconds.")] = None,
    header: Annotated[
        list[str] | None,
        typer.Option(help="Extra header as key=value. Repeatable."),
    ] = None,
    auth_scheme: Annotated[str, typer.Option(help="bearer or x-api-key.")] = "bearer",
    plan_type: Annotated[
        str, typer.Option(help=f"Subscription plan tier ({', '.join(PLAN_TYPES)}).")
    ] = "pro",
    routing_policy: Annotated[
        str, typer.Option(help=f"Routing policy ({', '.join(ROUTING_POLICIES)}).")
    ] = "normal",
    base_url: Annotated[str | None, typer.Option(help="Override the upstream base URL.")] = None,
    weight: Annotated[float, typer.Option(help="Relative share under weighted routing.")] = 1.0,
    priority: Annotated[int, typer.Option(help="Higher drains first under fill_first.")] = 0,
) -> None:
    """Add an account that authenticates with a bearer token you supply.

    claude-lb hardcodes no OAuth client constants. You provide the token endpoint,
    client id, and refresh token; it stores them encrypted and runs the standard
    refresh_token grant before the access token expires.
    """
    if refresh_token and not token_endpoint:
        console.print("[red]--token-endpoint is required when you supply a refresh token.[/red]")
        raise typer.Exit(1)
    if auth_scheme not in credentials.AUTH_SCHEMES:
        console.print(f"[red]--auth-scheme must be one of {', '.join(credentials.AUTH_SCHEMES)}.[/red]")
        raise typer.Exit(1)
    if plan_type not in PLAN_TYPES:
        console.print(f"[red]--plan-type must be one of {', '.join(PLAN_TYPES)}.[/red]")
        raise typer.Exit(1)
    if routing_policy not in ROUTING_POLICIES:
        console.print(f"[red]--routing-policy must be one of {', '.join(ROUTING_POLICIES)}.[/red]")
        raise typer.Exit(1)

    extra = _parse_headers(header)

    async def _add() -> None:
        async with session_scope() as session:
            existing = await session.execute(select(Account).where(Account.name == name))
            if existing.scalar_one_or_none() is not None:
                console.print(f"[red]An account named {name!r} already exists.[/red]")
                raise typer.Exit(1)
            session.add(
                Account(
                    name=name,
                    provider=credentials.PROVIDER_OAUTH,
                    encrypted_credential=encrypt(access_token),
                    credential_hint=mask_secret(access_token),
                    auth_scheme=auth_scheme,
                    extra_headers_json=json.dumps(extra),
                    base_url=base_url,
                    weight=weight,
                    priority=priority,
                    plan_type=plan_type,
                    routing_policy=routing_policy,
                    oauth_refresh_token_encrypted=encrypt(refresh_token) if refresh_token else None,
                    oauth_token_endpoint=token_endpoint,
                    oauth_client_id=client_id,
                    oauth_client_secret_encrypted=encrypt(client_secret) if client_secret else None,
                    oauth_scope=scope,
                    credential_lifetime_seconds=expires_in,
                    credential_expires_at=(
                        datetime.now(UTC) + timedelta(seconds=expires_in) if expires_in else None
                    ),
                )
            )
        console.print(f"[green]Added OAuth account[/green] {name} ({mask_secret(access_token)})")
        if not refresh_token:
            console.print(
                "[yellow]No refresh token supplied — this account stops working when the "
                "access token expires.[/yellow]"
            )

    _run(_add())


@account_app.command("add-subscription")
def account_add_subscription(
    name: Annotated[str, typer.Argument(help="Label for this account, e.g. the person's name.")],
    plan_type: Annotated[str, typer.Option(help=f"Subscription plan ({', '.join(PLAN_TYPES)}).")] = "pro",
    routing_policy: Annotated[
        str, typer.Option(help=f"Routing policy ({', '.join(ROUTING_POLICIES)}).")
    ] = "normal",
    verify: Annotated[bool, typer.Option(help="Send one tiny request to confirm the token works.")] = True,
) -> None:
    """Log in to a Claude subscription in the browser and add it to the pool.

    Runs Claude Code's own `claude setup-token` in a throwaway config directory, so
    your current Claude Code login and running sessions are not affected.
    """
    if plan_type not in PLAN_TYPES:
        console.print(f"[red]--plan-type must be one of {', '.join(PLAN_TYPES)}.[/red]")
        raise typer.Exit(1)
    if routing_policy not in ROUTING_POLICIES:
        console.print(f"[red]--routing-policy must be one of {', '.join(ROUTING_POLICIES)}.[/red]")
        raise typer.Exit(1)
    claude_path = subscription_login.claude_cli()
    if claude_path is None:
        console.print(
            "[red]Claude Code is not installed.[/red] Install it first: "
            "npm install -g @anthropic-ai/claude-code"
        )
        raise typer.Exit(1)

    async def _name_taken() -> bool:
        async with session_scope() as session:
            existing = await session.execute(select(Account).where(Account.name == name))
            return existing.scalar_one_or_none() is not None

    if _run(_name_taken()):
        console.print(f"[red]An account named {name!r} already exists.[/red]")
        raise typer.Exit(1)

    console.print(
        f"\n[bold]Adding subscription account {name!r}[/bold]\n"
        "  1. A browser window opens. Log in with the Claude account you want to add.\n"
        "  2. If the terminal asks for a code, paste the one the browser shows.\n"
        "  [dim]Your current Claude Code login and running sessions are not touched.[/dim]\n"
    )
    try:
        output = subscription_login.run_setup_token(claude_path)
    except subscription_login.SubscriptionLoginError as exc:
        console.print(f"[red]{exc}.[/red] Nothing was added.")
        raise typer.Exit(1) from exc

    candidates = subscription_login.token_candidates(output)

    async def _verify(tokens: list[str]) -> tuple[str | None, subscription_login.VerifyResult | None]:
        base_url = get_settings().upstream_base_url
        last = None
        async with httpx.AsyncClient() as client:
            for token in tokens:
                last = await subscription_login.verify_token(client, base_url, token)
                if last.ok:
                    return token, last
        return None, last

    token: str | None = None
    result: subscription_login.VerifyResult | None = None
    if verify and candidates:
        token, result = asyncio.run(_verify(candidates))
    elif candidates:
        token = candidates[0]
    if token is None:
        console.print("[yellow]Could not read the token from the output automatically.[/yellow]")
        token = typer.prompt("Paste the token that starts with sk-ant-oat", hide_input=True).strip()
        if verify:
            token_ok, result = asyncio.run(_verify([token]))
            if token_ok is None:
                detail = f" ({result.status_code}: {result.detail})" if result else ""
                console.print(f"[red]That token did not work{detail}.[/red] Nothing was added.")
                raise typer.Exit(1)

    async def _add() -> Account:
        async with session_scope() as session:
            account = Account(
                name=name,
                provider=credentials.PROVIDER_OAUTH,
                encrypted_credential=encrypt(token),
                credential_hint=mask_secret(token),
                auth_scheme="bearer",
                plan_type=plan_type,
                routing_policy=routing_policy,
            )
            if result is not None and result.ok:
                apply_unified_quota(account, result.headers)
            session.add(account)
            await session.flush()
            session.expunge(account)
            return account

    account = _run(_add())
    pri = effective_primary_used(account)
    sec = effective_secondary_used(account)
    console.print(
        f"\n[green]Added[/green] {name} ({mask_secret(token)}) · plan {plan_type} · {routing_policy}"
    )
    if pri is not None or sec is not None:
        pri_str = f"{pri:.0f}%" if pri is not None else "-"
        sec_str = f"{sec:.0f}%" if sec is not None else "-"
        console.print(f"  Quota right now: 5h {pri_str} used · 7d {sec_str} used")
    if plan_type == "pro":
        console.print("  [dim]Max plan? Fix the label with --plan-type max_5x or max_20x when adding.[/dim]")
    console.print(
        "  [dim]Note: through claude-lb a subscription may only serve some models (e.g. Haiku). "
        "Requests for models it refuses go to your other accounts automatically.[/dim]"
    )


@account_app.command("login")
def account_login(
    name: Annotated[str, typer.Argument(help="Label for this account.")],
    authorize_url: Annotated[str, typer.Option(help="The provider's authorization endpoint.")],
    token_endpoint: Annotated[str, typer.Option(help="The provider's token endpoint.")],
    client_id: Annotated[str, typer.Option(help="OAuth client id.")],
    scope: Annotated[str | None, typer.Option(help="Space-separated scopes to request.")] = None,
    audience: Annotated[
        str | None, typer.Option(help="Audience parameter, if the provider wants one.")
    ] = None,
    client_secret: Annotated[
        str | None, typer.Option(help="Client secret, for confidential clients.")
    ] = None,
    redirect_port: Annotated[
        int, typer.Option(help="Loopback port for the redirect. 0 picks a free one.")
    ] = 0,
    redirect_path: Annotated[str, typer.Option(help="Path the provider redirects to.")] = "/callback",
    manual: Annotated[
        bool,
        typer.Option(help="Print the URL and paste the redirect back, for a headless host."),
    ] = False,
    redirect_uri: Annotated[
        str | None,
        typer.Option(help="Override the redirect URI. Required with --manual if the provider pins one."),
    ] = None,
    timeout: Annotated[float, typer.Option(help="Seconds to wait for the callback.")] = 300.0,
    header: Annotated[list[str] | None, typer.Option(help="Extra header as key=value. Repeatable.")] = None,
    base_url: Annotated[str | None, typer.Option(help="Override the upstream base URL.")] = None,
    weight: Annotated[float, typer.Option(help="Relative share under weighted routing.")] = 1.0,
    priority: Annotated[int, typer.Option(help="Higher drains first under fill_first.")] = 0,
) -> None:
    """Add an account by signing in through a browser (Authorization Code + PKCE).

    claude-lb hardcodes no provider constants: you supply the authorize URL, token
    endpoint, and client id. The redirect lands on a loopback listener owned by this
    process; on a headless host use --manual and paste the redirected URL back.
    """
    extra = _parse_headers(header)

    async def _login() -> None:
        async with session_scope() as session:
            existing = await session.execute(select(Account).where(Account.name == name))
            if existing.scalar_one_or_none() is not None:
                console.print(f"[red]An account named {name!r} already exists.[/red]")
                raise typer.Exit(1)

        server: oauth_flow.CallbackServer | None = None
        if manual:
            if not redirect_uri:
                console.print(
                    "[red]--redirect-uri is required with --manual[/red] "
                    "(use whatever the provider has registered for this client)."
                )
                raise typer.Exit(1)
            effective_redirect = redirect_uri
        else:
            server = oauth_flow.CallbackServer(port=redirect_port)
            await server.start()
            effective_redirect = redirect_uri or f"http://127.0.0.1:{server.port}{redirect_path}"

        request = oauth_flow.AuthorizationRequest(
            authorize_url=authorize_url,
            client_id=client_id,
            redirect_uri=effective_redirect,
            scope=scope,
            audience=audience,
        )

        try:
            console.print("\nOpen this URL to sign in:\n")
            # soft_wrap: Rich would otherwise fold the URL at the terminal width, and a
            # line-wrapped authorize URL is broken the moment anyone copies it.
            console.print(request.url(), style="cyan", soft_wrap=True)
            console.print()

            if manual:
                pasted = typer.prompt("Paste the full URL you were redirected to")
                code = oauth_flow.parse_callback(pasted, expected_state=request.state)
            else:
                console.print(f"[dim]Listening on {effective_redirect} …[/dim]")
                _open_browser(request.url())
                target = await server.wait(timeout)
                code = oauth_flow.parse_callback(target, expected_state=request.state)

            async with httpx.AsyncClient() as client:
                tokens = await oauth_flow.exchange_code(
                    client,
                    token_endpoint=token_endpoint,
                    code=code,
                    code_verifier=request.code_verifier,
                    client_id=client_id,
                    redirect_uri=effective_redirect,
                    client_secret=client_secret,
                )
        except oauth_flow.OAuthFlowError as exc:
            console.print(f"[red]Sign-in failed:[/red] {exc}")
            raise typer.Exit(1) from exc
        finally:
            if server is not None:
                await server.close()

        async with session_scope() as session:
            session.add(
                Account(
                    name=name,
                    provider=credentials.PROVIDER_OAUTH,
                    encrypted_credential=encrypt(tokens.access_token),
                    credential_hint=mask_secret(tokens.access_token),
                    auth_scheme="bearer",
                    extra_headers_json=json.dumps(extra),
                    base_url=base_url,
                    weight=weight,
                    priority=priority,
                    oauth_refresh_token_encrypted=(
                        encrypt(tokens.refresh_token) if tokens.refresh_token else None
                    ),
                    oauth_token_endpoint=token_endpoint,
                    oauth_client_id=client_id,
                    oauth_client_secret_encrypted=encrypt(client_secret) if client_secret else None,
                    oauth_scope=tokens.scope or scope,
                    credential_lifetime_seconds=tokens.expires_in,
                    credential_expires_at=(
                        datetime.now(UTC) + timedelta(seconds=tokens.expires_in)
                        if tokens.expires_in
                        else None
                    ),
                )
            )

        console.print(
            f"\n[green]Signed in.[/green] Added account {name} ({mask_secret(tokens.access_token)})"
        )
        if tokens.refresh_token:
            console.print(
                f"[dim]Token expires in {tokens.expires_in or 'an unspecified time'}s; "
                "claude-lb will refresh it automatically.[/dim]"
            )
        else:
            console.print(
                "[yellow]The provider returned no refresh token — this account stops "
                "working when the access token expires.[/yellow]"
            )

    _run(_login())


@account_app.command("import")
def account_import(
    name: Annotated[str, typer.Argument(help="Label for this account.")],
    file: Annotated[
        Path,
        typer.Option(help="Path to a credentials JSON file (e.g. ~/.claude/.credentials.json)."),
    ],
    plan_type: Annotated[
        str | None, typer.Option(help=f"Override plan tier ({', '.join(PLAN_TYPES)}).")
    ] = None,
    routing_policy: Annotated[
        str, typer.Option(help=f"Routing policy ({', '.join(ROUTING_POLICIES)}).")
    ] = "normal",
    token_endpoint: Annotated[str | None, typer.Option(help="Override OAuth token endpoint.")] = None,
    client_id: Annotated[str | None, typer.Option(help="Override OAuth client id.")] = None,
    base_url: Annotated[str | None, typer.Option(help="Override the upstream base URL.")] = None,
    weight: Annotated[float, typer.Option(help="Relative share under weighted routing.")] = 1.0,
    priority: Annotated[int, typer.Option(help="Higher drains first under fill_first.")] = 0,
) -> None:
    """Import an OAuth/subscription account from a local JSON credential file."""
    if plan_type is not None and plan_type not in PLAN_TYPES:
        console.print(f"[red]--plan-type must be one of {', '.join(PLAN_TYPES)}.[/red]")
        raise typer.Exit(1)
    if routing_policy not in ROUTING_POLICIES:
        console.print(f"[red]--routing-policy must be one of {', '.join(ROUTING_POLICIES)}.[/red]")
        raise typer.Exit(1)
    if not file.exists():
        console.print(f"[red]Credential file not found:[/red] {file}")
        raise typer.Exit(1)
    try:
        raw = json.loads(file.read_text(encoding="utf-8"))
        parsed = importer.parse_credential_bundle(raw)
    except (ValueError, OSError) as exc:
        console.print(f"[red]Could not parse credential file:[/red] {exc}")
        raise typer.Exit(1) from exc

    resolved_plan = plan_type or parsed.plan_type

    async def _import() -> None:
        async with session_scope() as session:
            existing = await session.execute(select(Account).where(Account.name == name))
            if existing.scalar_one_or_none() is not None:
                console.print(f"[red]An account named {name!r} already exists.[/red]")
                raise typer.Exit(1)
            session.add(
                Account(
                    name=name,
                    provider=credentials.PROVIDER_OAUTH,
                    encrypted_credential=encrypt(parsed.access_token),
                    credential_hint=mask_secret(parsed.access_token),
                    auth_scheme="bearer",
                    extra_headers_json=json.dumps(parsed.extra_headers),
                    base_url=base_url or parsed.base_url,
                    weight=weight,
                    priority=priority,
                    plan_type=resolved_plan,
                    routing_policy=routing_policy,
                    oauth_refresh_token_encrypted=(
                        encrypt(parsed.refresh_token) if parsed.refresh_token else None
                    ),
                    oauth_token_endpoint=token_endpoint or parsed.token_endpoint,
                    oauth_client_id=client_id or parsed.client_id,
                    oauth_client_secret_encrypted=(
                        encrypt(parsed.client_secret) if parsed.client_secret else None
                    ),
                    oauth_scope=parsed.scope,
                    credential_lifetime_seconds=parsed.lifetime_seconds,
                    credential_expires_at=parsed.expires_at,
                )
            )
        console.print(
            f"[green]Imported subscription account[/green] {name} "
            f"(plan={resolved_plan}, policy={routing_policy}, {mask_secret(parsed.access_token)})"
        )

    _run(_import())


@account_app.command("list")
def account_list() -> None:
    """List upstream accounts."""

    async def _list() -> None:
        async with session_scope() as session:
            result = await session.execute(select(Account).order_by(Account.name))
            accounts = list(result.scalars())

        if not accounts:
            console.print("[dim]No accounts yet. Add one with:[/dim] claude-lb account add <name>")
            return

        table = Table(title="Accounts")
        for column in ("Name", "Plan", "Policy", "Status", "5h / 7d", "Headroom", "Requests", "Cost"):
            table.add_column(column, justify="right" if column in ("Requests", "Cost") else "left")
        for account in accounts:
            if is_available(account):
                status = "[green]available[/green]"
            elif account.enabled and spend_cap_reached(account):
                status = "[yellow]spend cap[/yellow]"
            elif account.enabled:
                status = f"[yellow]{account.quota_status}[/yellow]"
            else:
                status = "[red]disabled[/red]"
            pri = effective_primary_used(account)
            sec = effective_secondary_used(account)
            pri_str = f"{pri:.0f}%" if pri is not None else "-"
            sec_str = f"{sec:.0f}%" if sec is not None else "-"
            quota_str = "-" if pri is None and sec is None else f"{pri_str} / {sec_str}"
            table.add_row(
                account.name,
                account.plan_type,
                account.routing_policy,
                status,
                quota_str,
                f"{headroom(account) * 100:.0f}%",
                str(account.total_requests),
                f"${account.total_cost_usd:.4f}"
                + (f" / ${account.spend_cap_usd:.2f}" if account.spend_cap_usd is not None else ""),
            )
        console.print(table)
        for account in accounts:
            blocked = model_blocks.active_blocks(account)
            if blocked:
                console.print(
                    f"[dim]{account.name}: refuses {', '.join(blocked)} — "
                    "those requests go to other accounts.[/dim]"
                )

    _run(_list())


@account_app.command("set-spend-cap")
def account_set_spend_cap(
    name: Annotated[str, typer.Argument(help="Account name.")],
    usd: Annotated[float | None, typer.Argument(help="Cap in USD. Omit to remove the cap.")] = None,
) -> None:
    """Cap how much an account may spend before traffic moves to the rest of the pool."""
    if usd is not None and usd < 0:
        console.print("[red]The cap cannot be negative.[/red]")
        raise typer.Exit(1)

    async def _set() -> None:
        async with session_scope() as session:
            result = await session.execute(select(Account).where(Account.name == name))
            account = result.scalar_one_or_none()
            if account is None:
                console.print(f"[red]No account named {name!r}.[/red]")
                raise typer.Exit(1)
            account.spend_cap_usd = usd
            spent = account.total_cost_usd
        if usd is None:
            console.print(f"[green]Removed spend cap[/green] on {name}")
        else:
            console.print(f"[green]Spend cap set[/green] on {name}: ${spent:.4f} spent of ${usd:.2f}")

    _run(_set())


@account_app.command("remove")
def account_remove(name: Annotated[str, typer.Argument(help="Account name.")]) -> None:
    """Remove an upstream account. Request history is kept."""

    async def _remove() -> None:
        async with session_scope() as session:
            result = await session.execute(select(Account).where(Account.name == name))
            account = result.scalar_one_or_none()
            if account is None:
                console.print(f"[red]No account named {name!r}.[/red]")
                raise typer.Exit(1)
            await session.delete(account)
        console.print(f"[green]Removed[/green] {name}")

    _run(_remove())


@key_app.command("create")
def key_create(
    name: Annotated[str, typer.Argument(help="Label for this key.")],
    max_cost: Annotated[float | None, typer.Option(help="USD budget per window.")] = None,
    window: Annotated[int, typer.Option(help="Budget window in seconds.")] = 3600,
) -> None:
    """Issue a proxy API key. The key is printed once and only its hash is stored."""

    async def _create() -> None:
        async with session_scope() as session:
            issued = await create_api_key(
                session, name=name, max_cost_usd_per_window=max_cost, window_seconds=window
            )
            plaintext = issued.plaintext
        console.print(f"[green]Created key[/green] {name}")
        console.print(f"\n  [bold]{plaintext}[/bold]\n")
        console.print("[yellow]Copy it now — it is not recoverable.[/yellow]")

    _run(_create())


@key_app.command("list")
def key_list() -> None:
    """List issued proxy API keys."""
    from claude_lb.db.models import ApiKey

    async def _list() -> None:
        async with session_scope() as session:
            result = await session.execute(select(ApiKey).order_by(ApiKey.name))
            keys = list(result.scalars())

        if not keys:
            console.print("[dim]No keys yet. Create one with:[/dim] claude-lb key create <name>")
            return

        table = Table(title="API keys")
        for column in ("Name", "Key", "Enabled", "Requests", "Cost"):
            table.add_column(column, justify="right" if column in ("Requests", "Cost") else "left")
        for key in keys:
            table.add_row(
                key.name,
                f"…{key.key_hint}",
                "yes" if key.enabled else "no",
                str(key.total_requests),
                f"${key.total_cost_usd:.4f}",
            )
        console.print(table)

    _run(_list())


if __name__ == "__main__":
    app()
