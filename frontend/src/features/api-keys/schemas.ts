import { z } from "zod";

/** What a limit rule counts. Input tokens include cache reads and writes; total = input + output. */
export const LIMIT_METRICS = ["requests", "total_tokens", "input_tokens", "output_tokens", "cost_usd"] as const;
/** 5h / 7d / custom are rolling; daily / weekly / monthly are UTC calendar periods. */
export const LIMIT_WINDOWS = ["5h", "7d", "daily", "weekly", "monthly", "custom"] as const;

export type LimitMetric = (typeof LIMIT_METRICS)[number];
export type LimitWindow = (typeof LIMIT_WINDOWS)[number];

const dateTime = z.string();

export const LimitUsageSchema = z.object({
  id: z.string(),
  source: z.enum(["rule", "legacy"]),
  metric: z.enum(LIMIT_METRICS),
  window: z.enum(LIMIT_WINDOWS),
  windowSeconds: z.number().int(),
  maxValue: z.number(),
  modelFilter: z.string().nullable(),
  currentValue: z.number(),
  remaining: z.number(),
  usedPercent: z.number(),
  windowStart: dateTime,
  resetsAt: dateTime.nullable(),
});

export const ApiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  keyHint: z.string(),
  enabled: z.boolean(),
  status: z.enum(["active", "disabled", "expired"]),
  expiresAt: dateTime.nullable(),
  maxRequestsPerWindow: z.number().nullable(),
  maxTokensPerWindow: z.number().nullable(),
  maxCostUsdPerWindow: z.number().nullable(),
  windowSeconds: z.number().int(),
  pinnedAccountId: z.string().nullable(),
  allowedModels: z.array(z.string()).nullable(),
  enforcedModel: z.string().nullable(),
  assignedAccountIds: z.array(z.string()).nullable(),
  limits: z.array(LimitUsageSchema),
  totalRequests: z.number().int(),
  totalCostUsd: z.number(),
  totalTokens: z.number().int(),
  lifetimeRequests: z.number().int(),
  lifetimeCostUsd: z.number(),
  lastUsedAt: dateTime.nullable(),
  createdAt: dateTime,
});

export const ApiKeyCreatedSchema = ApiKeySchema.extend({ apiKey: z.string() });
export const ApiKeyListSchema = z.array(ApiKeySchema);

/** A rule as the editor holds it and the API accepts it. Cost is in USD. */
export const LimitRuleInputSchema = z.object({
  metric: z.enum(LIMIT_METRICS),
  window: z.enum(LIMIT_WINDOWS),
  maxValue: z.number().positive(),
  windowSeconds: z.number().int().min(60).nullable().optional(),
  modelFilter: z.string().nullable().optional(),
});

const policyFields = {
  allowedModels: z.array(z.string()).nullable().optional(),
  enforcedModel: z.string().nullable().optional(),
  assignedAccountIds: z.array(z.string()).nullable().optional(),
  limits: z.array(LimitRuleInputSchema).optional(),
  expiresAt: dateTime.nullable().optional(),
};

export const ApiKeyCreateRequestSchema = z.object({
  name: z.string().min(1).max(128),
  ...policyFields,
});

export const ApiKeyUpdateRequestSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  enabled: z.boolean().optional(),
  pinnedAccountId: z.string().nullable().optional(),
  ...policyFields,
});

export type LimitUsage = z.infer<typeof LimitUsageSchema>;
export type ApiKey = z.infer<typeof ApiKeySchema>;
export type ApiKeyCreated = z.infer<typeof ApiKeyCreatedSchema>;
export type LimitRuleInput = z.infer<typeof LimitRuleInputSchema>;
export type ApiKeyCreateRequest = z.infer<typeof ApiKeyCreateRequestSchema>;
export type ApiKeyUpdateRequest = z.infer<typeof ApiKeyUpdateRequestSchema>;

/** `GET /api/health/models`: the union of every account's model catalog. */
export const CatalogModelSchema = z.object({
  modelId: z.string(),
  displayName: z.string(),
  accounts: z.number().int(),
});
export const CatalogModelListSchema = z.array(CatalogModelSchema);
export type CatalogModel = z.infer<typeof CatalogModelSchema>;

export const KeyUsageRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  keyHint: z.string(),
  requests: z.number().int(),
  totalTokens: z.number().int(),
  costUsd: z.number(),
});

export const KeysOverviewSchema = z.object({
  total: z.number().int(),
  active: z.number().int(),
  disabled: z.number().int(),
  expired: z.number().int(),
  idle: z.number().int(),
  usedLast7d: z.number().int(),
  lifetimeRequests: z.number().int(),
  lifetimeCostUsd: z.number(),
  lifetimeTokens: z.number().int(),
  byKey: z.array(KeyUsageRowSchema),
});
export type KeyUsageRow = z.infer<typeof KeyUsageRowSchema>;
export type KeysOverview = z.infer<typeof KeysOverviewSchema>;

const tokenTotals = {
  requests: z.number().int(),
  errors: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheReadInputTokens: z.number().int(),
  cacheCreationInputTokens: z.number().int(),
  totalTokens: z.number().int(),
  costUsd: z.number(),
};

export const KeyTrendsSchema = z.object({
  keyId: z.string(),
  days: z.number().int(),
  usage: z.array(z.object({ day: z.string(), ...tokenTotals })),
  totals: z.object(tokenTotals),
  byAccount: z.array(
    z.object({
      accountId: z.string().nullable(),
      accountName: z.string().nullable(),
      planType: z.string().nullable(),
      deleted: z.boolean(),
      requests: z.number().int(),
      totalTokens: z.number().int(),
      costUsd: z.number(),
    }),
  ),
  byModel: z.array(
    z.object({
      model: z.string().nullable(),
      requests: z.number().int(),
      totalTokens: z.number().int(),
      costUsd: z.number(),
    }),
  ),
});
export type KeyTrends = z.infer<typeof KeyTrendsSchema>;
export type KeyTrendDay = KeyTrends["usage"][number];
export type KeyAccountCost = KeyTrends["byAccount"][number];
