import { Info, Link2, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { AlertMessage } from "@/components/alert-message";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { SearchInput } from "@/components/search-input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SpinnerBlock } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAccounts } from "@/features/accounts/hooks/use-accounts";
import { formatAbsolute, formatDuration, formatUntil, useNow } from "@/features/accounts/lib/time";
import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { PaginationControls } from "@/features/dashboard/components/filters/pagination-controls";
import { shortConversationKey } from "@/features/dashboard/utils";
import { useStickySessions } from "@/features/sticky-sessions/hooks/use-sticky-sessions";
import type { StickyPage } from "@/features/sticky-sessions/schemas";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/utils/formatters";

const HEAD = "text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80";
const ALL_ACCOUNTS = "__all__";

type Confirm =
  | { kind: "one"; key: string }
  | { kind: "selected"; keys: string[] }
  | { kind: "account"; accountId: string; name: string; count: number }
  | { kind: "purge"; count: number };

function StatusCard({ page }: { page: StickyPage }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span>{page.enabled ? t("stickySessions.status.enabled") : t("stickySessions.status.disabled")}</span>
        <span className="text-muted-foreground">
          {t("stickySessions.status.ttl", { duration: formatDuration(page.ttlSeconds * 1000) })}
        </span>
        <span className="text-muted-foreground" data-testid="sticky-size">
          {t("stickySessions.status.size", { size: formatNumber(page.size), capacity: formatNumber(page.capacity) })}
        </span>
        {page.expiredCount > 0 ? (
          <span className="text-amber-700 dark:text-amber-400">
            {t("stickySessions.status.expired", { count: page.expiredCount })}
          </span>
        ) : null}
      </div>
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {t("stickySessions.status.inMemoryNote")}
      </p>
    </div>
  );
}

