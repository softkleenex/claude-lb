export type Tone = "up" | "down";

/** Percentage change vs the previous window; hidden when it cannot be compared. */
export function compareToPrevious(
  current: number,
  previous: number,
  canCompare: boolean,
): { text: string; tone: Tone } | null {
  if (!canCompare || previous <= 0) return null;
  const delta = ((current - previous) / previous) * 100;
  const rounded = Math.round(Math.abs(delta));
  if (rounded === 0) return null;
  return delta > 0 ? { text: `▲ ${rounded}%`, tone: "up" } : { text: `▼ ${rounded}%`, tone: "down" };
}
