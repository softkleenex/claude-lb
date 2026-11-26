/** "$4.00" per million tokens; sub-cent rates keep their precision ("$0.025", "$0.125"). */
export function formatRate(value: number): string {
  const wholeCents = Math.abs(Math.round(value * 100) - value * 100) < 1e-9;
  return `$${value.toFixed(wholeCents ? 2 : 3)}`;
}
