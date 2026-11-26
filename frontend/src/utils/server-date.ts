const HAS_TIMEZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parses a timestamp from claude-lb. SQLite hands back naive datetimes, which the API
 * serialises without an offset even though they are UTC; treat those as UTC instead of
 * letting `Date` read them as local time.
 */
export function parseServerDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const normalized = HAS_TIMEZONE.test(value) ? value : `${value}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}
