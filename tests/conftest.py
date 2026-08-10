from __future__ import annotations

import os
import tempfile
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

# Settings and the Fernet key are cached at import time, so the environment has to be
# pointed at a throwaway data dir before anything under `app.` is imported.
_TMPDIR = tempfile.mkdtemp(prefix="claude-lb-tests-")
os.environ["CLAUDE_LB_DATA_DIR"] = _TMPDIR
os.environ["CLAUDE_LB_DATABASE_URL"] = f"sqlite+aiosqlite:///{Path(_TMPDIR) / 'test.db'}"
os.environ["CLAUDE_LB_REQUIRE_API_KEY"] = "false"
os.environ["CLAUDE_LB_MAX_ATTEMPTS"] = "3"


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(autouse=True)
async def fresh_database() -> AsyncIterator[None]:
    from app.db.models import Base
    from app.db.session import dispose_db, get_engine, init_db

    await init_db()
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    yield
    await dispose_db()


@pytest.fixture
async def proxy_calls() -> list:
    """Collects the requests the proxy sends upstream, for per-test assertions."""
    return []
