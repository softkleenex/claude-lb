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
# CLAUDE_LB_TEST_DATABASE_URL runs the suite against another backend (CI uses it for
# Postgres, where concurrency bugs that SQLite's serialized writes hide do show up).
os.environ["CLAUDE_LB_DATABASE_URL"] = os.environ.get(
    "CLAUDE_LB_TEST_DATABASE_URL", f"sqlite+aiosqlite:///{Path(_TMPDIR) / 'test.db'}"
)
os.environ["CLAUDE_LB_REQUIRE_API_KEY"] = "false"
os.environ["CLAUDE_LB_MAX_ATTEMPTS"] = "3"


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(autouse=True)
async def fresh_database() -> AsyncIterator[None]:
    from claude_lb.db.models import Base
    from claude_lb.db.session import dispose_db, get_engine, init_db
    from claude_lb.modules.auth import service as auth_service

    # The "a password exists" latch is process-global and deliberately one-way, so it
    # has to be cleared between tests along with the database it mirrors.
    auth_service._reset_latch_for_tests()
    auth_service._reset_throttle_for_tests()
    from claude_lb.modules.firewall import service as firewall_service

    firewall_service.invalidate()

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
