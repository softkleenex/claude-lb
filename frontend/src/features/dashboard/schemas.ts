import { z } from "zod";

/**
 * Shapes of claude-lb's dashboard endpoints (`/api/dashboard/*`, `/api/request-logs*`).
 * The API is snake_case; the api-client camelizes keys before these schemas run.
 */

export const OVERVIEW_TIMEFRAMES = ["1h", "24h", "7d", "30d"] as const;
export type OverviewTimeframe = (typeof OVERVIEW_TIMEFRAMES)[number];
export const DEFAULT_OVERVIEW_TIMEFRAME: OverviewTimeframe = "24h";

export function parseOverviewTimeframe(value: string | null | undefined): OverviewTimeframe {
  return (OVERVIEW_TIMEFRAMES as readonly string[]).includes(value ?? "")
    ? (value as OverviewTimeframe)
    : DEFAULT_OVERVIEW_TIMEFRAME;
}

const DateTimeSchema = z.string();

const MetricsSchema = z.object({
  requests: z.number(),
  errors: z.number(),
  errorRate: z.number(),
  topError: z.string().nullable(),
  topErrorCount: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  totalTokens: z.number(),
  costUsd: z.number(),
  cacheSavingsUsd: z.number(),
  cacheHitRate: z.number(),
  conversations: z.number(),
  avgDurationMs: z.number().nullable(),
  avgTtftMs: z.number().nullable(),
});

const TrendBucketSchema = z.object({
  t: DateTimeSchema,
  requests: z.number(),
  tokens: z.number(),
  costUsd: z.number(),
  cacheSavingsUsd: z.number(),
  cacheHitRate: z.number(),
  errorRate: z.number(),
  conversations: z.number(),
});

export const ModelUsageSchema = z.object({
  model: z.string().nullable(),
  requests: z.number(),
  errors: z.number(),
  errorRate: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  totalTokens: z.number(),
  costUsd: z.number(),
  cacheSavingsUsd: z.number(),
  cacheHitRate: z.number(),
});

export const DashboardOverviewSchema = z.object({
  generatedAt: DateTimeSchema,
  timeframe: z.object({
    key: z.enum(OVERVIEW_TIMEFRAMES),
    windowMinutes: z.number(),
    bucketSeconds: z.number(),
    bucketCount: z.number(),
  }),
  since: DateTimeSchema,
  current: MetricsSchema,
  previous: MetricsSchema,
  canCompare: z.boolean(),
  trends: z.array(TrendBucketSchema),
  byModel: z.array(ModelUsageSchema),
  meta: z.object({
    version: z.string(),
    accountsTotal: z.number(),
    accountsAvailable: z.number(),
    poolRemainingPercent: z.number(),
    routingStrategy: z.string(),
    stickySessionsEnabled: z.boolean(),
    requestLogRetentionDays: z.number(),
    lastRequestAt: DateTimeSchema.nullable(),
  }),
});

const RiskLevelSchema = z.enum(["safe", "warning", "danger", "critical"]);

const WindowAccountSchema = z.object({
  accountId: z.string(),
  accountName: z.string(),
  planType: z.string(),
  capacityCredits: z.number(),
  usedPercent: z.number().nullable(),
  remainingCredits: z.number(),
  resetAt: DateTimeSchema.nullable(),
  windowMinutes: z.number(),
  safeUsedPercent: z.number().nullable(),
  risk: z.number(),
  riskLevel: RiskLevelSchema,
  burnRateCreditsPerHour: z.number(),
  observedAt: DateTimeSchema.nullable(),
});

export const WindowCapacitySchema = z.object({
  capacityCredits: z.number(),
  remainingCredits: z.number(),
  remainingPercent: z.number(),
  safeUsedPercent: z.number().nullable(),
  risk: z.number(),
  riskLevel: RiskLevelSchema,
  burnRateCreditsPerHour: z.number(),
  projectedExhaustionAt: DateTimeSchema.nullable(),
  nextResetAt: DateTimeSchema.nullable(),
  accounts: z.array(WindowAccountSchema),
});

export const WeeklyPaceSchema = z.object({
  totalFullCredits: z.number(),
  totalActualRemainingCredits: z.number(),
  totalExpectedRemainingCredits: z.number(),
  actualUsedPercent: z.number(),
  scheduledUsedPercent: z.number(),
  deltaPercent: z.number(),
  smoothedDeltaPercent: z.number(),
  scheduleGapCredits: z.number(),
  smoothedScheduleGapCredits: z.number(),
  smoothingMinutes: z.number(),
  projectedShortfallCredits: z.number(),
  projectedDepletionHours: z.number().nullable(),
  projectedMinimumRemainingCredits: z.number(),
  forecastBurnRateCreditsPerHour: z.number().nullable(),
  scheduledBurnRateCreditsPerHour: z.number(),
  paceMultiplier: z.number().nullable(),
  pauseForBreakEvenHours: z.number().nullable(),
  throttleToPercent: z.number().nullable(),
  reduceByPercent: z.number().nullable(),
  proAccountEquivalent: z.number().nullable(),
  proAccountsToCover: z.number().nullable(),
  status: z.enum(["behind", "on_track", "ahead", "danger"]),
  accountCount: z.number(),
  staleAccountCount: z.number(),
  inactiveAccountCount: z.number(),
  confidence: z.enum(["high", "medium", "low"]),
});

