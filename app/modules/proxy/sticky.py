"""Conversation affinity, so Anthropic's prompt cache stays warm.

Prompt caches are scoped to the credential that created them. Spreading the turns of
one conversation across a pool therefore throws the cache away on every turn: each
account pays the ~1.25x cache-write premium instead of the 0.1x read. Pinning a
conversation to one account is worth far more than perfectly even load.

The key is derived from the *cacheable prefix* — `system`, `tools`, and the first user
turn — which is exactly the part Anthropic hashes and exactly the part that stays byte
-identical as a conversation grows. Later turns of the same conversation therefore hash
to the same key without the client sending any session id.

Two layers:

* an in-process affinity map, so a conversation sticks to the account that actually
  served it;
* rendezvous (highest-random-weight) hashing as the cold-start fallback, so a fresh
  process — or a second worker — still routes a given conversation consistently
  without shared state, and only ~1/N conversations move when the pool changes.
"""

from __future__ import annotations

import hashlib
import json
import math
import time
from collections import OrderedDict
from collections.abc import Sequence

from app.db.models import Account
from app.modules.proxy.load_balancer import is_available

# Bounded so a long-running proxy cannot grow this without limit.
_MAX_ENTRIES = 10_000
_affinity: OrderedDict[str, tuple[str, float]] = OrderedDict()


def session_key(body: bytes, *, api_key_id: str | None = None) -> str | None:
    """Stable id for the conversation this request belongs to, or ``None``.

    Returns ``None`` for bodies with no cacheable prefix to speak of — there is nothing
    to keep warm, so those requests should just take the normal routing path.
    """
    try:
        payload = json.loads(body) if body else None
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict):
        return None

    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        return None

    # `system` and `tools` render ahead of `messages` in the cached prefix; the first
    # user turn anchors the specific conversation.
    prefix = {
        "system": payload.get("system"),
        "tools": payload.get("tools"),
        "first": messages[0],
        "model": payload.get("model"),
    }
    try:
        serialized = json.dumps(prefix, sort_keys=True, separators=(",", ":"), default=str)
    except (TypeError, ValueError):
        return None

    digest = hashlib.sha256()
    if api_key_id:
        # Two tenants sending an identical prefix should not share an account slot.
        digest.update(api_key_id.encode())
        digest.update(b"\x00")
    digest.update(serialized.encode())
    return digest.hexdigest()


def rendezvous(key: str, accounts: Sequence[Account]) -> str | None:
    """Highest-random-weight pick: deterministic, and stable as the pool changes.

    Adding or removing one account remaps only the conversations that hashed to it,
    rather than reshuffling everything the way modulo hashing would.
    """
    best_id: str | None = None
    best_score = -1.0
    for account in accounts:
        weight = max(account.weight, 0.0)
        if weight <= 0:
            continue
        digest = hashlib.sha256(f"{key}\x00{account.id}".encode()).digest()
        # Top 8 bytes as a fraction in [0, 1), then weighted so heavier accounts win more often.
        unit = int.from_bytes(digest[:8], "big") / float(1 << 64)
        # Guard the log domain: unit is in [0, 1), and 0.0 would blow up.
        score = weight / -math.log(max(unit, 1e-18))
        if score > best_score:
            best_id, best_score = account.id, score
    return best_id


def resolve(
    key: str | None,
    accounts: Sequence[Account],
    *,
    ttl_seconds: int,
    now: float | None = None,
) -> str | None:
    """The account this conversation should prefer, or ``None`` to route normally."""
    if not key or ttl_seconds <= 0:
        return None

    available = [a for a in accounts if is_available(a)]
    if not available:
        return None
    available_ids = {a.id for a in available}

    now = now if now is not None else time.monotonic()
    entry = _affinity.get(key)
    if entry is not None:
        account_id, expires_at = entry
        if expires_at > now and account_id in available_ids:
            _affinity.move_to_end(key)
            return account_id
        # Expired, or the account is down — drop it and fall through to a fresh pick.
        del _affinity[key]

    return rendezvous(key, available)


def remember(key: str | None, account_id: str, *, ttl_seconds: int, now: float | None = None) -> None:
    """Record which account actually served this conversation."""
    if not key or ttl_seconds <= 0:
        return
    now = now if now is not None else time.monotonic()
    _affinity[key] = (account_id, now + ttl_seconds)
    _affinity.move_to_end(key)
    while len(_affinity) > _MAX_ENTRIES:
        _affinity.popitem(last=False)


def forget(key: str | None) -> None:
    if key:
        _affinity.pop(key, None)


def clear() -> None:
    _affinity.clear()


def size() -> int:
    return len(_affinity)
