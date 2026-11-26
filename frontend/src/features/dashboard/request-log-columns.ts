export const REQUEST_LOG_COLUMN_OPTIONS = [
  { id: "time", translationKey: "dashboard.requests.columns.time" },
  { id: "account", translationKey: "dashboard.requests.columns.account" },
  { id: "plan", translationKey: "dashboard.requests.columns.plan" },
  { id: "apiKey", translationKey: "dashboard.requests.columns.apiKey" },
  { id: "model", translationKey: "dashboard.requests.columns.model" },
  { id: "status", translationKey: "dashboard.requests.columns.status" },
  { id: "latency", translationKey: "dashboard.requests.columns.latency" },
  { id: "ttft", translationKey: "dashboard.requests.columns.ttft" },
  { id: "tokens", translationKey: "dashboard.requests.columns.tokens" },
  { id: "cost", translationKey: "dashboard.requests.columns.cost" },
  { id: "attempts", translationKey: "dashboard.requests.columns.attempts" },
  { id: "details", translationKey: "dashboard.requests.columns.details" },
] as const;

export type RequestLogColumnId = (typeof REQUEST_LOG_COLUMN_OPTIONS)[number]["id"];

export const ALL_REQUEST_LOG_COLUMNS: readonly RequestLogColumnId[] =
  REQUEST_LOG_COLUMN_OPTIONS.map((column) => column.id);

/** Plan and attempts are off by default; everything else shows. */
export const DEFAULT_REQUEST_LOG_COLUMNS: readonly RequestLogColumnId[] = ALL_REQUEST_LOG_COLUMNS.filter(
  (column) => column !== "plan" && column !== "attempts",
);

export const MIN_REQUEST_LOG_COLUMN_WIDTH = 64;
export const MAX_REQUEST_LOG_COLUMN_WIDTH = 720;
export const REQUEST_LOG_COLUMN_WIDTH_STEP = 8;

export type RequestLogColumnWidths = Partial<Record<RequestLogColumnId, number>>;

export const REQUEST_LOG_COLUMN_DEFAULT_WIDTHS: Record<RequestLogColumnId, number> = {
  time: 112,
  account: 150,
  plan: 96,
  apiKey: 140,
  model: 176,
  status: 120,
  latency: 80,
  ttft: 80,
  tokens: 104,
  cost: 88,
  attempts: 72,
  details: 240,
};

export function clampRequestLogColumnWidth(width: number): number {
  return Math.round(
    Math.max(MIN_REQUEST_LOG_COLUMN_WIDTH, Math.min(MAX_REQUEST_LOG_COLUMN_WIDTH, width)),
  );
}
