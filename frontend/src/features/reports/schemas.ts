import { z } from "zod";

/** Wire shapes of `GET /api/reports` (snake_case on the wire, camelized by the api client). */

export const REPORT_GROUPINGS = ["day", "account", "api_key", "model", "user_agent"] as const;
export type ReportGrouping = (typeof REPORT_GROUPINGS)[number];

const TotalsSchema = z.object({
  requests: z.number(),
  errors: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  totalTokens: z.number(),
  costUsd: z.number(),
  cacheSavingsUsd: z.number(),
});

const DailyPointSchema = TotalsSchema.extend({
  day: z.string(),
  aborted: z.number(),
  conversations: z.number(),
  medianTtftMs: z.number().nullable(),
  medianTps: z.number().nullable(),
});

const DistributionEntrySchema = z.object({
  key: z.string().nullable(),
  label: z.string(),
  costUsd: z.number(),
  totalTokens: z.number(),
  requests: z.number(),
});

const BreakdownRowSchema = TotalsSchema.extend({
  key: z.string().nullable(),
  label: z.string(),
  cacheHitRate: z.number(),
});

const SummarySchema = z.object({
  totalCostUsd: z.number(),
  avgCostPerDay: z.number(),
  requests: z.number(),
  avgRequestsPerDay: z.number(),
  errors: z.number(),
  errorRate: z.number(),
  aborted: z.number(),
  accountsUsed: z.number(),
  conversations: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  totalTokens: z.number(),
  cacheSavingsUsd: z.number(),
  cacheHitRate: z.number(),
  medianTtftMs: z.number().nullable(),
  medianTps: z.number().nullable(),
});

const PreviousSchema = z.object({
  start: z.string(),
  end: z.string(),
  canCompare: z.boolean(),
  totalCostUsd: z.number(),
  requests: z.number(),
  totalTokens: z.number(),
  errors: z.number(),
  cacheSavingsUsd: z.number(),
});

export const ReportSchema = z.object({
  start: z.string(),
  end: z.string(),
  days: z.number(),
  groupBy: z.enum(REPORT_GROUPINGS),
  source: z.enum(["rollups", "request_logs"]),
  coverage: z.object({
    retentionDays: z.number(),
    logsFrom: z.string(),
    logsTruncated: z.boolean(),
  }),
  summary: SummarySchema,
  previous: PreviousSchema,
  daily: z.array(DailyPointSchema),
  byModel: z.array(DistributionEntrySchema),
  byUserAgent: z.array(DistributionEntrySchema),
  breakdown: z.array(BreakdownRowSchema),
  breakdownTotal: TotalsSchema.extend({ cacheHitRate: z.number() }),
});

export const ReportOptionsSchema = z.object({
  accounts: z.array(z.object({ id: z.string(), name: z.string() })),
  apiKeys: z.array(z.object({ id: z.string(), name: z.string(), keyHint: z.string() })),
  models: z.array(z.string()),
  userAgents: z.array(z.string()),
});

export type Report = z.infer<typeof ReportSchema>;
export type ReportSummary = z.infer<typeof SummarySchema>;
export type ReportPrevious = z.infer<typeof PreviousSchema>;
export type DailyPoint = z.infer<typeof DailyPointSchema>;
export type DistributionEntry = z.infer<typeof DistributionEntrySchema>;
export type BreakdownRow = z.infer<typeof BreakdownRowSchema>;
export type BreakdownTotal = Report["breakdownTotal"];
export type ReportOptions = z.infer<typeof ReportOptionsSchema>;

/** Filters as held in the URL and sent to the API. */
export type ReportFilters = {
  start: string;
  end: string;
  groupBy: ReportGrouping;
  accountIds: string[];
  apiKeyIds: string[];
  models: string[];
  userAgents: string[];
};
