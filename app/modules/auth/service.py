"""Dashboard authentication: password, optional TOTP, revocable sessions.

Threat model. The proxy routes are protected by `clb_` keys; this protects the
*management plane*, which can read spend, mint keys, and add or delete upstream
credentials. Before this existed, anyone who could reach the port had all of that.

Bootstrap. A fresh install has no password. Rather than shipping a default one, the
management plane is open to loopback only, and a one-time token — printed to the log
at startup — is required to set the first password from anywhere else.
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import logging
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.crypto import decrypt, encrypt
from app.core.totp import generate_secret, provisioning_uri
from app.core.totp import verify as verify_totp
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
    credential = await get_credential(session)
    if credential is None:
        session.add(
            DashboardCredential(
                id=_SINGLETON, password_hash=hash_password(password, salt), password_salt=salt
            )
        )
    else:
        credential.password_hash = hash_password(password, salt)
        credential.password_salt = salt
    _password_ever_seen = True
    await session.flush()


async def verify_password(session: AsyncSession, password: str) -> bool:
    credential = await get_credential(session)
    if credential is None:
        return False
    return hmac.compare_digest(hash_password(password, credential.password_salt), credential.password_hash)


# ---- TOTP ----------------------------------------------------------------


async def begin_totp_enrollment(session: AsyncSession, *, account_name: str) -> tuple[str, str]:
    """Generate and store a secret, but leave TOTP off until a code is confirmed."""
    credential = await get_credential(session)
    if credential is None:
        raise AuthError("set a password before enabling TOTP", status_code=409)

    secret = generate_secret()
    credential.totp_secret_encrypted = encrypt(secret)
    credential.totp_enabled = False
    await session.flush()
    return secret, provisioning_uri(secret, account_name=account_name)


async def confirm_totp_enrollment(session: AsyncSession, code: str) -> None:
    credential = await get_credential(session)
    if credential is None or not credential.totp_secret_encrypted:
        raise AuthError("no TOTP enrollment in progress", status_code=409)
    if not verify_totp(decrypt(credential.totp_secret_encrypted), code):
        raise AuthError("that code did not match", status_code=403)
    credential.totp_enabled = True
    await session.flush()


async def disable_totp(session: AsyncSession) -> None:
    credential = await get_credential(session)
    if credential is None:
        return
    credential.totp_secret_encrypted = None
    credential.totp_enabled = False
    await session.flush()


# ---- login / sessions ----------------------------------------------------


async def login(session: AsyncSession, *, password: str, totp_code: str | None, client: str) -> str:
    credential = await get_credential(session)
    if credential is None:
        raise AuthError("dashboard authentication is not configured", status_code=409)

    password_ok = await verify_password(session, password)

    totp_ok = True
    if credential.totp_enabled:
        secret = decrypt(credential.totp_secret_encrypted or "")
        totp_ok = bool(totp_code) and verify_totp(secret, totp_code or "")

    if not (password_ok and totp_ok):
        # One message for both, so the response does not reveal which factor failed.
        raise AuthError("invalid credentials")

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


def is_loopback(host: str | None) -> bool:
    if not host:
        return False
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        # Unix sockets and odd transports surface as non-IP hosts; treat as remote.
        return False
