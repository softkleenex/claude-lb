import type { Account } from "@/features/accounts/schemas";
import {
  accountStatus,
  nextResetAt,
  peakUsedPercent,
  rateLimitRemainingPercent,
  type AccountStatus,
} from "@/features/accounts/status";

export const ACCOUNT_SORT_MODES = ["name", "reset_soonest", "most_remaining"] as const;
export type AccountSortMode = (typeof ACCOUNT_SORT_MODES)[number];
export const DEFAULT_ACCOUNT_SORT_MODE: AccountSortMode = "name";

export type AccountStatusFilter = "all" | AccountStatus;

function byName(a: Account, b: Account): number {
  return a.name.localeCompare(b.name);
}

/** Share of the account's budget left, in percent; unknown counts as full. */
function remainingPercent(account: Account): number {
  const used = peakUsedPercent(account);
  if (used !== null) return Math.max(0, 100 - used);
  return rateLimitRemainingPercent(account) ?? 100;
}

export function sortAccounts(accounts: Account[], mode: AccountSortMode, now = Date.now()): Account[] {
  const sorted = [...accounts];
  if (mode === "reset_soonest") {
    sorted.sort((a, b) => {
      const left = nextResetAt(a, now);
      const right = nextResetAt(b, now);
      if (left === right) return byName(a, b);
      if (left === null) return 1;
      if (right === null) return -1;
      return left - right;
    });
  } else if (mode === "most_remaining") {
    sorted.sort((a, b) => {
      // Accounts that can take traffic now come first; remaining quota orders within.
      if (a.available !== b.available) return a.available ? -1 : 1;
      return remainingPercent(b) - remainingPercent(a) || byName(a, b);
    });
  } else {
    sorted.sort(byName);
  }
  return sorted;
}

export function filterAccounts(accounts: Account[], search: string, status: AccountStatusFilter): Account[] {
  const needle = search.trim().toLowerCase();
  return accounts.filter((account) => {
    if (status !== "all" && accountStatus(account) !== status) return false;
    if (!needle) return true;
    return [account.name, account.planType, account.routingPolicy, account.credentialHint, account.id].some(
      (value) => value.toLowerCase().includes(needle),
    );
  });
}
