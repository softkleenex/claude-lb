from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app.dependencies import SessionDep
from app.modules.audit import service as audit
from app.modules.auth import service as auth
from app.modules.auth.dependencies import ManagementAuthDep, client_ip

router = APIRouter(prefix="/api/auth", tags=["auth"])


class AuthStatusOut(BaseModel):
    configured: bool
    totp_enabled: bool
    authenticated: bool
    reason: str = ""


class LoginRequest(BaseModel):
    password: str
    totp_code: str | None = None


class SetPasswordRequest(BaseModel):
    password: str = Field(min_length=auth.MIN_PASSWORD_LENGTH)
    current_password: str | None = Field(default=None, description="Required once a password is already set.")


class TotpEnrollment(BaseModel):
    secret: str
    provisioning_uri: str


class TotpConfirm(BaseModel):
    code: str


def _set_session_cookie(response: Response, token: str, *, secure: bool) -> None:
    response.set_cookie(
        auth.SESSION_COOKIE,
        token,
        httponly=True,
        samesite="lax",
        secure=secure,
        max_age=int(auth.SESSION_TTL.total_seconds()),
        path="/",
    )


@router.get("/status", response_model=AuthStatusOut)
async def status(request: Request, session: SessionDep) -> AuthStatusOut:
    """Unauthenticated on purpose: the login page needs to know what to render."""
    from app.modules.auth.dependencies import evaluate

    result = await evaluate(request, session)
    return AuthStatusOut(**result.__dict__)


@router.post("/login", response_model=AuthStatusOut)
async def login(payload: LoginRequest, request: Request, response: Response, session: SessionDep):
    try:
        token = await auth.login(
            session,
            password=payload.password,
            totp_code=payload.totp_code,
            client=request.headers.get("user-agent", ""),
        )
    except auth.AuthError as exc:
        await audit.record_and_commit(
            session, action="auth.login", ok=False, detail=exc.message, client_ip=client_ip(request)
        )
        raise HTTPException(exc.status_code, exc.message) from exc

    await audit.record(session, action="auth.login", client_ip=client_ip(request))
    _set_session_cookie(response, token, secure=request.url.scheme == "https")
    credential = await auth.get_credential(session)
    return AuthStatusOut(
        configured=True, totp_enabled=bool(credential and credential.totp_enabled), authenticated=True
    )


@router.post("/logout", status_code=204)
async def logout(request: Request, response: Response, session: SessionDep) -> None:
    await auth.revoke_session(session, request.cookies.get(auth.SESSION_COOKIE))
    response.delete_cookie(auth.SESSION_COOKIE, path="/")


@router.post("/password", response_model=AuthStatusOut)
async def set_password(
    payload: SetPasswordRequest,
    request: Request,
    response: Response,
    session: SessionDep,
    _: ManagementAuthDep,
) -> AuthStatusOut:
    """Set or rotate the dashboard password.

    Reachable from loopback (or with the bootstrap token) before one exists; afterwards
    it needs a live session *and* the current password, so a stolen cookie alone cannot
    lock the operator out.
    """
    already_set = await auth.is_configured(session)
    if already_set:
        if not payload.current_password or not await auth.verify_password(session, payload.current_password):
            raise HTTPException(403, "current password is incorrect")

    try:
        await auth.set_password(session, payload.password)
    except auth.AuthError as exc:
        raise HTTPException(exc.status_code, exc.message) from exc

    # Every existing session used the old password; a rotation should end them.
    await auth.revoke_all_sessions(session)
    auth.rotate_bootstrap_token()

    token = await auth.create_session(session, client=request.headers.get("user-agent", ""))
    _set_session_cookie(response, token, secure=request.url.scheme == "https")
    await audit.record(
        session,
        action="auth.password_rotated" if already_set else "auth.password_set",
        client_ip=client_ip(request),
    )

    credential = await auth.get_credential(session)
    return AuthStatusOut(
        configured=True, totp_enabled=bool(credential and credential.totp_enabled), authenticated=True
    )


@router.post("/totp/enroll", response_model=TotpEnrollment)
async def enroll_totp(request: Request, session: SessionDep, _: ManagementAuthDep) -> TotpEnrollment:
    try:
        secret, uri = await auth.begin_totp_enrollment(session, account_name="dashboard")
    except auth.AuthError as exc:
        raise HTTPException(exc.status_code, exc.message) from exc
    await audit.record(session, action="auth.totp_enroll_started", client_ip=client_ip(request))
    return TotpEnrollment(secret=secret, provisioning_uri=uri)


@router.post("/totp/confirm", status_code=204)
async def confirm_totp(
    payload: TotpConfirm, request: Request, session: SessionDep, _: ManagementAuthDep
) -> None:
    try:
        await auth.confirm_totp_enrollment(session, payload.code)
    except auth.AuthError as exc:
        await audit.record_and_commit(
            session, action="auth.totp_enabled", ok=False, detail=exc.message, client_ip=client_ip(request)
        )
        raise HTTPException(exc.status_code, exc.message) from exc
    await audit.record(session, action="auth.totp_enabled", client_ip=client_ip(request))


@router.delete("/totp", status_code=204)
async def remove_totp(request: Request, session: SessionDep, _: ManagementAuthDep) -> None:
    await auth.disable_totp(session)
    await audit.record(session, action="auth.totp_disabled", client_ip=client_ip(request))


@router.post("/sessions/revoke-all", status_code=204)
async def revoke_all(request: Request, session: SessionDep, _: ManagementAuthDep) -> None:
    count = await auth.revoke_all_sessions(session)
    await audit.record(
        session, action="auth.sessions_revoked", detail=f"{count} session(s)", client_ip=client_ip(request)
    )
