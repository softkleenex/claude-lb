"""Weekly schedule arithmetic for automations. Pure functions, no I/O.

A schedule is a set of weekdays, a local wall-clock time and an IANA timezone. A *slot*
is one concrete firing: that local time on one of those days, as a UTC instant.

DST: a local time that does not exist (spring forward, e.g. 02:30 in New York) fires at
the same offset as just before the gap — 03:30 local. A local time that happens twice
(fall back) fires once, at the first occurrence. Both follow from building the local
time with ``fold=0`` and converting to UTC.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from functools import lru_cache
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError, available_timezones

WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


class ScheduleError(ValueError):
    pass


@dataclass(frozen=True)
class Schedule:
    days: tuple[str, ...]
    time: str
    timezone: str

    @property
    def zone(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)

    def local_time(self) -> time:
        hour, minute = self.time.split(":")
        return time(int(hour), int(minute))


def parse_days(raw: str | list[str] | tuple[str, ...]) -> tuple[str, ...]:
    items = raw.split(",") if isinstance(raw, str) else list(raw)
    days = {d.strip().lower() for d in items if d.strip()}
    unknown = days - set(WEEKDAYS)
    if unknown:
        raise ScheduleError(f"unknown weekday(s): {', '.join(sorted(unknown))}")
    if not days:
        raise ScheduleError("pick at least one weekday")
    return tuple(d for d in WEEKDAYS if d in days)


def validate(days: list[str] | str, at: str, timezone: str) -> Schedule:
    parsed_days = parse_days(days)
    if not _TIME_RE.match(at or ""):
        raise ScheduleError("time must be HH:MM (24-hour)")
    try:
        ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ScheduleError(f"unknown timezone {timezone!r}") from exc
    if timezone not in _known_zones() and timezone != "UTC":
        raise ScheduleError(f"unknown timezone {timezone!r}")
    return Schedule(days=parsed_days, time=at, timezone=timezone)


@lru_cache(maxsize=1)
def _known_zones() -> frozenset[str]:
    return frozenset(available_timezones())


def slot_on(schedule: Schedule, local_day: date) -> datetime:
    """The UTC instant ``schedule`` fires on ``local_day`` (whether or not it is a scheduled day)."""
    local = datetime.combine(local_day, schedule.local_time(), tzinfo=schedule.zone).replace(fold=0)
    return local.astimezone(UTC)


def _scheduled(schedule: Schedule, local_day: date) -> bool:
    return WEEKDAYS[local_day.weekday()] in schedule.days


def latest_slot(schedule: Schedule, now: datetime) -> tuple[date, datetime] | None:
    """The most recent slot at or before ``now``: ``(local day, UTC instant)``."""
    today = now.astimezone(schedule.zone).date()
    for back in range(0, 8):
        day = today - timedelta(days=back)
        if not _scheduled(schedule, day):
            continue
        instant = slot_on(schedule, day)
        if instant <= now:
            return day, instant
    return None


def next_slot(schedule: Schedule, now: datetime) -> datetime | None:
    """The first slot strictly after ``now``."""
    today = now.astimezone(schedule.zone).date()
    for ahead in range(0, 9):
        day = today + timedelta(days=ahead)
        if not _scheduled(schedule, day):
            continue
        instant = slot_on(schedule, day)
        if instant > now:
            return instant
    return None


def cycle_key(job_id: str, schedule: Schedule, local_day: date) -> str:
    """Identifies one scheduled firing. Includes the time, so moving a job from 07:00 to
    09:00 after it fired at 07:00 still fires at 09:00 the same day."""
    return f"{job_id}:{local_day.isoformat()}T{schedule.time}@{schedule.timezone}"
