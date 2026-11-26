"""Dashboard timeframes: the window length and the sparkline bucket size for each."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta


@dataclass(frozen=True, slots=True)
class Timeframe:
    key: str
    window: timedelta
    bucket: timedelta

    @property
    def bucket_count(self) -> int:
        return int(self.window / self.bucket)


TIMEFRAMES: dict[str, Timeframe] = {
    "1h": Timeframe("1h", timedelta(hours=1), timedelta(minutes=5)),
    "24h": Timeframe("24h", timedelta(hours=24), timedelta(hours=1)),
    "7d": Timeframe("7d", timedelta(days=7), timedelta(hours=6)),
    "30d": Timeframe("30d", timedelta(days=30), timedelta(days=1)),
}
DEFAULT_TIMEFRAME = "24h"
