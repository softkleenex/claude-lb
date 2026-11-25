import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { get } from "@/lib/api-client";
import { parseServerDate } from "@/utils/server-date";

/**
 * The few `/api/accounts` fields the app shell needs (nav badge, usage-sync
 * freshness). Loose on purpose so the shell does not depend on the full account
 * schema that the Accounts page owns.
 */
const PoolAccountSchema = z.looseObject({
  id: z.string(),
  enabled: z.boolean(),
  available: z.boolean(),
  quotaObservedAt: z.string().nullable().optional(),
});

const PoolAccountsSchema = z.array(PoolAccountSchema);

export type PoolStatus = {
  total: number;
  available: number;
  /** Newest `quota_observed_at` across accounts (ms since epoch), or null if never observed. */
  lastQuotaObservedAt: number | null;
};

export function summarizePool(accounts: z.infer<typeof PoolAccountsSchema>): PoolStatus {
  let lastQuotaObservedAt: number | null = null;
  for (const account of accounts) {
    const observed = parseServerDate(account.quotaObservedAt)?.getTime() ?? null;
    if (observed !== null && (lastQuotaObservedAt === null || observed > lastQuotaObservedAt)) {
      lastQuotaObservedAt = observed;
    }
  }
  return {
    total: accounts.length,
    available: accounts.filter((account) => account.available).length,
    lastQuotaObservedAt,
  };
}

export function getPoolStatus() {
  return get("/api/accounts", PoolAccountsSchema).then(summarizePool);
}

export const POOL_STATUS_QUERY_KEY = ["accounts", "pool-status"] as const;

export function usePoolStatus() {
  return useQuery({
    queryKey: POOL_STATUS_QUERY_KEY,
    queryFn: getPoolStatus,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    staleTime: 15_000,
  });
}
