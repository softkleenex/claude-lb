import { Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Account } from "@/features/accounts/schemas";
import { AccountListItem } from "@/features/accounts/components/account-list-item";
import {
  ACCOUNT_SORT_MODES,
  filterAccounts,
  sortAccounts,
  type AccountSortMode,
  type AccountStatusFilter,
} from "@/features/accounts/sorting";
import { ACCOUNT_STATUSES } from "@/features/accounts/status";

export type AccountListProps = {
  accounts: Account[];
  now: number;
  selectedAccountId: string | null;
  onSelect: (accountId: string) => void;
  sortMode: AccountSortMode;
  onSortModeChange: (mode: AccountSortMode) => void;
  riskByAccount?: Record<string, string>;
  onAdd?: () => void;
  readOnly?: boolean;
};

export function AccountList({
  accounts,
  now,
  selectedAccountId,
  onSelect,
  sortMode,
  onSortModeChange,
  riskByAccount = {},
  onAdd,
  readOnly = false,
}: AccountListProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<AccountStatusFilter>("all");

  const visible = useMemo(
    () => sortAccounts(filterAccounts(accounts, search, statusFilter), sortMode, now),
    [accounts, search, statusFilter, sortMode, now],
  );

  return (
    <div className="flex max-h-[calc(100dvh-15rem)] min-h-0 min-w-0 flex-1 flex-col space-y-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="relative min-w-0 sm:col-span-2">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60"
            aria-hidden
          />
          <Input
            placeholder={t("accounts.list.searchPlaceholder")}
            aria-label={t("accounts.list.searchPlaceholder")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="h-8 pl-8"
          />
        </div>
        <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as AccountStatusFilter)}>
          <SelectTrigger size="sm" className="w-full min-w-0" aria-label={t("accounts.list.statusFilterAria")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("accounts.list.allStatuses")}</SelectItem>
            {ACCOUNT_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {t(`accounts.status.${status}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sortMode} onValueChange={(value) => onSortModeChange(value as AccountSortMode)}>
          <SelectTrigger size="sm" className="w-full min-w-0" aria-label={t("accounts.list.sortAria")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ACCOUNT_SORT_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {t(`accounts.sort.${mode}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {onAdd ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {t("accounts.list.count", { count: visible.length, total: accounts.length })}
          </p>
          <Button type="button" size="sm" className="gap-1.5" disabled={readOnly} onClick={onAdd}>
            <Plus className="h-3.5 w-3.5" />
            {t("accounts.list.addAccount")}
          </Button>
        </div>
      ) : null}

      <div
        className="min-h-0 flex-1 space-y-1 overflow-y-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        data-testid="account-list-scroll-region"
      >
        {visible.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center">
            <p className="text-sm font-medium text-muted-foreground">
              {accounts.length === 0 ? t("accounts.list.emptyTitle") : t("accounts.list.noMatches")}
            </p>
            <p className="text-xs text-muted-foreground/70">
              {accounts.length === 0 ? t("accounts.list.emptyDescription") : t("accounts.list.adjustFilters")}
            </p>
          </div>
        ) : (
          visible.map((account) => (
            <AccountListItem
              key={account.id}
              account={account}
              now={now}
              selected={account.id === selectedAccountId}
              riskLevel={riskByAccount[account.id] ?? null}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
    </div>
  );
}
