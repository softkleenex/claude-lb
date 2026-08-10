from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter(tags=["dashboard"])

_INDEX = Path(__file__).parent / "index.html"


@router.get("/", include_in_schema=False)
async def dashboard() -> HTMLResponse:
    return HTMLResponse(_INDEX.read_text(encoding="utf-8"))
