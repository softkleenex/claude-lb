"""IP firewall for the proxy routes (`/v1/*`).

Semantics (same as codex-lb, plus CIDR ranges and an explicit mode):

* ``allow_all`` — every client may call the proxy (API keys still apply).
* ``allowlist`` — only clients whose address is inside one of the entries may. An
  allowlist with no entries refuses every proxy request; the dashboard says so.

The firewall guards the **proxy only**. The management plane (`/api/*`, the dashboard)
has its own password gate, and keeping the firewall off it means a mistyped entry can
never lock the operator out of the page that fixes it. Loopback gets no exemption on the
proxy: a rule that says "only 10.0.0.0/8" means exactly that.

The client address is the TCP peer (`auth.dependencies.client_ip`) — the same one the
dashboard gate and request logs use. claude-lb has no trusted-proxy setting, so
``X-Forwarded-For`` is ignored; behind a reverse proxy, allow the proxy's address.

Decisions are cached per process for a few seconds and the cache is dropped on every
change, so the hot path does not hit the database.
"""

from __future__ import annotations

import ipaddress
import time
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from claude_lb.db.models import FirewallEntry
from claude_lb.modules.settings import service as settings_service

MODES = ("allow_all", "allowlist")
MODE_KEY = "firewall_mode"
_CACHE_TTL_SECONDS = 5.0

Network = ipaddress.IPv4Network | ipaddress.IPv6Network


class FirewallError(ValueError):
    pass


@dataclass(frozen=True)
class Rules:
    mode: str
    networks: tuple[Network, ...]

    def allows(self, ip: str | None) -> bool:
        if self.mode != "allowlist":
            return True
        address = parse_address(ip)
        if address is None:
            return False
        return any(address.version == net.version and address in net for net in self.networks)

    def covering(self, ip: str | None) -> list[Network]:
        address = parse_address(ip)
        if address is None:
            return []
        return [net for net in self.networks if address.version == net.version and address in net]


_cache: Rules | None = None
_cached_at = 0.0


def invalidate() -> None:
    global _cache, _cached_at
    _cache, _cached_at = None, 0.0


def parse_address(ip: str | None) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    if not ip:
        return None
    try:
        address = ipaddress.ip_address(ip.strip().split("%", 1)[0])
    except ValueError:
        return None
    # A dual-stack listener reports IPv4 clients as ::ffff:a.b.c.d.
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return address.ipv4_mapped
    return address


def normalize(value: str) -> str:
    """``10.0.0.5`` / ``10.0.0.5/32`` → ``10.0.0.5``; ``10.1.2.3/8`` is refused (host bits set)."""
    raw = (value or "").strip()
    if not raw:
        raise FirewallError("an IP address or CIDR range is required")
    try:
        loose = ipaddress.ip_network(raw, strict=False)
    except ValueError as exc:
        raise FirewallError(f"{raw} is not a valid IPv4/IPv6 address or CIDR range") from exc
    try:
        network = ipaddress.ip_network(raw, strict=True)
    except ValueError as exc:
        raise FirewallError(f"{raw} has host bits set; did you mean {loose}?") from exc
    if isinstance(network, ipaddress.IPv6Network) and network.network_address.ipv4_mapped is not None:
        raise FirewallError("use the plain IPv4 form instead of an IPv4-mapped IPv6 address")
    if network.num_addresses == 1:
        return str(network.network_address)
    return str(network)


def to_network(value: str) -> Network:
    return ipaddress.ip_network(value, strict=False)


async def get_mode(session: AsyncSession) -> str:
    mode = await settings_service.get_value(session, MODE_KEY, "allow_all")
    return mode if mode in MODES else "allowlist"  # unreadable → fail closed


async def set_mode(session: AsyncSession, mode: str) -> None:
    if mode not in MODES:
        raise FirewallError(f"unknown mode {mode!r}; expected one of {', '.join(MODES)}")
    await settings_service.set_value(session, MODE_KEY, mode)
    invalidate()


async def list_entries(session: AsyncSession) -> list[FirewallEntry]:
    result = await session.execute(
        select(FirewallEntry).order_by(FirewallEntry.created_at, FirewallEntry.network)
    )
    return list(result.scalars())


async def load_rules(session: AsyncSession, *, use_cache: bool = True) -> Rules:
    global _cache, _cached_at
    if use_cache and _cache is not None and time.monotonic() - _cached_at < _CACHE_TTL_SECONDS:
        return _cache
    mode = await get_mode(session)
    networks: list[Network] = []
    for entry in await list_entries(session):
        try:
            networks.append(to_network(entry.network))
        except ValueError:
            continue
    rules = Rules(mode=mode, networks=tuple(networks))
    _cache, _cached_at = rules, time.monotonic()
    return rules


async def add_entry(session: AsyncSession, value: str, note: str = "") -> FirewallEntry:
    network = normalize(value)
    existing = await session.execute(select(FirewallEntry).where(FirewallEntry.network == network))
    if existing.scalar_one_or_none() is not None:
        raise FirewallError(f"{network} is already on the list")
    entry = FirewallEntry(network=network, note=note.strip()[:255])
    session.add(entry)
    await session.flush()
    invalidate()
    return entry


async def remove_entry(session: AsyncSession, entry: FirewallEntry) -> None:
    await session.delete(entry)
    await session.flush()
    invalidate()
