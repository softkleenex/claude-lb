from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from typing import Annotated

import httpx
import typer
from rich.console import Console
from rich.table import Table
from sqlalchemy import select

from app.core.config import get_settings
from app.core.crypto import encrypt, mask_secret
from app.db.models import Account
from app.db.session import dispose_db, init_db, session_scope
from app.modules.accounts import credentials, oauth_flow
from app.modules.api_keys.service import create_api_key
from app.modules.proxy.load_balancer import STRATEGIES, headroom, is_available

app = typer.Typer(help="Anthropic API key load balancer & proxy.", no_args_is_help=True)
account_app = typer.Typer(help="Manage upstream Anthropic accounts.", no_args_is_help=True)
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
        "app.main:app",
        host=host or settings.host,
        port=port or settings.port,
        reload=reload,
        log_level=settings.log_level.lower(),
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
    base_url: Annotated[str | None, typer.Option(help="Override the upstream base URL.")] = None,
) -> None:
    """Add an upstream account."""

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
                    base_url=base_url,
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
        for column in ("Name", "Provider", "Key", "Status", "Headroom", "Requests", "Cost"):
            table.add_column(column, justify="right" if column in ("Requests", "Cost") else "left")
        for account in accounts:
            if is_available(account):
                status = "[green]available[/green]"
            elif account.enabled:
                status = "[yellow]cooling down[/yellow]"
            else:
                status = "[red]disabled[/red]"
            table.add_row(
                account.name,
                "oauth" if account.provider == credentials.PROVIDER_OAUTH else "api key",
                account.credential_hint,
                status,
                f"{headroom(account) * 100:.0f}%",
                str(account.total_requests),
                f"${account.total_cost_usd:.4f}",
            )
        console.print(table)

    _run(_list())


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
    from app.db.models import ApiKey

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
