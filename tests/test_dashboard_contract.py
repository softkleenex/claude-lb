"""Guards the React dashboard against calling API paths the backend does not route.

Field-level drift is caught on the frontend side: every response is validated by a zod
schema and the MSW mocks mirror the FastAPI handlers. What neither side sees is a
backend router being renamed or dropped, so this reads every ``/api/...`` path literal
out of ``frontend/src`` and checks that the app routes something under it.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from claude_lb.main import create_app

FRONTEND_SRC = Path(__file__).resolve().parent.parent / "frontend" / "src"

# "/api/x", '/api/x' or `/api/x...` — cut at the first interpolation, query or wildcard.
_PATH_LITERAL = re.compile(r"""["'`](/api/[A-Za-z0-9_./\-]*)""")


def _frontend_api_paths() -> set[str]:
    paths: set[str] = set()
    for file in FRONTEND_SRC.rglob("*.ts*"):
        if ".test." in file.name or "/test/" in file.as_posix():
            continue
        for raw in _PATH_LITERAL.findall(file.read_text(encoding="utf-8")):
            path = raw.rstrip("/.")
            if path and path != "/api":
                paths.add(path)
    return paths


@pytest.mark.skipif(not FRONTEND_SRC.is_dir(), reason="frontend sources are not part of this checkout")
def test_every_api_path_the_dashboard_calls_is_routed():
    paths = _frontend_api_paths()
    assert len(paths) > 15, f"too few API paths found ({sorted(paths)}) — did the extraction break?"

    routed = [path for path in create_app().openapi()["paths"] if path.startswith("/api/")]
    # A literal like `/api/accounts` (followed by `/${id}` in the source) only has to be
    # a prefix of a real route; path parameters are never part of the literal.
    missing = sorted(path for path in paths if not any(r == path or r.startswith(path + "/") for r in routed))
    assert not missing, f"dashboard calls unrouted API path(s): {missing}"


def test_the_built_dashboard_is_packaged():
    """`uv run claude-lb serve` must work without Node, so the build output is committed."""
    from claude_lb.modules.dashboard.api import STATIC_DIR

    index = STATIC_DIR / "index.html"
    assert index.is_file(), "run `cd frontend && npm ci && npm run build` and commit the output"
    html = index.read_text(encoding="utf-8")
    assert "<title>Claude LB</title>" in html
    assets = re.findall(r'(?:src|href)="/(assets/[^"]+)"', html)
    assert assets, "index.html references no hashed assets"
    for asset in assets:
        assert (STATIC_DIR / asset).is_file(), f"index.html references a missing file: {asset}"
