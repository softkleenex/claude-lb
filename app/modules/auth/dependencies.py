"""Gate for the management plane (`/api/*` and the dashboard).

Access is granted when any of these hold:

1. a valid dashboard session cookie;
2. no password is configured yet **and** the request came from loopback;
3. no password is configured yet **and** the caller presents the one-time bootstrap
   token printed at startup.

(2) and (3) exist only so a fresh install is usable. Both stop working the moment a
password is set, because `rotate_bootstrap_token()` runs and the cookie check takes over.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.session import get_session
from app.modules.auth import service as auth
from app.modules.auth.service import AuthStatus

BOOTSTRAP_HEADER = "x-claude-lb-bootstrap"


def client_ip(request: Request) -> str:
    return request.client.host if request.client else ""


def _presented_bootstrap(request: Request) -> str | None:
    return request.headers.get(BOOTSTRAP_HEADER) or request.query_params.get("bootstrap")


async def evaluate(request: Request, session: AsyncSession) -> AuthStatus:
    """Work out whether this request may use the management plane, and why."""
    if not get_settings().dashboard_auth_enabled:
        return AuthStatus(
            configured=False, totp_enabled=False, authenticated=True, reason="auth disabled by config"
        )

    credential = await auth.get_credential(session)
    # Latched: a configured instance can never fall back to the bootstrap path, even
    # if this particular read came up empty.
    configured = credential is not None or auth.password_ever_seen()
    totp_enabled = bool(credential and credential.totp_enabled)

    record = await auth.resolve_session(session, request.cookies.get(auth.SESSION_COOKIE))
    if record is not None:
        return AuthStatus(configured=configured, totp_enabled=totp_enabled, authenticated=True)

    if not configured:
        if auth.verify_bootstrap_token(_presented_bootstrap(request)):
            return AuthStatus(
                configured=False,
                totp_enabled=False,
                authenticated=True,
                reason="bootstrap token accepted — set a password",
            )
        if auth.is_loopback(client_ip(request)):
            return AuthStatus(
                configured=False,
                totp_enabled=False,
                authenticated=True,
                reason="unprotected: no password set (loopback only)",
            )
        return AuthStatus(
            configured=False,
            totp_enabled=False,
            authenticated=False,
            reason="no password set; supply the bootstrap token from the server log",
        )

    return AuthStatus(
        configured=True, totp_enabled=totp_enabled, authenticated=False, reason="sign in required"
    )


async def require_management_auth(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AuthStatus:
    status = await evaluate(request, session)
    if not status.authenticated:
        raise HTTPException(
            status_code=401,
            detail=status.reason or "authentication required",
            headers={"x-claude-lb-auth": "required"},
        )
    return status


ManagementAuthDep = Annotated[AuthStatus, Depends(require_management_auth)]
