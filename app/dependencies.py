from __future__ import annotations

from typing import Annotated

import httpx
from fastapi import Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.session import get_session, session_scope
from app.modules.api_keys.service import Admission, AuthError, admit
from app.modules.proxy.service import ProxyService

SessionDep = Annotated[AsyncSession, Depends(get_session)]


def get_http_client(request: Request) -> httpx.AsyncClient:
    return request.app.state.http_client


def get_proxy_service(
    client: Annotated[httpx.AsyncClient, Depends(get_http_client)],
) -> ProxyService:
    return ProxyService(client)


ProxyServiceDep = Annotated[ProxyService, Depends(get_proxy_service)]


def extract_presented_key(request: Request) -> str | None:
    """Accept either Anthropic's ``x-api-key`` or a bearer token, so existing clients
    work without reconfiguration."""
    api_key = request.headers.get("x-api-key")
    if api_key:
        return api_key
    authorization = request.headers.get("authorization", "")
    if authorization.lower().startswith("bearer "):
        return authorization[7:].strip() or None
    return None


async def require_api_key(request: Request) -> Admission | None:
    """Authenticate the client key on a session of its own.

    Deliberately not the request-scoped ``SessionDep``: that connection would stay
    checked out until the response finished — for a stream, minutes — while the
    proxy opened more connections to do its work. Fifteen concurrent requests then
    held the whole pool and waited on each other forever.
    """
    settings = get_settings()
    presented = extract_presented_key(request)

    if not settings.require_api_key and not presented:
        return None

    if not presented:
        raise HTTPException(
            status_code=401,
            detail={
                "type": "error",
                "error": {"type": "authentication_error", "message": "missing x-api-key header"},
            },
        )

    try:
        async with session_scope() as session:
            return await admit(session, presented)
    except AuthError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={
                "type": "error",
                "error": {
                    "type": "rate_limit_error" if exc.status_code == 429 else "authentication_error",
                    "message": exc.message,
                },
            },
        ) from exc


AdmissionDep = Annotated[Admission | None, Depends(require_api_key)]
