from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.exception_handlers import http_exception_handler
from fastapi.responses import JSONResponse

from app.core.config import get_settings
from app.db.session import dispose_db, init_db, session_scope
from app.modules.accounts.api import router as accounts_router
from app.modules.api_keys.api import router as api_keys_router
from app.modules.dashboard.api import router as dashboard_router
from app.modules.proxy.api import router as proxy_router
from app.modules.usage.api import prune_request_logs
from app.modules.usage.api import router as usage_router

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
    try:
        yield
    finally:
        await app.state.http_client.aclose()
        await dispose_db()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="claude-lb",
        version="0.1.0",
        summary="Anthropic API key load balancer & proxy",
        lifespan=lifespan,
    )

    app.include_router(accounts_router)
    app.include_router(api_keys_router)
    app.include_router(usage_router)
    if settings.dashboard_enabled:
        app.include_router(dashboard_router)
    # Registered last: its catch-all /v1/{path} must not shadow the management API.
    app.include_router(proxy_router)

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
