import { useEffect, useState } from "react";

import i18n from "@/i18n";
import { getTimeFormatPreference } from "@/hooks/use-time-format";
import { parseServerDate } from "@/utils/server-date";

/** A bare duration ("2h 5m", "2시간 5분") with no "in"/"ago"; callers add the direction. */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(1, Math.floor(ms / 60_000));
  if (totalMinutes < 60) return i18n.t("accounts.time.minutes", { count: totalMinutes });
  if (totalMinutes < 1440) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes > 0
      ? i18n.t("accounts.time.hoursMinutes", { hours, minutes })
      : i18n.t("accounts.time.hours", { count: hours });
  }
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? i18n.t("accounts.time.daysHours", { days, hours }) : i18n.t("accounts.time.days", { count: days });
}

/** Current time, re-rendering the caller every `intervalMs` so countdowns tick. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function locale(): string {
  const language = (i18n.resolvedLanguage ?? i18n.language ?? "en").toLowerCase();
  if (language.startsWith("ko")) return "ko-KR";
  if (language.startsWith("zh")) return "zh-CN";
  return "en-US";
}

/** "Nov 26, 14:05" in the UI language and the user's 12/24h preference. */
export function formatAbsolute(value: string | Date | null | undefined): string {
  const date = value instanceof Date ? value : parseServerDate(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat(locale(), {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: getTimeFormatPreference() === "12h" ? "h12" : "h23",
  }).format(date);
}

/** "2h 5m" until `value`, or null when it is unknown or already past. */
export function formatUntil(value: string | Date | null | undefined, now: number): string | null {
  const date = value instanceof Date ? value : parseServerDate(value);
  if (!date) return null;
  const ms = date.getTime() - now;
  return ms > 0 ? formatDuration(ms) : null;
}

/** "5m ago"-style age of a past timestamp, or null. */
export function formatAgo(value: string | null | undefined, now: number): string | null {
  const date = parseServerDate(value);
  if (!date) return null;
  const ms = Math.max(0, now - date.getTime());
  if (ms < 60_000) return i18n.t("accounts.time.justNow");
  return i18n.t("accounts.time.ago", { label: formatDuration(ms) });
}
