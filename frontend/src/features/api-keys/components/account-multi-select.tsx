import { useCallback, useMemo, useState } from "react";
import { ChevronsUpDown, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { AccountStatusBadge } from "@/features/accounts/components/account-badges";
import { useAccounts } from "@/features/accounts/hooks/use-accounts";
import type { Account } from "@/features/accounts/schemas";
import { cn } from "@/lib/utils";
import { formatPercentNullable } from "@/utils/formatters";

export type AccountMultiSelectProps = {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  triggerId?: string;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
  triggerClassName?: string;
  allowPausedAccounts?: boolean;
};
type LimitChip = {
  key: string;
  label: string;
  /** Percent left, for the chip colour. */
  percent: number | null;
};

function buildLimitChips(account: Account, t: ReturnType<typeof useTranslation>["t"]): LimitChip[] {
  const chips: LimitChip[] = [];
  const windows: Array<[string, string, number | null]> = [
    ["primary", t("accounts.quota.fiveHour"), account.primaryUsedPercent],
    ["secondary", t("accounts.quota.sevenDay"), account.secondaryUsedPercent],
  ];
  for (const [key, label, used] of windows) {
    if (used === null) continue;
    const left = Math.max(0, 100 - used);
    chips.push({
      key: `${account.id}-${key}`,
      label: t("apiKeys.accountSelect.limitLeft", { label, percent: formatPercentNullable(left) }),
      percent: left,
    });
  }
  return chips;
}

function chipToneClass(percent: number | null): string {
  if (percent === null) {
    return "border-border bg-muted text-muted-foreground";
  }

  if (percent >= 70) {
    return "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (percent >= 30) {
    return "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  return "border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300";
}

function AccountOption({ account }: { account: Account }) {
  const { t } = useTranslation();
  const limitChips = buildLimitChips(account, t);

  return (
    <div className="min-w-0 flex-1 py-0.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{account.name}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {t(`accounts.plans.${account.planType}`, { defaultValue: account.planType })}
          </div>
        </div>
        <AccountStatusBadge account={account} />
      </div>

      <div className="mt-1.5 flex flex-wrap gap-1">
        {limitChips.map((chip) => (
          <span
            key={chip.key}
            className={cn(
              "rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none",
              chipToneClass(chip.percent),
            )}
          >
            {chip.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function AccountMultiSelect({
  value,
  onChange,
  placeholder,
  triggerId,
  ariaInvalid = false,
  ariaDescribedBy,
  triggerClassName,
  allowPausedAccounts = false,
}: AccountMultiSelectProps) {
  const { t } = useTranslation();
  const placeholderLabel = placeholder ?? t("apiKeys.accountSelect.all");
  const accountsQuery = useAccounts();
  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const selectableAccounts = useMemo(
    () =>
      accounts.filter((account) => account.enabled || (allowPausedAccounts && account.paused)),
    [accounts, allowPausedAccounts],
  );
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search.trim()) return selectableAccounts;
    const query = search.toLowerCase();
    return selectableAccounts.filter(
      (account) => account.id.toLowerCase().includes(query) || account.name.toLowerCase().includes(query),
    );
  }, [search, selectableAccounts]);

  const selectedSet = useMemo(() => new Set(value), [value]);
  const selectedAccounts = useMemo(
    () =>
      value
        .map((accountId) => accounts.find((account) => account.id === accountId))
        .filter((account): account is (typeof accounts)[number] => account !== undefined),
    [accounts, value],
  );

  // Ids of accounts deleted since they were assigned. Shown so they can be removed:
  // a key whose assigned accounts are all gone is refused rather than opened up.
  const missingIds = useMemo(
    () => (accountsQuery.data ? value.filter((id) => !accounts.some((account) => account.id === id)) : []),
    [accounts, accountsQuery.data, value],
  );

  const toggle = useCallback(
    (accountId: string) => {
      if (selectedSet.has(accountId)) {
        onChange(value.filter((current) => current !== accountId));
        return;
      }
      onChange([...value, accountId]);
    },
    [onChange, selectedSet, value],
  );

  const remove = useCallback(
    (accountId: string) => {
      onChange(value.filter((current) => current !== accountId));
    },
    [onChange, value],
  );

  const selectAll = useCallback(() => {
    onChange([]);
  }, [onChange]);

  const label =
    value.length === 0 ? placeholderLabel : t("apiKeys.accountSelect.selected", { count: value.length });

  return (
    <div className="space-y-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            id={triggerId}
            aria-invalid={ariaInvalid}
            aria-describedby={ariaDescribedBy}
            className={cn("w-full justify-between font-normal", triggerClassName)}
            disabled={accountsQuery.isLoading}
          >
            <span className="truncate text-left">
              {accountsQuery.isLoading ? t("apiKeys.accountSelect.loading") : label}
            </span>
            <ChevronsUpDown className="ml-1 size-4 shrink-0 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)] max-h-64">
          <div className="px-2 py-1.5">
            <Input
              name="account-search"
              aria-label={t("accounts.list.searchPlaceholder")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("accounts.list.searchPlaceholder")}
              className="h-7 text-xs"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            />
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={value.length === 0}
            onCheckedChange={selectAll}
            onSelect={(event) => event.preventDefault()}
          >
            {t("apiKeys.accountSelect.all")}
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          {filtered.map((account) => (
            <DropdownMenuCheckboxItem
              key={account.id}
              checked={selectedSet.has(account.id)}
              onCheckedChange={() => toggle(account.id)}
              onSelect={(event) => event.preventDefault()}
              className="items-start"
            >
              <AccountOption account={account} />
            </DropdownMenuCheckboxItem>
          ))}
          {filtered.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">{t("apiKeys.accountSelect.empty")}</div>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {selectedAccounts.length > 0 || missingIds.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {missingIds.map((accountId) => (
            <Badge key={accountId} variant="outline" className="gap-1 text-xs text-muted-foreground">
              {t("apiKeys.accountSelect.deleted")}
              <button
                type="button"
                className="ml-0.5 hover:text-foreground"
                aria-label={t("apiKeys.accountSelect.remove", { name: t("apiKeys.accountSelect.deleted") })}
                onClick={() => remove(accountId)}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
          {selectedAccounts.map((account) => (
            <Badge key={account.id} variant="secondary" className="gap-1 text-xs">
              {account.name}
              <button
                type="button"
                className="ml-0.5 hover:text-foreground"
                aria-label={t("apiKeys.accountSelect.remove", { name: account.name })}
                onClick={() => remove(account.id)}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}
