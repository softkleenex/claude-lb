"""Background loop that fires automations, one tick per minute (aligned to the minute)."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable

import httpx

from claude_lb.modules.automations import service

logger = logging.getLogger(__name__)

TICK_SECONDS = 60


class AutomationScheduler:
    def __init__(self, client_getter: Callable[[], httpx.AsyncClient]) -> None:
        self._client_getter = client_getter
        self._task: asyncio.Task | None = None
        self._stopping = asyncio.Event()

    def start(self) -> None:
        self._stopping.clear()
        self._task = asyncio.create_task(self._loop(), name="clb-automations")

    async def stop(self) -> None:
        self._stopping.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: B014 - shutdown is best-effort
                pass
            self._task = None

    async def _loop(self) -> None:
        while not self._stopping.is_set():
            # Sleep to just past the next minute boundary, so a 07:00 slot fires at ~07:00:02.
            await self._sleep(TICK_SECONDS - (time.time() % TICK_SECONDS) + 2)
            if self._stopping.is_set():
                break
            try:
                await service.tick(self._client_getter())
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("automation tick failed")

    async def _sleep(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self._stopping.wait(), timeout=seconds)
        except TimeoutError:
            pass
