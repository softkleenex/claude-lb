"""Serves the dashboard single-page app.

The React build (``frontend/`` -> ``static/``) is committed, so a plain install serves
it without Node. Hashed files under ``/assets`` are cached for a year; every other
non-API GET falls back to ``index.html`` so client-side routes (``/accounts``) work on
reload. Without a build, the legacy single-file dashboard is served instead.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.routing import APIRoute
from starlette.routing import Match
from starlette.types import Scope

_HERE = Path(__file__).parent
STATIC_DIR = _HERE / "static"
LEGACY_INDEX = _HERE / "index.html"

# First path segments that belong to the API/proxy, never to the SPA. A miss under
# these must stay a 404 rather than turn into an HTML page a client would misparse.
_RESERVED_SEGMENTS = frozenset({"api", "v1", "health", "metrics", "docs", "redoc", "openapi.json"})


class _SpaRoute(APIRoute):
    """Never matches reserved paths, so they keep their normal 404/405 handling.

    Raising 404 from the handler instead would turn a GET on a POST-only API route
    from 405 into 404, because a full match here outranks the router's partial one.
    """

    def matches(self, scope: Scope) -> tuple[Match, dict[str, Any]]:
        if scope["type"] == "http" and scope["path"].lstrip("/").split("/", 1)[0] in _RESERVED_SEGMENTS:
            return Match.NONE, {}
        return super().matches(scope)


router = APIRouter(tags=["dashboard"], route_class=_SpaRoute)

_NO_CACHE = {"Cache-Control": "no-cache"}
_IMMUTABLE = {"Cache-Control": "public, max-age=31536000, immutable"}
_SHORT_CACHE = {"Cache-Control": "public, max-age=3600"}


def _static_file(relative: str) -> Path | None:
    """Resolve ``relative`` inside the build directory, refusing anything that escapes it."""
    root = STATIC_DIR.resolve()
    candidate = (root / relative).resolve()
    if not candidate.is_relative_to(root) or not candidate.is_file():
        return None
    return candidate


def _index_response() -> Response:
    built = STATIC_DIR / "index.html"
    if built.is_file():
        return FileResponse(built, media_type="text/html", headers=_NO_CACHE)
    return HTMLResponse(LEGACY_INDEX.read_text(encoding="utf-8"), headers=_NO_CACHE)


@router.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
async def dashboard() -> Response:
    return _index_response()


@router.api_route("/{full_path:path}", methods=["GET", "HEAD"], include_in_schema=False)
async def dashboard_spa(full_path: str) -> Response:
    file = _static_file(full_path) if full_path else None
    if file is not None:
        headers = _IMMUTABLE if full_path.startswith("assets/") else _SHORT_CACHE
        return FileResponse(file, headers=headers)
    if full_path.startswith("assets/"):
        # A stale hashed URL must 404; serving index.html as JS breaks the page silently.
        raise HTTPException(status_code=404, detail="Not Found")
    return _index_response()
