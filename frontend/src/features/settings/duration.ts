import type { TFunction } from "i18next";

/** `900` → "15 min" / "15분". Picks the largest unit that divides evenly. */
export function formatDurationSeconds(seconds: number, t: TFunction): string {
  if (seconds > 0 && seconds % 86400 === 0) return t("settings.duration.days", { count: seconds / 86400 });
  if (seconds > 0 && seconds % 3600 === 0) return t("settings.duration.hours", { count: seconds / 3600 });
  if (seconds > 0 && seconds % 60 === 0) return t("settings.duration.minutes", { count: seconds / 60 });
  return t("settings.duration.seconds", { count: seconds });
}
