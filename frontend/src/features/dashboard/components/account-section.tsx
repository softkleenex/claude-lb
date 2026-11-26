import { ArrowDown, ArrowUp, ExternalLink, Pause, Play, Stethoscope } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AccountStatusBadge,
  PlanBadge,
  ProviderIcon,
  RiskBadge,
} from "@/features/accounts/components/account-badges";
import { AccountListItem } from "@/features/accounts/components/account-list-item";
import { UsageBar } from "@/features/accounts/components/account-quota-bars";
import { useNow } from "@/features/accounts/lib/time";
import type { Account } from "@/features/accounts/schemas";
import { ACCOUNT_STATUSES, accountStatus, isSubscription, rateLimitRemainingPercent } from "@/features/accounts/status";
import { formatUsd } from "@/features/dashboard/utils";
import { cn } from "@/lib/utils";
import { formatCompactNumber } from "@/utils/formatters";

export type AccountListSortKey = "name" | "status" | "fiveHour" | "sevenDay" | "cost";
export type AccountListSort = { key: AccountListSortKey; direction: "asc" | "desc" } | null;

export type AccountActions = {
  canWrite: boolean;
  busyId: string | null;
  onToggle: (account: Account) => void;
  onProbe: (account: Account) => void;
};

export function AccountSummaryLine({ accounts }: { accounts: Account[] }) {
  const { t } = useTranslation();
  const active = accounts.filter((account) => account.available).length;
  return (
    <div data-testid="dashboard-account-summary-line" className="flex items-center gap-1.5 whitespace-nowrap text-xs">
      <span className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{active}</span>
      <span className="text-muted-foreground">{t("dashboard.accounts.summary.active")}</span>
      <span className="text-border">·</span>
      <span className="font-semibold tabular-nums text-foreground">{accounts.length}</span>
      <span className="text-muted-foreground">{t("dashboard.accounts.summary.registered")}</span>
      <span className="text-border">·</span>
      <span className="font-semibold tabular-nums text-red-600 dark:text-red-400">{accounts.length - active}</span>
      <span className="text-muted-foreground">{t("dashboard.accounts.summary.unavailable")}</span>
    </div>
  );
}

function QuickActions({ account, actions }: { account: Account; actions: AccountActions }) {
  const { t } = useTranslation();
  const busy = actions.busyId === account.id;
  const paused = account.paused || !account.enabled;
  return (
    <div className="flex items-center gap-1">
      {actions.canWrite ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={busy}
            onClick={() => actions.onToggle(account)}
            aria-label={t(paused ? "dashboard.accounts.resumeAria" : "dashboard.accounts.pauseAria", { name: account.name })}
            title={t(paused ? "accounts.actions.resume" : "accounts.actions.pause")}
          >
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={busy}
            onClick={() => actions.onProbe(account)}
            aria-label={t("dashboard.accounts.probeAria", { name: account.name })}
            title={t("accounts.actions.probe")}
          >
            <Stethoscope className="h-3.5 w-3.5" />
          </Button>
        </>
      ) : null}
      <Button
        asChild
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        title={t("dashboard.accounts.openInAccounts")}
      >
        <Link
          to={`/accounts?selected=${encodeURIComponent(account.id)}`}
          aria-label={t("dashboard.accounts.openAria", { name: account.name })}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </Button>
    </div>
  );
}

export function AccountCards({
  accounts,
  riskById,
  actions,
}: {
  accounts: Account[];
  riskById: Map<string, string>;
  actions: AccountActions;
}) {
  const { t } = useTranslation();
  const now = useNow();
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {accounts.map((account) => (
        <div key={account.id} className="min-w-0 rounded-xl border bg-card" data-testid={`dashboard-account-${account.id}`}>
          <div className="[&>div]:border-0 [&>div]:bg-transparent">
            <AccountListItem account={account} now={now} riskLevel={riskById.get(account.id)} />
          </div>
          <div className="flex items-center justify-between gap-2 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
            <span className="truncate tabular-nums">
              {t("dashboard.accounts.lifetime", {
                requests: formatCompactNumber(account.totalRequests),
                cost: formatUsd(account.totalCostUsd),
              })}
            </span>
            <QuickActions account={account} actions={actions} />
          </div>
        </div>
      ))}
    </div>
  );
}

function sortValue(account: Account, key: AccountListSortKey): number | string {
  switch (key) {
    case "name":
      return account.name.toLowerCase();
    case "status":
      return ACCOUNT_STATUSES.indexOf(accountStatus(account));
    case "fiveHour":
      return account.primaryUsedPercent ?? -1;
    case "sevenDay":
      return account.secondaryUsedPercent ?? -1;
    case "cost":
      return account.totalCostUsd;
  }
}