const ApiAccountSpendSchema = z.object({
  accountId: z.string(),
  accountName: z.string(),
  enabled: z.boolean(),
  available: z.boolean(),
  spendUsd: z.number(),
  spendCapUsd: z.number().nullable(),
  capUsedPercent: z.number().nullable(),
});

export const DashboardProjectionsSchema = z.object({
  generatedAt: DateTimeSchema,
  subscriptionAccounts: z.number(),
  primary: WindowCapacitySchema.nullable(),
  secondary: WindowCapacitySchema.nullable(),
  weeklyPace: WeeklyPaceSchema.nullable(),
  apiAccounts: z.array(ApiAccountSpendSchema),
});

export const UsageTrendPointSchema = z.object({
  day: z.string(),
  requests: z.number(),
  errors: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  costUsd: z.number(),
});
export const UsageTrendSchema = z.array(UsageTrendPointSchema);

// ── Request logs ──

export const REQUEST_STATUSES = [
  "ok",
  "aborted",
  "rate_limited",
  "overloaded",
  "auth_error",
  "client_error",
  "server_error",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const RequestLogSchema = z.object({
  id: z.string(),
  createdAt: DateTimeSchema,
  accountId: z.string().nullable(),
  accountName: z.string().nullable(),
  planType: z.string().nullable(),
  apiKeyId: z.string().nullable(),
  apiKeyName: z.string().nullable(),
  path: z.string(),
  model: z.string().nullable(),
  statusCode: z.number(),
  status: z.string(),
  streaming: z.boolean(),
  durationMs: z.number(),
  ttftMs: z.number().nullable(),
  attempts: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  totalTokens: z.number(),
  costUsd: z.number(),
  cacheSavingsUsd: z.number(),
  error: z.string().nullable(),
  sessionKey: z.string().nullable(),
  userAgent: z.string().nullable(),
  clientIp: z.string().nullable(),
});

export const RequestLogsResponseSchema = z.object({
  requests: z.array(RequestLogSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
});

export const RequestLogDetailSchema = RequestLogSchema.extend({
  costBreakdown: z.object({
    inputUsd: z.number(),
    cacheWriteUsd: z.number(),
    cacheReadUsd: z.number(),
    outputUsd: z.number(),
  }),
  conversation: z
    .object({
      requests: z.number(),
      costUsd: z.number(),
      firstAt: DateTimeSchema.nullable(),
      lastAt: DateTimeSchema.nullable(),
    })
    .nullable(),
});

export const RequestLogFilterOptionsSchema = z.object({
  accounts: z.array(z.object({ id: z.string(), name: z.string() })),
  apiKeys: z.array(z.object({ id: z.string(), name: z.string(), keyHint: z.string() })),
  models: z.array(z.string()),
  statuses: z.array(z.string()),
});

export const REQUEST_LOG_TIMEFRAMES = ["all", "1h", "24h", "7d", "30d"] as const;
export type RequestLogTimeframe = (typeof REQUEST_LOG_TIMEFRAMES)[number];

export const FilterStateSchema = z.object({
  search: z.string(),
  timeframe: z.enum(REQUEST_LOG_TIMEFRAMES),
  accountIds: z.array(z.string()),
  apiKeyIds: z.array(z.string()),
  models: z.array(z.string()),
  statuses: z.array(z.string()),
  sessionKey: z.string().nullable(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

export type DashboardOverview = z.infer<typeof DashboardOverviewSchema>;
export type DashboardMetrics = z.infer<typeof MetricsSchema>;
export type TrendBucket = z.infer<typeof TrendBucketSchema>;
export type ModelUsage = z.infer<typeof ModelUsageSchema>;
export type DashboardProjections = z.infer<typeof DashboardProjectionsSchema>;
export type WindowCapacity = z.infer<typeof WindowCapacitySchema>;
export type WeeklyPace = z.infer<typeof WeeklyPaceSchema>;
export type ApiAccountSpend = z.infer<typeof ApiAccountSpendSchema>;
export type UsageTrendPoint = z.infer<typeof UsageTrendPointSchema>;
export type RequestLog = z.infer<typeof RequestLogSchema>;
export type RequestLogsResponse = z.infer<typeof RequestLogsResponseSchema>;
export type RequestLogDetail = z.infer<typeof RequestLogDetailSchema>;
export type RequestLogFilterOptions = z.infer<typeof RequestLogFilterOptionsSchema>;
export type FilterState = z.infer<typeof FilterStateSchema>;
