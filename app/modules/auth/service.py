"""Dashboard authentication: password, optional TOTP, revocable sessions.

Threat model. The proxy routes are protected by `clb_` keys; this protects the
*management plane*, which can read spend, mint keys, and add or delete upstream
credentials. Before this existed, anyone who could reach the port had all of that.

Bootstrap. A fresh install has no password. Rather than shipping a default one, the
management plane is open to loopback only, and a one-time token — printed to the log
at startup — is required to set the first password from anywhere else.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import logging
import secrets
import time
from collections import deque
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.crypto import decrypt, encrypt
from app.core.totp import generate_secret, matched_step, provisioning_uri
from app.db.models import DashboardCredential, DashboardSession

logger = logging.getLogger(__name__)

SESSION_COOKIE = "clb_session"
SESSION_TTL = timedelta(days=14)
MIN_PASSWORD_LENGTH = 8

_SCRYPT_N = 2**14
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_DKLEN = 32

_SINGLETON = "singleton"

# Regenerated every process start, so a restart invalidates an unused token.
_bootstrap_token: str = secrets.token_urlsafe(24)

# Latch: set once a password has been observed, never cleared.
#
# The bootstrap path deliberately fails *open* to loopback so a fresh install is
# usable. That is only safe while no password exists — if a read ever failed to see
# the credential row on a configured instance, the gate would silently re-open. A
# one-way latch makes that direction impossible: once this process has seen a
# password, a missing row means "sign in", never "no password set".
_password_ever_seen: bool = False


class AuthError(Exception):
    def __init__(self, message: str, status_code: int = 401) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


@dataclass
class AuthStatus:
    configured: bool
    totp_enabled: bool
    authenticated: bool
    """True when the caller may use the management plane right now."""
    reason: str = ""


# ---- password ------------------------------------------------------------


def hash_password(password: str, salt: str) -> str:
    derived = hashlib.scrypt(
        password.encode(),
        salt=bytes.fromhex(salt),
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=_SCRYPT_DKLEN,
        maxmem=64 * 1024 * 1024,
    )
    return derived.hex()


async def _hash_off_loop(password: str, salt: str) -> str:
    """scrypt costs ~20 ms of CPU by design. Run inline, an unauthenticated burst of
    login attempts would stall the event loop — and with it every proxied request."""
    return await asyncio.to_thread(hash_password, password, salt)


async def get_credential(session: AsyncSession) -> DashboardCredential | None:
    global _password_ever_seen
    credential = await session.get(DashboardCredential, _SINGLETON)
    if credential is not None:
        _password_ever_seen = True
    return credential


def password_ever_seen() -> bool:
    """Whether this process has ever observed a configured password."""
    return _password_ever_seen


def _reset_latch_for_tests() -> None:
    global _password_ever_seen
    _password_ever_seen = False


async def is_configured(session: AsyncSession) -> bool:
    return await get_credential(session) is not None


async def set_password(session: AsyncSession, password: str) -> None:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise AuthError(f"password must be at least {MIN_PASSWORD_LENGTH} characters", status_code=422)

    global _password_ever_seen
    salt = secrets.token_bytes(16).hex()
    password_hash = await _hash_off_loop(password, salt)
    credential = await get_credential(session)
    if credential is None:
        session.add(DashboardCredential(id=_SINGLETON, password_hash=password_hash, password_salt=salt))
    else:
        credential.password_hash = password_hash
        credential.password_salt = salt
    _password_ever_seen = True
    await session.flush()


async def verify_password(session: AsyncSession, password: str) -> bool:
    credential = await get_credential(session)
    if credential is None:
        return False
    candidate = await _hash_off_loop(password, credential.password_salt)
    return hmac.compare_digest(candidate, credential.password_hash)


# ---- TOTP ----------------------------------------------------------------


async def begin_totp_enrollment(session: AsyncSession, *, account_name: str) -> tuple[str, str]:
    """Generate and store a secret, but leave TOTP off until a code is confirmed."""
    credential = await get_credential(session)
    if credential is None:
        raise AuthError("set a password before enabling TOTP", status_code=409)

    secret = generate_secret()
    credential.totp_pending_secret_encrypted = encrypt(secret)
    await session.flush()
    return secret, provisioning_uri(secret, account_name=account_name)


async def confirm_totp_enrollment(session: AsyncSession, code: str) -> None:
    credential = await get_credential(session)
    if credential is None or not credential.totp_pending_secret_encrypted:
        raise AuthError("no TOTP enrollment in progress", status_code=409)
    step = matched_step(decrypt(credential.totp_pending_secret_encrypted), code)
    if step is None:
        raise AuthError("that code did not match", status_code=403)
    credential.totp_secret_encrypted = credential.totp_pending_secret_encrypted
    credential.totp_pending_secret_encrypted = None
    credential.totp_enabled = True
    credential.totp_last_step = step
    await session.flush()


async def disable_totp(session: AsyncSession) -> None:
    credential = await get_credential(session)
    if credential is None:
        return
    credential.totp_secret_encrypted = None
    credential.totp_pending_secret_encrypted = None
    credential.totp_last_step = None
    credential.totp_enabled = False
    await session.flush()


# ---- login / sessions ----------------------------------------------------


async def login(session: AsyncSession, *, password: str, totp_code: str | None, client: str) -> str:
    credential = await get_credential(session)
    if credential is None:
        raise AuthError("dashboard authentication is not configured", status_code=409)

    password_ok = await verify_password(session, password)

    totp_ok = True
    step: int | None = None
    if credential.totp_enabled:
        secret = decrypt(credential.totp_secret_encrypted or "")
        step = matched_step(secret, totp_code or "")
        # A code is single-use: one already accepted (or older) is a replay, even
        # though it is still inside the clock-drift window.
        last = credential.totp_last_step
        totp_ok = step is not None and (last is None or step > last)

    if not (password_ok and totp_ok):
        # One message for both, so the response does not reveal which factor failed.
        raise AuthError("invalid credentials")

    if step is not None:
        credential.totp_last_step = step

    return await create_session(session, client=client)


async def create_session(session: AsyncSession, *, client: str = "") -> str:
    token = secrets.token_urlsafe(32)
    session.add(
        DashboardSession(
            token_hash=hashlib.sha256(token.encode()).hexdigest(),
            expires_at=datetime.now(UTC) + SESSION_TTL,
            client=client[:255],
        )
    )
    await session.flush()
    return token


async def resolve_session(session: AsyncSession, token: str | None) -> DashboardSession | None:
    if not token:
        return None
    result = await session.execute(
        select(DashboardSession).where(
            DashboardSession.token_hash == hashlib.sha256(token.encode()).hexdigest()
        )
    )
    record = result.scalar_one_or_none()
    if record is None:
        return None

    expires_at = record.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    if expires_at <= datetime.now(UTC):
        await session.delete(record)
        return None

    record.last_seen_at = datetime.now(UTC)
    return record


async def revoke_session(session: AsyncSession, token: str | None) -> None:
    record = await resolve_session(session, token)
    if record is not None:
        await session.delete(record)


async def revoke_all_sessions(session: AsyncSession) -> int:
    result = await session.execute(delete(DashboardSession))
    return result.rowcount or 0


async def prune_expired_sessions(session: AsyncSession) -> int:
    result = await session.execute(
        delete(DashboardSession).where(DashboardSession.expires_at < datetime.now(UTC))
    )
    return result.rowcount or 0


# ---- login throttling ----------------------------------------------------
#
# Password guessing is slowed by scrypt, but a 6-digit TOTP is a million codes. Failed
# logins are counted per client address, with a global ceiling for guessing spread
# across many addresses. Per process, in memory: a restart resets it, which is fine
# for a limit measured in minutes.

LOGIN_WINDOW_SECONDS = 300.0
LOGIN_MAX_FAILURES_PER_CLIENT = 5
LOGIN_MAX_FAILURES_GLOBAL = 50

_failures_by_client: dict[str, deque[float]] = {}
_failures_global: deque[float] = deque()


def _trim(times: deque[float], now: float) -> None:
    while times and times[0] <= now - LOGIN_WINDOW_SECONDS:
        times.popleft()


def check_login_allowed(client: str) -> None:
    now = time.monotonic()
    _trim(_failures_global, now)
    mine = _failures_by_client.get(client)
    if mine is not None:
        _trim(mine, now)
        if not mine:
            del _failures_by_client[client]
            mine = None
    if (mine is not None and len(mine) >= LOGIN_MAX_FAILURES_PER_CLIENT) or len(
        _failures_global
    ) >= LOGIN_MAX_FAILURES_GLOBAL:
        raise AuthError("too many failed sign-in attempts; try again in a few minutes", status_code=429)


def record_login_failure(client: str) -> None:
    now = time.monotonic()
    _failures_by_client.setdefault(client, deque()).append(now)
    _failures_global.append(now)


def record_login_success(client: str) -> None:
    _failures_by_client.pop(client, None)


def _reset_throttle_for_tests() -> None:
    _failures_by_client.clear()
    _failures_global.clear()


# ---- bootstrap -----------------------------------------------------------


def bootstrap_token() -> str:
    return _bootstrap_token


def verify_bootstrap_token(presented: str | None) -> bool:
    return bool(presented) and hmac.compare_digest(presented or "", _bootstrap_token)


def rotate_bootstrap_token() -> str:
    """Called once the password is set, so the printed token stops working."""
    global _bootstrap_token
    _bootstrap_token = secrets.token_urlsafe(24)
    return _bootstrap_token


_LOOPBACK_NAMES = frozenset({"localhost", "localhost.", "ip6-localhost"})


def is_loopback_host_header(host_header: str | None) -> bool:
    """Whether the ``Host`` the client addressed is a loopback name.

    The peer address alone is not enough to trust a request: under DNS rebinding a
    hostile page's own domain resolves to 127.0.0.1, so its requests arrive from
    loopback — but they still carry that domain in ``Host``.
    """
    if not host_header:
        return False
    host = host_header.strip().lower()
    if host.startswith("["):  # [::1]:2456
        host = host[1 : host.find("]")] if "]" in host else host[1:]
    elif host.count(":") == 1:  # name:port or v4:port
        host = host.rsplit(":", 1)[0]
    return host in _LOOPBACK_NAMES or is_loopback(host)


def is_loopback(host: str | None) -> bool:
    if not host:
        return False
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        # Unix sockets and odd transports surface as non-IP hosts; treat as remote.
        return False