function sortAccounts(accounts: Account[], sort: AccountListSort): Account[] {
  if (!sort) return accounts;
  const factor = sort.direction === "asc" ? 1 : -1;
  return [...accounts].sort((a, b) => {
    const left = sortValue(a, sort.key);
    const right = sortValue(b, sort.key);
    if (left < right) return -1 * factor;
    if (left > right) return 1 * factor;
    return a.name.localeCompare(b.name);
  });
}

function SortHead({
  label,
  column,
  sort,
  onSortChange,
  className,
}: {
  label: string;
  column: AccountListSortKey;
  sort: AccountListSort;
  onSortChange: (sort: AccountListSort) => void;
  className?: string;
}) {
  const active = sort?.key === column;
  const next: AccountListSort =
    !active ? { key: column, direction: "asc" } : sort.direction === "asc" ? { key: column, direction: "desc" } : null;
  return (
    <TableHead className={cn("text-[11px] uppercase tracking-wider", className)}>
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-foreground"
        onClick={() => onSortChange(next)}
        aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}
      >
        {label}
        {active ? (
          sort.direction === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
        ) : null}
      </button>
    </TableHead>
  );
}

function WindowCell({ used }: { used: number | null }) {
  const { t } = useTranslation();
  return (
    <div className="w-24 space-y-1">
      <div className="text-[11px] tabular-nums">{used === null ? "—" : `${Math.round(used)}%`}</div>
      <UsageBar usedPercent={used} label={t("dashboard.accounts.usedAria")} />
    </div>
  );
}

export function AccountList({
  accounts,
  riskById,
  actions,
  sort,
  onSortChange,
}: {
  accounts: Account[];
  riskById: Map<string, string>;
  actions: AccountActions;
  sort: AccountListSort;
  onSortChange: (sort: AccountListSort) => void;
}) {
  const { t } = useTranslation();
  const sorted = useMemo(() => sortAccounts(accounts, sort), [accounts, sort]);
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <Table className="min-w-[760px]">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <SortHead label={t("dashboard.accounts.columns.account")} column="name" sort={sort} onSortChange={onSortChange} className="pl-4" />
            <SortHead label={t("dashboard.accounts.columns.status")} column="status" sort={sort} onSortChange={onSortChange} />
            <SortHead label={t("accounts.quota.fiveHour")} column="fiveHour" sort={sort} onSortChange={onSortChange} />
            <SortHead label={t("accounts.quota.sevenDay")} column="sevenDay" sort={sort} onSortChange={onSortChange} />
            <SortHead label={t("dashboard.accounts.columns.cost")} column="cost" sort={sort} onSortChange={onSortChange} className="text-right" />
            <TableHead className="pr-4 text-right text-[11px] uppercase tracking-wider">
              {t("dashboard.accounts.columns.actions")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((account) => {
            const risk = riskById.get(account.id);
            const headroom = rateLimitRemainingPercent(account);
            return (
              <TableRow key={account.id} data-testid={`dashboard-account-row-${account.id}`}>
                <TableCell className="pl-4">
                  <div className="flex min-w-0 items-center gap-2">
                    <ProviderIcon account={account} />
                    <span className="truncate font-medium">{account.name}</span>
                    <PlanBadge planType={account.planType} />
                    {risk && risk !== "safe" ? <RiskBadge level={risk} /> : null}
                  </div>
                </TableCell>
                <TableCell>
                  <AccountStatusBadge account={account} />
                </TableCell>
                {isSubscription(account) ? (
                  <>
                    <TableCell><WindowCell used={account.primaryUsedPercent} /></TableCell>
                    <TableCell><WindowCell used={account.secondaryUsedPercent} /></TableCell>
                  </>
                ) : (
                  <TableCell colSpan={2} className="text-[11px] text-muted-foreground">
                    {headroom === null
                      ? t("accounts.quota.notObserved")
                      : t("dashboard.accounts.rateLimitLeft", { percent: Math.round(headroom) })}
                  </TableCell>
                )}
                <TableCell className="text-right text-xs tabular-nums">
                  {formatUsd(account.totalCostUsd)}
                  <div className="text-[11px] text-muted-foreground">
                    {t("dashboard.accounts.requests", { requests: formatCompactNumber(account.totalRequests) })}
                  </div>
                </TableCell>
                <TableCell className="pr-4">
                  <div className="flex justify-end">
                    <QuickActions account={account} actions={actions} />
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
