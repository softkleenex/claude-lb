"""Anthropic-compatible passthrough routes.

Point any Anthropic client at ``http://127.0.0.1:2456`` as its base URL and the
existing ``/v1/...`` paths keep working.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from app.dependencies import ApiKeyDep, ProxyServiceDep
from app.modules.proxy.service import (
    UpstreamExhausted,
    record_request,
    wrap_stream_for_accounting,
)

router = APIRouter(tags=["proxy"])

# Anthropic API surfaces worth exposing. Anything else 404s rather than being blindly
# relayed, so a typo in a client base URL fails loudly.
PROXIED_PREFIXES = ("/v1/messages", "/v1/models", "/v1/complete", "/v1/files", "/v1/organizations")


def _is_proxied(path: str) -> bool:
    return any(path == prefix or path.startswith(prefix + "/") for prefix in PROXIED_PREFIXES)


@router.api_route(
    "/v1/{full_path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    include_in_schema=False,
)
async def proxy(
    full_path: str,
    request: Request,
    proxy_service: ProxyServiceDep,
    api_key: ApiKeyDep,
) -> Response:
    path = f"/v1/{full_path}"
    if not _is_proxied(path):
        return JSONResponse(
            status_code=404,
            content={
                "type": "error",
                "error": {"type": "not_found_error", "message": f"{path} is not proxied by claude-lb"},
            },
        )

    body = await request.body()
    started_at = time.perf_counter()
    api_key_id = api_key.id if api_key else None
    model, _ = proxy_service._peek_request(body)  # noqa: SLF001 - same package

    try:
        outcome = await proxy_service.forward(
            method=request.method,
            path=path,
            query=request.url.query,
            headers=dict(request.headers),
            body=body,
            api_key=api_key,
        )
    except UpstreamExhausted as exc:
        await record_request(
            account_id=None,
            api_key_id=api_key_id,
            path=path,
            model=model,
            status_code=exc.status_code,
            streaming=False,
            started_at=started_at,
            attempts=0,
            usage=_empty_usage(),
            error=str(exc),
        )
        if exc.last_body:
            # Surface the upstream error verbatim so clients see Anthropic's own message.
            return Response(
                content=exc.last_body,
                status_code=exc.status_code,
                media_type="application/json",
            )
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "type": "error",
                "error": {"type": "api_error", "message": f"claude-lb: {exc}"},
            },
        )

    if outcome.streaming and outcome.stream is not None:
        return StreamingResponse(
            wrap_stream_for_accounting(
                outcome.stream,
                account_id=outcome.account.id,
                api_key_id=api_key_id,
                path=path,
                model=model,
                status_code=outcome.status_code,
                started_at=started_at,
                attempts=outcome.attempts,
            ),
            status_code=outcome.status_code,
            headers=_response_headers(outcome.headers, outcome.account.name),
            media_type=outcome.headers.get("content-type", "text/event-stream"),
        )

    await record_request(
        account_id=outcome.account.id,
        api_key_id=api_key_id,
        path=path,
        model=model,
        status_code=outcome.status_code,
        streaming=False,
        started_at=started_at,
        attempts=outcome.attempts,
        usage=outcome.usage,
    )
    return Response(
        content=outcome.body or b"",
        status_code=outcome.status_code,
        headers=_response_headers(outcome.headers, outcome.account.name),
        media_type=outcome.headers.get("content-type", "application/json"),
    )


def _response_headers(headers: dict[str, str], account_name: str) -> dict[str, str]:
    merged = dict(headers)
    merged.pop("content-type", None)
    merged["x-claude-lb-account"] = account_name
    return merged


def _empty_usage():
    from app.modules.proxy.usage_parser import Usage

    return Usage()
