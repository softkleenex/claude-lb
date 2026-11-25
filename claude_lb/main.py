from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.exception_handlers import http_exception_handler
from fastapi.responses import JSONResponse

from claude_lb import __version__
from claude_lb.core.config import get_settings
from claude_lb.db.session import dispose_db, init_db, session_scope
from claude_lb.modules.accounts.api import router as accounts_router
from claude_lb.modules.api_keys.api import router as api_keys_router
from claude_lb.modules.audit import service as audit_service
from claude_lb.modules.audit.api import router as audit_router
from claude_lb.modules.auth import dependencies as auth_dependencies
from claude_lb.modules.auth import service as auth_service
from claude_lb.modules.auth.api import router as auth_router
from claude_lb.modules.auth.dependencies import require_management_auth
from claude_lb.modules.dashboard.api import router as dashboard_router
from claude_lb.modules.health.api import router as health_router
from claude_lb.modules.health.service import Scheduler
from claude_lb.modules.proxy.api import router as proxy_router
from claude_lb.modules.settings.api import router as settings_router
from claude_lb.modules.usage import metrics as usage_metrics
from claude_lb.modules.usage.api import prune_request_logs
from claude_lb.modules.usage.api import router as usage_router

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    logging.basicConfig(
        level=settings.log_level.upper(),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )

    await init_db()
    async with session_scope() as session:
        pruned = await prune_request_logs(session)
        if pruned:
            logger.info("pruned %d request log rows past retention", pruned)
        await auth_service.prune_expired_sessions(session)
        await audit_service.prune(session)
        auth_configured = await auth_service.is_configured(session)

    if settings.dashboard_auth_enabled and not auth_configured:
        logger.warning(
            "No dashboard password is set. The management plane is reachable from "
            "loopback only. To set one from another host, pass this one-time token as "
            "the %s header (it changes on every restart):\n\n    %s\n",
            auth_dependencies.BOOTSTRAP_HEADER,
            auth_service.bootstrap_token(),
        )
    elif not settings.dashboard_auth_enabled:
        logger.warning(
            "CLAUDE_LB_DASHBOARD_AUTH_ENABLED=false — the management plane is "
            "unauthenticated. Only do this behind a proxy that authenticates for it."
        )

    timeout = httpx.Timeout(
        settings.upstream_timeout_seconds,
        connect=settings.upstream_connect_timeout_seconds,
    )
    app.state.http_client = httpx.AsyncClient(
        timeout=timeout,
        limits=httpx.Limits(max_connections=200, max_keepalive_connections=50),
        follow_redirects=False,
    )
    logger.info(
        "claude-lb listening on %s:%s (strategy=%s, data=%s)",
        settings.host,
        settings.port,
        settings.routing_strategy,
        settings.data_dir,
    )
    scheduler = Scheduler(app.state.http_client)
    scheduler.start()
    app.state.scheduler = scheduler

    try:
        yield
    finally:
        await scheduler.stop()
        await app.state.http_client.aclose()
        await dispose_db()


_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def _is_cross_site(request: Request) -> bool:
    if request.headers.get("sec-fetch-site") == "cross-site":
        return True
    origin = request.headers.get("origin")
    if not origin:
        return False
    if origin == "null":  # sandboxed frames, file:// pages
        return True
    # Behind a reverse proxy the Host we see may be the upstream's, not the one the
    # browser used. X-Forwarded-Host is safe to accept here: a cross-origin page
    # cannot set it without a CORS preflight, which claude-lb never grants.
    origin_host = urlsplit(origin).netloc.lower()
    seen = {
        (request.headers.get("host") or "").lower(),
        (request.headers.get("x-forwarded-host") or "").split(",")[0].strip().lower(),
    }
    return origin_host not in seen


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="claude-lb",
        version=__version__,
        summary="Anthropic API key load balancer & proxy",
        lifespan=lifespan,
    )

    # /api/auth is intentionally unguarded — it is how you get in.
    app.include_router(auth_router)

    # Everything else on the management plane requires an authenticated operator.
    guarded = [
        accounts_router,
        api_keys_router,
        usage_router,
        settings_router,
        audit_router,
        health_router,
    ]
    for router in guarded:
        app.include_router(router, dependencies=[Depends(require_management_auth)])
    if settings.dashboard_enabled:
        app.include_router(dashboard_router)
    # Registered last: its catch-all /v1/{path} must not shadow the management API.
    app.include_router(proxy_router)

    @app.middleware("http")
    async def reject_cross_site_writes(request: Request, call_next):
        """Refuse state-changing management requests that a browser sent cross-site.

        The session cookie is SameSite=Lax, which already keeps it off cross-site
        POSTs. That does not cover the no-password bootstrap window, where loopback
        alone grants access and a hostile page can make the visitor's browser POST
        to 127.0.0.1. Browsers mark every cross-origin request with ``Origin`` (and
        ``Sec-Fetch-Site``); CLI and SDK clients send neither, so they are unaffected.
        """
        if request.method not in _SAFE_METHODS and not request.url.path.startswith("/v1/"):
            if _is_cross_site(request):
                return JSONResponse(status_code=403, content={"detail": "cross-site request refused"})
        return await call_next(request)

    @app.exception_handler(HTTPException)
    async def anthropic_shaped_errors(request: Request, exc: HTTPException):
        """Emit Anthropic's error envelope on proxy routes.

        FastAPI wraps `HTTPException.detail` in `{"detail": ...}`, which the Anthropic
        SDKs cannot parse — they read `error.type` / `error.message` off the top level.
        Management routes keep FastAPI's default shape.
        """
        if not request.url.path.startswith("/v1/"):
            return await http_exception_handler(request, exc)

        detail = exc.detail
        if isinstance(detail, dict) and "error" in detail:
            body = detail
        else:
            body = {
                "type": "error",
                "error": {"type": _error_type_for(exc.status_code), "message": str(detail)},
            }
        return JSONResponse(status_code=exc.status_code, content=body, headers=exc.headers)

    @app.get("/metrics", tags=["meta"], include_in_schema=False)
    async def metrics() -> Response:
        """Prometheus scrape endpoint.

        Left unauthenticated so a scraper needs no session, matching /health. It
        exposes account names and aggregate counters, never credentials — but if that
        is still too much for your network, keep the port on loopback.
        """
        async with session_scope() as session:
            body = await usage_metrics.render(session)
        return Response(content=body, media_type=usage_metrics.CONTENT_TYPE)

    @app.get("/health", tags=["meta"])
    async def health() -> JSONResponse:
        return JSONResponse({"status": "ok", "version": app.version})

    return app


def _error_type_for(status_code: int) -> str:
    return {
        400: "invalid_request_error",
        401: "authentication_error",
        403: "permission_error",
        404: "not_found_error",
        413: "request_too_large",
        429: "rate_limit_error",
        529: "overloaded_error",
    }.get(status_code, "api_error")


app = create_app()
