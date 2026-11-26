import { z } from "zod";

/** Mirrors `PLAN_TYPES` in `claude_lb/modules/proxy/quota.py` (display order). */
export const PLAN_TYPES = ["api", "free", "pro", "max_5x", "max_20x", "max", "team", "enterprise"] as const;
export type PlanType = (typeof PLAN_TYPES)[number];

/** Plans offered when adding a subscription (no `api`, no legacy `max`). */
export const SUBSCRIPTION_PLAN_TYPES = ["pro", "max_5x", "max_20x", "team", "enterprise", "free"] as const;

export const ROUTING_POLICIES = ["normal", "burn_first", "preserve"] as const;
export const RoutingPolicySchema = z.enum(ROUTING_POLICIES);
export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>;

export const RISK_LEVELS = ["safe", "warning", "danger", "critical"] as const;

const ModelBlockSchema = z.object({
  model: z.string(),
  until: z.string(),
});

/** One element of `GET /api/accounts` (claude-lb `AccountOut`, camelized). */
export const AccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  transport: z.enum(["http", "claude_code"]).default("http"),
  credentialHint: z.string(),
  baseUrl: z.string().nullable(),
  weight: z.number(),
  priority: z.number(),
  enabled: z.boolean(),
  available: z.boolean(),
  headroom: z.number(),
  planType: z.string(),
  routingPolicy: z.string(),
  capacityCredits: z.number().nullable(),
  spendCapUsd: z.number().nullable(),
  blockedModels: z.array(z.string()),
  modelBlocks: z.array(ModelBlockSchema).default([]),
  paused: z.boolean().default(false),
  spendCapReached: z.boolean().default(false),
  consecutiveFailures: z.number().default(0),
  effectiveCapacity: z.number(),
  primaryUsedPercent: z.number().nullable(),
  primaryResetAt: z.string().nullable(),
  secondaryUsedPercent: z.number().nullable(),
  secondaryResetAt: z.string().nullable(),
  unifiedStatus: z.string().nullable(),
  overageStatus: z.string().nullable(),
  quotaStatus: z.string(),
  quotaObservedAt: z.string().nullable(),
  disabledReason: z.string().nullable(),
  cooldownUntil: z.string().nullable(),
  rlRequestsLimit: z.number().nullable(),
  rlRequestsRemaining: z.number().nullable(),
  rlTokensLimit: z.number().nullable(),
  rlTokensRemaining: z.number().nullable(),
  rlResetAt: z.string().nullable(),
  totalRequests: z.number(),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
  totalCostUsd: z.number(),
  lastUsedAt: z.string().nullable(),
  lastProbeAt: z.string().nullable(),
  lastProbeOk: z.boolean().nullable(),
  lastProbeDetail: z.string(),
  modelsSyncedAt: z.string().nullable(),
  authScheme: z.string(),
  credentialExpiresAt: z.string().nullable(),
  lastRefreshAt: z.string().nullable(),
  refreshFailures: z.number(),
  createdAt: z.string(),
});
export type Account = z.infer<typeof AccountSchema>;
export type ModelBlock = z.infer<typeof ModelBlockSchema>;

export const AccountListSchema = z.array(AccountSchema);

export const ProbeResultSchema = z.object({
  ok: z.boolean(),
  statusCode: z.number().nullable(),
  detail: z.string(),
  models: z.number(),
});
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

export const AccountProbeResponseSchema = z.object({
  probe: ProbeResultSchema,
  account: AccountSchema,
});
export type AccountProbeResponse = z.infer<typeof AccountProbeResponseSchema>;

const QuotaTrendPointSchema = z.object({
  t: z.string(),
  primaryUsedPercent: z.number().nullable(),
  secondaryUsedPercent: z.number().nullable(),
});

const UsageTrendDaySchema = z.object({
  day: z.string(),
  requests: z.number(),
  errors: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
});

const UsageWindowTotalsSchema = z.object({
  requests: z.number(),
  errors: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
});

export const AccountTrendsSchema = z.object({
  accountId: z.string(),
  days: z.number(),
  quota: z.array(QuotaTrendPointSchema),
  usage: z.array(UsageTrendDaySchema),
  totals: UsageWindowTotalsSchema,
});
export type AccountTrends = z.infer<typeof AccountTrendsSchema>;
export type QuotaTrendPoint = z.infer<typeof QuotaTrendPointSchema>;
export type UsageTrendDay = z.infer<typeof UsageTrendDaySchema>;

const AccountQuotaSchema = z.object({
  accountId: z.string(),
  accountName: z.string(),
  depletionRisk: z.number(),
  riskLevel: z.string(),
});

/** `GET /api/usage/quota` — only the per-account risk fields the Accounts page reads. */
export const PoolQuotaSchema = z.object({
  totalAccounts: z.number(),
  availableAccounts: z.number(),
  totalCapacityCredits: z.number(),
  remainingCapacityCredits: z.number(),
  poolRemainingPercent: z.number(),
  accounts: z.array(AccountQuotaSchema),
});
export type PoolQuota = z.infer<typeof PoolQuotaSchema>;

/** `POST /api/accounts` body (camelCase; the API client snakifies it). */
export type AccountCreateRequest = {
  name: string;
  apiKey: string;
  provider?: "anthropic_api_key" | "oauth";
  authScheme?: "x-api-key" | "bearer";
  transport?: "http" | "claude_code";
  planType?: string;
  routingPolicy?: RoutingPolicy;
  weight?: number;
  priority?: number;
  spendCapUsd?: number | null;
};

/** `PATCH /api/accounts/{id}` body. Send `spendCapUsd: null` to remove the cap. */
export type AccountUpdateRequest = {
  name?: string;
  enabled?: boolean;
  planType?: string;
  routingPolicy?: RoutingPolicy;
  weight?: number;
  priority?: number;
  spendCapUsd?: number | null;
  transport?: "http" | "claude_code";
};

/** `POST /api/accounts/import` body. `credentials` is sent with its own keys untouched. */
export type AccountImportRequest = {
  name: string;
  credentials: Record<string, unknown>;
  planType?: string;
  routingPolicy?: RoutingPolicy;
  transport?: "http" | "claude_code";
};
