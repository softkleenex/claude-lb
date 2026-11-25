"""Management API for the proxy IP firewall (see `firewall.service` for the semantics)."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from claude_lb.db.models import FirewallEntry
from claude_lb.db.session import session_scope
from claude_lb.dependencies import SessionDep
from claude_lb.modules.audit import service as audit
from claude_lb.modules.auth.dependencies import client_ip
from claude_lb.modules.firewall import service

router = APIRouter(prefix="/api/firewall", tags=["firewall"])


class FirewallEntryOut(BaseModel):
    id: str
    network: str
    note: str
    version: int
    """4 or 6."""
    addresses: int
    """How many addresses the entry covers (1 for a single host)."""
    covers_client: bool = False
    """Whether this entry covers the address of the dashboard request that listed it."""
    created_at: datetime


class FirewallOut(BaseModel):
    mode: str
    entries: list[FirewallEntryOut]
    client_ip: str
    """The address this dashboard request came from, as the firewall sees it."""
    client_allowed: bool
    """Whether proxy requests from ``client_ip`` pass under the current rules."""
    client_covered: bool
    """Whether an entry covers ``client_ip`` (i.e. it would pass in allowlist mode)."""


class ModeIn(BaseModel):
    mode: str


class EntryIn(BaseModel):
    network: str = Field(min_length=1, max_length=64)
    note: str = Field(default="", max_length=255)


class EntryPatch(BaseModel):
    note: str = Field(max_length=255)


class CheckOut(BaseModel):
    network: str
    """The normalized form the entry would be stored as."""
    client_ip: str
    covers_client: bool
    client_allowed_after: bool
    """Whether this client would pass if the entry were added (current mode)."""


def _entry_out(entry: FirewallEntry, ip: str | None = None) -> FirewallEntryOut:
    network = service.to_network(entry.network)
    return FirewallEntryOut(
        covers_client=bool(service.Rules(mode="allowlist", networks=(network,)).covering(ip)),
        id=entry.id,
        network=entry.network,
        note=entry.note,
        version=network.version,
        addresses=min(network.num_addresses, 2**63 - 1),
        created_at=entry.created_at,
    )


async def _state(session, request: Request) -> FirewallOut:
    rules = await service.load_rules(session, use_cache=False)
    entries = await service.list_entries(session)
    ip = client_ip(request)
    return FirewallOut(
        mode=rules.mode,
        entries=[_entry_out(e, ip) for e in entries],
        client_ip=ip,
        client_allowed=rules.allows(ip),
        client_covered=bool(rules.covering(ip)),
    )


@router.get("", response_model=FirewallOut)
async def read_firewall(request: Request, session: SessionDep) -> FirewallOut:
    return await _state(session, request)


@router.get("/check", response_model=CheckOut)
async def check_entry(request: Request, session: SessionDep, network: str = Query(min_length=1)) -> CheckOut:
    """Preview an entry before adding it: its normalized form and whether it covers you."""
    try:
        normalized = service.normalize(network)
    except service.FirewallError as exc:
        raise HTTPException(422, str(exc)) from exc
    rules = await service.load_rules(session, use_cache=False)
    ip = client_ip(request)
    after = service.Rules(mode=rules.mode, networks=(*rules.networks, service.to_network(normalized)))
    return CheckOut(
        network=normalized,
        client_ip=ip,
        covers_client=bool(
            service.Rules(mode="allowlist", networks=(service.to_network(normalized),)).covering(ip)
        ),
        client_allowed_after=after.allows(ip),
    )


@router.put("/mode", response_model=FirewallOut)
async def set_mode(payload: ModeIn, request: Request, session: SessionDep) -> FirewallOut:
    try:
        before = await service.get_mode(session)
        await service.set_mode(session, payload.mode)
    except service.FirewallError as exc:
        raise HTTPException(422, str(exc)) from exc
    if before != payload.mode:
        entries = await service.list_entries(session)
        await audit.record(
            session,
            action="firewall.mode_changed",
            target=payload.mode,
            detail=f"{before} → {payload.mode} ({len(entries)} entr{'y' if len(entries) == 1 else 'ies'})",
            client_ip=client_ip(request),
        )
    return await _state(session, request)


@router.post("/entries", response_model=FirewallEntryOut, status_code=201)
async def add_entry(payload: EntryIn, request: Request, session: SessionDep) -> FirewallEntryOut:
    try:
        entry = await service.add_entry(session, payload.network, payload.note)
    except service.FirewallError as exc:
        status = 409 if "already" in str(exc) else 422
        raise HTTPException(status, str(exc)) from exc
    await audit.record(
        session,
        action="firewall.entry_added",
        target=entry.network,
        detail=entry.note,
        client_ip=client_ip(request),
    )
    return _entry_out(entry, client_ip(request))


async def _get_entry(session, entry_id: str) -> FirewallEntry:
    entry = await session.get(FirewallEntry, entry_id)
    if entry is None:
        raise HTTPException(404, "firewall entry not found")
    return entry


@router.patch("/entries/{entry_id}", response_model=FirewallEntryOut)
async def update_entry(
    entry_id: str, payload: EntryPatch, request: Request, session: SessionDep
) -> FirewallEntryOut:
    entry = await _get_entry(session, entry_id)
    entry.note = payload.note.strip()
    await session.flush()
    await audit.record(
        session,
        action="firewall.entry_updated",
        target=entry.network,
        detail=f"note: {entry.note}" if entry.note else "note cleared",
        client_ip=client_ip(request),
    )
    return _entry_out(entry, client_ip(request))


@router.delete("/entries/{entry_id}", status_code=204)
async def delete_entry(entry_id: str, request: Request, session: SessionDep) -> None:
    entry = await _get_entry(session, entry_id)
    network = entry.network
    await service.remove_entry(session, entry)
    await audit.record(session, action="firewall.entry_removed", target=network, client_ip=client_ip(request))


async def enforce_firewall(request: Request) -> None:
    """Router dependency for the proxy: refuse clients the firewall does not allow.

    Runs before API-key admission, so a refused address learns nothing about keys. Uses
    a session of its own for the same reason `require_api_key` does.
    """
    async with session_scope() as session:
        rules = await service.load_rules(session)
    ip = client_ip(request)
    if not rules.allows(ip):
        raise HTTPException(
            status_code=403,
            detail={
                "type": "error",
                "error": {
                    "type": "permission_error",
                    "message": f"claude-lb: client address {ip or 'unknown'} is not allowed by the firewall",
                },
            },
        )
