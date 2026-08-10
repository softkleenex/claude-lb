from __future__ import annotations

import asyncio
from typing import Annotated

import typer
from rich.console import Console
from rich.table import Table
from sqlalchemy import select

from app.core.config import get_settings
from app.core.crypto import encrypt, mask_secret
from app.db.models import Account
from app.db.session import dispose_db, init_db, session_scope
from app.modules.api_keys.service import create_api_key
from app.modules.proxy.load_balancer import STRATEGIES, headroom, is_available

app = typer.Typer(help="Anthropic API key load balancer & proxy.", no_args_is_help=True)
account_app = typer.Typer(help="Manage upstream Anthropic accounts.", no_args_is_help=True)
key_app = typer.Typer(help="Manage locally issued proxy API keys.", no_args_is_help=True)
app.add_typer(account_app, name="account")
app.add_typer(key_app, name="key")

console = Console()


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
        for column in ("Name", "Key", "Status", "Headroom", "Requests", "Cost"):
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
