/**
 * LEGACY codex-lb account summary shape, still consumed by the codex-lb dashboard
 * overview (`/api/dashboard/overview`) until Step D rewrites the Dashboard page on
 * claude-lb APIs. Do not use for new code — the Accounts page uses
 * `@/features/accounts/schemas` (claude-lb's `/api/accounts`).
 */
import { z } from "zod";

const AccountUsageSchema = z.object({
  primaryRemainingPercent: z.number().nullable(),
  secondaryRemainingPercent: z.number().nullable(),
  monthlyRemainingPercent: z.number().nullable().optional(),
});

const AccountRequestUsageSchema = z.object({
  requestCount: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  totalCostUsd: z.number().nonnegative(),
});

const AccountTokenStatusSchema = z.object({
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  state: z.string().nullable().optional(),
});

const AccountAuthSchema = z.object({
  access: AccountTokenStatusSchema.nullable().optional(),
  refresh: AccountTokenStatusSchema.nullable().optional(),
  idToken: AccountTokenStatusSchema.nullable().optional(),
});

const AccountLimitWarmupStatusSchema = z.object({
  window: z.enum(["primary", "secondary"]).or(z.string()),
  resetAt: z.number().int(),
  status: z.string(),
  model: z.string(),
  attemptedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  errorCode: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
});

const AccountAdditionalWindowSchema = z.object({
  usedPercent: z.number(),
  resetAt: z.number().nullable().optional(),
  windowMinutes: z.number().nullable().optional(),
});

export const AccountAdditionalQuotaSchema = z.object({
  quotaKey: z.string().nullable().optional(),
  limitName: z.string(),
  meteredFeature: z.string(),
  displayLabel: z.string().nullable().optional(),
  routingPolicy: z.enum(["inherit", "normal", "burn_first", "preserve"]).nullable().optional(),
  primaryWindow: AccountAdditionalWindowSchema.nullable().optional(),
  secondaryWindow: AccountAdditionalWindowSchema.nullable().optional(),
});

export const AccountSummarySchema = z.object({
  accountId: z.string(),
  chatgptAccountId: z.string().nullable().optional(),
  email: z.string(),
  alias: z.string().nullable().optional(),
  displayName: z.string(),
  workspaceId: z.string().nullable().optional(),
  workspaceLabel: z.string().nullable().optional(),
  seatType: z.string().nullable().optional(),
  planType: z.string(),
  routingPolicy: z.enum(["normal", "burn_first", "preserve"]).optional(),
  status: z.string(),
  securityWorkAuthorized: z.boolean().optional(),
  usage: AccountUsageSchema.nullable().optional(),
  resetAtPrimary: z.iso.datetime({ offset: true }).nullable().optional(),
  resetAtSecondary: z.iso.datetime({ offset: true }).nullable().optional(),
  resetAtMonthly: z.iso.datetime({ offset: true }).nullable().optional(),
  windowMinutesPrimary: z.number().nullable().optional(),
  windowMinutesSecondary: z.number().nullable().optional(),
  windowMinutesMonthly: z.number().nullable().optional(),
  capacityCreditsPrimary: z.number().nullable().optional(),
  remainingCreditsPrimary: z.number().nullable().optional(),
  capacityCreditsSecondary: z.number().nullable().optional(),
  remainingCreditsSecondary: z.number().nullable().optional(),
  capacityCreditsMonthly: z.number().nullable().optional(),
  remainingCreditsMonthly: z.number().nullable().optional(),
  creditsHas: z.boolean().nullable().optional(),
  creditsUnlimited: z.boolean().nullable().optional(),
  creditsBalance: z.number().nullable().optional(),
  requestUsage: AccountRequestUsageSchema.nullable().optional(),
  auth: AccountAuthSchema.nullable().optional(),
  additionalQuotas: z.array(AccountAdditionalQuotaSchema).default([]),
  limitWarmupEnabled: z.boolean().default(false),
  limitWarmup: AccountLimitWarmupStatusSchema.nullable().optional(),
  isEmailDuplicate: z.boolean().optional(),
  availableResetCredits: z.number().nullable().optional(),
  resetCreditNearestExpiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
});

export type AccountSummary = z.infer<typeof AccountSummarySchema>;
export type AccountAdditionalQuota = z.infer<typeof AccountAdditionalQuotaSchema>;
