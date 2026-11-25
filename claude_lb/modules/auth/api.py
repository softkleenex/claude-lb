from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from claude_lb.core.config import get_settings
from claude_lb.dependencies import SessionDep
from claude_lb.modules.audit import service as audit
from claude_lb.modules.auth import service as auth
from claude_lb.modules.auth.dependencies import ManagementAuthDep, client_ip

router = APIRouter(prefix="/api/auth", tags=["auth"])


class AuthStatusOut(BaseModel):
    configured: bool
    totp_enabled: bool
    authenticated: bool
    reason: str = ""
    role: str = "admin"
    """``admin`` or ``guest`` (read-only: every write endpoint answers 403)."""
    guest_access_enabled: bool = False
    guest_password_required: bool = False
    auth_enabled: bool = Field(
        default_factory=lambda: get_settings().dashboard_auth_enabled,
        description="False when CLAUDE_LB_DASHBOARD_AUTH_ENABLED=false turns the gate off entirely.",
    )


class LoginRequest(BaseModel):
    password: str
    totp_code: str | None = None


class SetPasswordRequest(BaseModel):
    password: str = Field(min_length=auth.MIN_PASSWORD_LENGTH)
    current_password: str | None = Field(default=None, description="Required once a password is already set.")


class GuestLoginRequest(BaseModel):
    password: str | None = None


class GuestConfigOut(BaseModel):
    enabled: bool
    password_set: bool


class GuestConfigPatch(BaseModel):
    model_config = {"extra": "forbid"}

    enabled: bool | None = None
    password: str | None = Field(default=None, min_length=auth.MIN_PASSWORD_LENGTH)
    clear_password: bool = False


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
    from claude_lb.modules.auth.dependencies import evaluate

    result = await evaluate(request, session)
    return AuthStatusOut(**result.__dict__)


@router.post("/login", response_model=AuthStatusOut)
async def login(payload: LoginRequest, request: Request, response: Response, session: SessionDep):
    client = client_ip(request)
    try:
        auth.check_login_allowed(client)
    except auth.AuthError as exc:
        raise HTTPException(exc.status_code, exc.message) from exc
    try:
        token = await auth.login(
            session,
            password=payload.password,
            totp_code=payload.totp_code,
            client=request.headers.get("user-agent", ""),
        )
    except auth.AuthError as exc:
        if exc.status_code == 401:
            auth.record_login_failure(client)
        await audit.record_and_commit(
            session, action="auth.login", ok=False, detail=exc.message, client_ip=client
        )
        raise HTTPException(exc.status_code, exc.message) from exc

    auth.record_login_success(client)
    await audit.record(session, action="auth.login", client_ip=client)
    _set_session_cookie(response, token, secure=request.url.scheme == "https")
    credential = await auth.get_credential(session)
    return AuthStatusOut(
        configured=True, totp_enabled=bool(credential and credential.totp_enabled), authenticated=True
    )


@router.post("/guest/login", response_model=AuthStatusOut)
async def guest_login(payload: GuestLoginRequest, request: Request, response: Response, session: SessionDep):
    """Start a read-only session. Needs guest access switched on (and its password, if set)."""
    from claude_lb.modules.auth.dependencies import evaluate

    client = client_ip(request)
    try:
        auth.check_login_allowed(client)
    except auth.AuthError as exc:
        raise HTTPException(exc.status_code, exc.message) from exc
    if not get_settings().dashboard_auth_enabled or not await auth.is_configured(session):
        raise HTTPException(409, "guest access needs a dashboard password to be set first")
    enabled, password_set = await auth.guest_config(session)
    if not enabled:
        raise HTTPException(403, "guest access is disabled")
    if not await auth.verify_guest_password(session, payload.password):
        auth.record_login_failure(client)
        await audit.record_and_commit(
            session, action="auth.guest_login", ok=False, detail="invalid guest password", actor="guest",
            client_ip=client,
        )
        raise HTTPException(401, "invalid credentials")

    auth.record_login_success(client)
    token = await auth.create_session(
        session, client=request.headers.get("user-agent", ""), role=auth.ROLE_GUEST
    )
    await audit.record(
        session,
        action="auth.guest_login",
        detail="with guest password" if password_set else "no guest password",
        actor="guest",
        client_ip=client,
    )
    _set_session_cookie(response, token, secure=request.url.scheme == "https")
    result = await evaluate(request, session)
    return AuthStatusOut(**{**result.__dict__, "authenticated": True, "role": auth.ROLE_GUEST})


@router.get("/guest", response_model=GuestConfigOut)
async def read_guest_config(session: SessionDep, _: ManagementAuthDep) -> GuestConfigOut:
    enabled, password_set = await auth.guest_config(session)
    return GuestConfigOut(enabled=enabled, password_set=password_set)


@router.patch("/guest", response_model=GuestConfigOut)
async def update_guest_config(
    payload: GuestConfigPatch, request: Request, session: SessionDep, _: ManagementAuthDep
) -> GuestConfigOut:
    """Switch guest access on/off and set or clear its optional password.

    Switching it off or changing the password ends every guest session.
    """
    if payload.enabled is None and payload.password is None and not payload.clear_password:
        raise HTTPException(422, "nothing to change")
    if payload.password is not None and payload.clear_password:
        raise HTTPException(422, "set a password or clear it, not both")
    if payload.enabled and not await auth.is_configured(session):
        raise HTTPException(409, "set a dashboard password before enabling guest access")
    enabled, password_set = await auth.guest_config(session)
    ip = client_ip(request)
    revoke = False
    if payload.enabled is not None and payload.enabled != enabled:
        await auth.set_guest_enabled(session, payload.enabled)
        await audit.record(
            session,
            action="auth.guest_access_enabled" if payload.enabled else "auth.guest_access_disabled",
            client_ip=ip,
        )
        revoke = revoke or not payload.enabled
    if payload.password is not None:
        try:
            await auth.set_guest_password(session, payload.password)
        except auth.AuthError as exc:
            raise HTTPException(exc.status_code, exc.message) from exc
        await audit.record(session, action="auth.guest_password_set", client_ip=ip)
        revoke = True
    elif payload.clear_password and password_set:
        await auth.set_guest_password(session, None)
        await audit.record(session, action="auth.guest_password_cleared", client_ip=ip)
    if revoke:
        await auth.revoke_guest_sessions(session)
    enabled, password_set = await auth.guest_config(session)
    return GuestConfigOut(enabled=enabled, password_set=password_set)


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
