/**
 * Report days are UTC calendar days: the server's daily rollups are keyed by UTC date,
 * so presets and the date pickers work in UTC too.
 */

export const MAX_REPORT_DAYS = 366;

export function utcDateISO(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function daysAgoUtcISO(days: number, date: Date = new Date()): string {
  const shifted = new Date(date.getTime());
  shifted.setUTCDate(shifted.getUTCDate() - days);
  return utcDateISO(shifted);
}

export function isISODate(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Inclusive day count, or null when either end is not a valid date. */
export function rangeDays(start: string, end: string): number | null {
  if (!isISODate(start) || !isISODate(end)) return null;
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
}

export type DateRangeProblem = "invalid" | "reversed" | "tooLong" | null;

export function dateRangeProblem(start: string, end: string): DateRangeProblem {
  const days = rangeDays(start, end);
  if (days === null) return "invalid";
  if (days < 1) return "reversed";
  if (days > MAX_REPORT_DAYS) return "tooLong";
  return null;
}

/** "11-26" for chart axes. */
export function shortDay(day: string): string {
  return day.slice(5);
}
