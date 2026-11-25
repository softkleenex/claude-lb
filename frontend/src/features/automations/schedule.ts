import type { TFunction } from "i18next";

import { WEEKDAYS, type Weekday } from "@/features/automations/schemas";

const WEEKDAY_SET = "mon,tue,wed,thu,fri";
const WEEKEND_SET = "sat,sun";

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** IANA zones the browser knows (for the picker), with UTC first. */
export function timezoneOptions(current: string): string[] {
  let zones: string[];
  try {
    zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  const all = new Set(["UTC", browserTimezone(), current, ...zones]);
  return [...all].filter(Boolean).sort((a, b) => (a === "UTC" ? -1 : b === "UTC" ? 1 : a.localeCompare(b)));
}

export function sortDays(days: Weekday[]): Weekday[] {
  return WEEKDAYS.filter((day) => days.includes(day));
}

export function formatDays(days: Weekday[], t: TFunction): string {
  const key = sortDays(days).join(",");
  if (days.length === 7) return t("automations.schedule.everyDay");
  if (key === WEEKDAY_SET) return t("automations.schedule.weekdays");
  if (key === WEEKEND_SET) return t("automations.schedule.weekends");
  return sortDays(days)
    .map((day) => t(`automations.days.${day}`))
    .join(", ");
}

/** "Weekdays at 07:00 (Asia/Seoul)" */
export function formatSchedule(schedule: { days: Weekday[]; time: string; timezone: string }, t: TFunction): string {
  return t("automations.schedule.summary", {
    days: formatDays(schedule.days, t),
    time: schedule.time,
    timezone: schedule.timezone,
  });
}

/** When the 5-hour window started at `time` resets, as local "HH:MM". */
export function windowResetTime(time: string): string | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const minutes = (Number(match[1]) * 60 + Number(match[2]) + 5 * 60) % (24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