export function StickySessionsPage() {
  const { t } = useTranslation();
  const now = useNow(5_000);
  const canWrite = useAuthStore((state) => state.canWrite);
  const { filters, listQuery, updateFilters, deleteOne, deleteMany, deleteAccount, purge, busy } = useStickySessions();
  const [selection, setSelection] = useState<{ scope: string; keys: string[] }>({ scope: "", keys: [] });
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const page = listQuery.data;
  const accountsQuery = useAccounts();

  // Selection belongs to one filtered page; changing filters or pages starts afresh.
  const scope = JSON.stringify(filters);
  const visibleKeys = useMemo(() => new Set((page?.entries ?? []).map((entry) => entry.key)), [page]);
  const selected = selection.scope === scope ? selection.keys.filter((key) => visibleKeys.has(key)) : [];
  const allSelected = visibleKeys.size > 0 && selected.length === visibleKeys.size;

  const setSelected = (keys: string[]) => setSelection({ scope, keys });
  const toggle = (key: string, checked: boolean) =>
    setSelected(checked ? [...selected, key] : selected.filter((entry) => entry !== key));

  const onSearch = useCallback((search: string) => updateFilters({ search, offset: 0 }), [updateFilters]);

  // Every live account (so the filter keeps its label once its entries are gone), plus any
  // account id still pinned in the map after the account itself was deleted.
  const accountOptions = useMemo(() => {
    const counts = new Map((page?.byAccount ?? []).map((item) => [item.accountId, item]));
    const live = (accountsQuery.data ?? []).map((account) => ({
      accountId: account.id,
      accountName: account.name as string | null,
      entries: counts.get(account.id)?.entries ?? 0,
    }));
    const liveIds = new Set(live.map((item) => item.accountId));
    const orphans = (page?.byAccount ?? []).filter((item) => !liveIds.has(item.accountId));
    return [...live, ...orphans];
  }, [accountsQuery.data, page]);
  const accountName = (id: string) => accountOptions.find((item) => item.accountId === id)?.accountName ?? id;

  const runConfirm = () => {
    if (!confirm) return;
    const done = () => {
      setSelected([]);
      setConfirm(null);
    };
    if (confirm.kind === "one") deleteOne.mutate(confirm.key, { onSettled: done });
    else if (confirm.kind === "selected") deleteMany.mutate(confirm.keys, { onSettled: done });
    else if (confirm.kind === "account") deleteAccount.mutate(confirm.accountId, { onSettled: done });
    else purge.mutate(undefined, { onSettled: done });
  };

  const confirmText = (() => {
    if (!confirm) return { title: "", description: "" };
    switch (confirm.kind) {
      case "one":
        return {
          title: t("stickySessions.confirm.oneTitle"),
          description: t("stickySessions.confirm.oneDescription", { key: shortConversationKey(confirm.key) }),
        };
      case "selected":
        return {
          title: t("stickySessions.confirm.selectedTitle", { count: confirm.keys.length }),
          description: t("stickySessions.confirm.selectedDescription", { count: confirm.keys.length }),
        };
      case "account":
        return {
          title: t("stickySessions.confirm.accountTitle", { name: confirm.name }),
          description: t("stickySessions.confirm.accountDescription", { count: confirm.count, name: confirm.name }),
        };
      case "purge":
        return {
          title: t("stickySessions.confirm.purgeTitle"),
          description: t("stickySessions.confirm.purgeDescription", { count: confirm.count }),
        };
    }
  })();

  const selectedAccount = filters.accountId
    ? accountOptions.find((item) => item.accountId === filters.accountId)
    : null;

  return (
    <div className="animate-fade-in-up min-w-0 space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Link2 className="h-5 w-5 text-primary" aria-hidden="true" />
          {t("stickySessions.page.title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("stickySessions.page.subtitle")}</p>
      </div>

      {page ? <StatusCard page={page} /> : null}

      <div className="space-y-2 rounded-xl border bg-card p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={filters.accountId ?? ALL_ACCOUNTS}
            onValueChange={(value) => updateFilters({ accountId: value === ALL_ACCOUNTS ? null : value, offset: 0 })}
          >
            <SelectTrigger size="sm" className="w-48" aria-label={t("stickySessions.filters.account")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              <SelectItem value={ALL_ACCOUNTS}>{t("stickySessions.filters.allAccounts")}</SelectItem>
              {filters.accountId && !selectedAccount ? (
                <SelectItem value={filters.accountId}>{filters.accountId}</SelectItem>
              ) : null}
              {accountOptions.map((item) => (
                <SelectItem key={item.accountId} value={item.accountId}>
                  {t("stickySessions.filters.accountOption", {
                    name: item.accountName ?? item.accountId,
                    count: item.entries,
                  })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <SearchInput
            className="min-w-40 flex-1"
            name="sticky-search"
            value={filters.search}
            onChange={onSearch}
            placeholder={t("stickySessions.filters.searchPlaceholder")}
            ariaLabel={t("stickySessions.filters.search")}
          />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={filters.includeExpired}
              onCheckedChange={(includeExpired) => updateFilters({ includeExpired, offset: 0 })}
              aria-label={t("stickySessions.filters.showExpired")}
            />
            {t("stickySessions.filters.showExpired")}
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={!canWrite || busy || selected.length === 0}
            onClick={() => setConfirm({ kind: "selected", keys: selected })}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t("stickySessions.actions.deleteSelected", { count: selected.length })}
          </Button>
          {filters.accountId ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canWrite || busy || !selectedAccount || selectedAccount.entries === 0}
              onClick={() =>
                selectedAccount &&
                setConfirm({
                  kind: "account",
                  accountId: selectedAccount.accountId,
                  name: selectedAccount.accountName ?? selectedAccount.accountId,
                  count: selectedAccount.entries,
                })
              }
            >
              {t("stickySessions.actions.deleteAccount", { name: accountName(filters.accountId) })}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canWrite || busy || !page || page.expiredCount === 0}
            onClick={() => page && setConfirm({ kind: "purge", count: page.expiredCount })}
          >
            {t("stickySessions.actions.purge", { count: page?.expiredCount ?? 0 })}
          </Button>
        </div>
      </div>

      {listQuery.error && !page ? (
        <AlertMessage variant="error">{listQuery.error.message}</AlertMessage>
      ) : !page ? (
        <SpinnerBlock />
      ) : page.entries.length === 0 ? (
        <EmptyState
          icon={Link2}
          title={page.size === 0 ? t("stickySessions.empty.title") : t("stickySessions.empty.filteredTitle")}
          description={
            page.size === 0 ? t("stickySessions.empty.description") : t("stickySessions.empty.filteredDescription")
          }
        />
      ) : (
        <div className={cn("space-y-3 transition-opacity", listQuery.isPlaceholderData && "opacity-60")}>
          <div className="rounded-xl border bg-card">
            <div className="relative overflow-x-auto">
              <Table className="min-w-[720px]" data-testid="sticky-table">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-10 pl-4">
                      <Checkbox
                        checked={allSelected ? true : selected.length > 0 ? "indeterminate" : false}
                        onCheckedChange={(checked) => setSelected(checked === true ? [...visibleKeys] : [])}
                        aria-label={t("stickySessions.table.selectAll")}
                        disabled={!canWrite}
                      />
                    </TableHead>
                    <TableHead className={HEAD}>{t("stickySessions.table.key")}</TableHead>
                    <TableHead className={HEAD}>{t("stickySessions.table.account")}</TableHead>
                    <TableHead className={HEAD}>{t("stickySessions.table.remaining")}</TableHead>
                    <TableHead className={HEAD}>{t("stickySessions.table.expiresAt")}</TableHead>
                    <TableHead className={cn("pr-4 text-right", HEAD)}>
                      <span className="sr-only">{t("stickySessions.table.actions")}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {page.entries.map((entry) => {
                    const short = shortConversationKey(entry.key);
                    const left = entry.expired ? null : formatUntil(entry.expiresAt, now);
                    return (
                      <TableRow key={entry.key} data-testid={`sticky-row-${short}`}>
                        <TableCell className="pl-4">
                          <Checkbox
                            checked={selected.includes(entry.key)}
                            onCheckedChange={(checked) => toggle(entry.key, checked === true)}
                            aria-label={t("stickySessions.table.select", { key: short })}
                            disabled={!canWrite}
                          />
                        </TableCell>
                        <TableCell>
                          <span className="font-mono text-xs" title={entry.key} translate="no">
                            {short}
                          </span>
                          <Link
                            to={`/dashboard?session=${encodeURIComponent(entry.key)}`}
                            className="ml-2 text-[11px] text-primary hover:underline"
                          >
                            {t("stickySessions.table.requests")}
                          </Link>
                        </TableCell>
                        <TableCell className="text-sm">
                          {entry.accountName ?? (
                            <span className="text-muted-foreground">{t("stickySessions.table.deletedAccount")}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs tabular-nums">
                          {entry.expired || !left ? (
                            <span className="text-amber-700 dark:text-amber-400">
                              {t("stickySessions.table.expired")}
                            </span>
                          ) : (
                            t("stickySessions.table.expiresIn", { duration: left })
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatAbsolute(entry.expiresAt)}
                        </TableCell>
                        <TableCell className="pr-4 text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            disabled={!canWrite || busy}
                            onClick={() => setConfirm({ kind: "one", key: entry.key })}
                            aria-label={t("stickySessions.table.deleteOne", { key: short })}
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
          <div className="flex justify-end">
            <PaginationControls
              total={page.total}
              limit={filters.limit}
              offset={filters.offset}
              hasMore={page.hasMore}
              onLimitChange={(limit) => updateFilters({ limit, offset: 0 })}
              onOffsetChange={(offset) => updateFilters({ offset })}
            />
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={confirmText.title}
        description={confirmText.description}
        confirmLabel={t("common.actions.delete")}
        confirmDisabled={busy}
        onConfirm={runConfirm}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      />
    </div>
  );
}
