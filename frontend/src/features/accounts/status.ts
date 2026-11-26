import type { Account } from "@/features/accounts/schemas";
import { parseServerDate } from "@/utils/server-date";

/**
 * Why an account is or is not taking traffic, most decisive reason first. Mirrors
 * `is_available` / `explain_unavailable` in the backend.
 */
export const ACCOUNT_STATUSES = [
  "available",
  "cooling_down",
  "rate_limited",
  "quota_exceeded",
  "spend_cap",
  "paused",
  "disabled",
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export function accountStatus(account: Account): AccountStatus {
  if (account.paused) return "paused";
  if (!account.enabled) return "disabled";
  if (account.spendCapReached) return "spend_cap";
  if (account.available) return "available";
  if (account.quotaStatus === "quota_exceeded") return "quota_exceeded";
  if (account.quotaStatus === "rate_limited") return "rate_limited";
  return "cooling_down";
}

/** When the current status is expected to lift on its own, or null if it will not. */
export function statusLiftsAt(account: Account): Date | null {
  switch (accountStatus(account)) {
    case "rate_limited":
      return parseServerDate(account.primaryResetAt) ?? parseServerDate(account.cooldownUntil);
    case "quota_exceeded":
      return parseServerDate(account.secondaryResetAt) ?? parseServerDate(account.cooldownUntil);
    case "cooling_down":
      return parseServerDate(account.cooldownUntil);
    default:
      return null;
  }
}

export function isSubscription(account: Pick<Account, "planType" | "authScheme" | "provider">): boolean {
  return account.planType !== "api" || account.provider === "oauth" || account.authScheme === "bearer";
}

/** The higher of the two utilization windows, or null if none has been observed. */
export function peakUsedPercent(account: Account): number | null {
  const values = [account.primaryUsedPercent, account.secondaryUsedPercent].filter(
    (value): value is number => value !== null,
  );
  return values.length > 0 ? Math.max(...values) : null;
}

/** Percent of standard rate-limit headroom left (API keys), or null if never observed. */
export function rateLimitRemainingPercent(account: Account): number | null {
  const fractions: number[] = [];
  if (account.rlRequestsLimit && account.rlRequestsRemaining !== null) {
    fractions.push(account.rlRequestsRemaining / account.rlRequestsLimit);
  }
  if (account.rlTokensLimit && account.rlTokensRemaining !== null) {
    fractions.push(account.rlTokensRemaining / account.rlTokensLimit);
  }
  if (fractions.length === 0) return null;
  return Math.max(0, Math.min(100, Math.min(...fractions) * 100));
}

/** Next 5h/7d reset in the future, for "reset soonest" ordering. */
export function nextResetAt(account: Account, now = Date.now()): number | null {
  const candidates = [account.primaryResetAt, account.secondaryResetAt]
    .map((value) => parseServerDate(value)?.getTime() ?? null)
    .filter((value): value is number => value !== null && value > now);
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

export function usageTone(usedPercent: number): "ok" | "warn" | "high" {
  if (usedPercent >= 85) return "high";
  if (usedPercent >= 60) return "warn";
  return "ok";
}
