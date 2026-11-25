import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";

import { AlertMessage } from "@/components/alert-message";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { useDialogState } from "@/hooks/use-dialog-state";
import { AccountDetail } from "@/features/accounts/components/account-detail";
import { AccountList } from "@/features/accounts/components/account-list";
import { AccountsSkeleton } from "@/features/accounts/components/accounts-skeleton";
import { AddAccountDialog } from "@/features/accounts/components/add-account-dialog";
import {
  useAccountMutations,
  useAccounts,
  useAccountTrends,
  usePoolQuota,
} from "@/features/accounts/hooks/use-accounts";
import { useNow } from "@/features/accounts/lib/time";
import type { ProbeResult } from "@/features/accounts/schemas";
import { DEFAULT_ACCOUNT_SORT_MODE, sortAccounts, type AccountSortMode } from "@/features/accounts/sorting";
import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { getErrorMessageOrNull } from "@/utils/errors";

export function AccountsPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sortMode, setSortMode] = useState<AccountSortMode>(DEFAULT_ACCOUNT_SORT_MODE);
  const [deleteHistory, setDeleteHistory] = useState(false);
  const [probeResults, setProbeResults] = useState<Record<string, ProbeResult>>({});
  const now = useNow(15_000);
  const canWrite = useAuthStore((state) => state.canWrite);

  const accountsQuery = useAccounts();
  const poolQuery = usePoolQuota();
  const mutations = useAccountMutations();
  const addDialog = useDialogState();
  const deleteDialog = useDialogState<string>();
  const resetDialog = useDialogState<string>();

  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const riskByAccount = useMemo(() => {
    const index: Record<string, { level: string; value: number }> = {};
    for (const item of poolQuery.data?.accounts ?? []) {
      index[item.accountId] = { level: item.riskLevel, value: item.depletionRisk };
    }
    return index;
  }, [poolQuery.data]);
  const riskLevels = useMemo(
    () => Object.fromEntries(Object.entries(riskByAccount).map(([id, risk]) => [id, risk.level])),
    [riskByAccount],
  );

  const requestedId = searchParams.get("selected");
  const selectedId = useMemo(() => {
    if (accounts.length === 0) return null;
    if (requestedId && accounts.some((account) => account.id === requestedId)) return requestedId;
    return sortAccounts(accounts, sortMode, now)[0]?.id ?? null;
  }, [accounts, requestedId, sortMode, now]);
  const selected = accounts.find((account) => account.id === selectedId) ?? null;
  const trendsQuery = useAccountTrends(selectedId);

  const select = useCallback(
    (accountId: string) => {
      const next = new URLSearchParams(searchParams);
      next.set("selected", accountId);
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  const deleteTarget = accounts.find((account) => account.id === deleteDialog.data) ?? null;
  const resetTarget = accounts.find((account) => account.id === resetDialog.data) ?? null;
  const loadError = getErrorMessageOrNull(accountsQuery.error);

  return (
    <div className="animate-fade-in-up space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("accounts.page.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("accounts.page.subtitle")}</p>
      </div>

      {loadError ? <AlertMessage variant="error">{loadError}</AlertMessage> : null}

      {!accountsQuery.data ? (
        loadError ? null : <AccountsSkeleton />
      ) : (
        <div
          data-testid="accounts-layout"
          className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)]"
        >
          <div className="min-h-0 min-w-0 self-start">
            <div className="flex min-h-0 min-w-0 flex-col rounded-xl border bg-card p-3 sm:p-4">
              <AccountList
                accounts={accounts}
                now={now}
                selectedAccountId={selectedId}
                onSelect={select}
                sortMode={sortMode}
                onSortModeChange={setSortMode}
                riskByAccount={riskLevels}
                onAdd={() => addDialog.show()}
                readOnly={!canWrite}
              />
            </div>
          </div>

          <AccountDetail
            account={selected}
            now={now}
            trends={trendsQuery.data ?? null}
            risk={selected ? (riskByAccount[selected.id] ?? null) : null}
            probeResult={selected ? (probeResults[selected.id] ?? null) : null}
            busy={mutations.busy}
            probing={mutations.probe.isPending}
            readOnly={!canWrite}
            onUpdate={(accountId, patch) => mutations.update.mutateAsync({ accountId, patch })}
            onProbe={(accountId) => {
              void mutations.probe
                .mutateAsync(accountId)
                .then((result) => setProbeResults((current) => ({ ...current, [accountId]: result.probe })))
                .catch(() => null);
            }}
            onResetQuota={(accountId) => resetDialog.show(accountId)}
            onClearBlocks={(accountId, model) => void mutations.clearBlocks.mutateAsync({ accountId, model }).catch(() => null)}
            onDelete={(accountId) => deleteDialog.show(accountId)}
          />
        </div>
      )}

      <AddAccountDialog
        open={addDialog.open}
        onOpenChange={addDialog.onOpenChange}
        onCreate={(payload) => mutations.create.mutateAsync(payload)}
        onImport={(payload) => mutations.importCredentials.mutateAsync(payload)}
      />

      <ConfirmDialog
        open={resetDialog.open}
        title={t("accounts.resetDialog.title")}
        description={t("accounts.resetDialog.description", { name: resetTarget?.name ?? "" })}
        confirmLabel={t("accounts.actions.resetQuota")}
        onOpenChange={resetDialog.onOpenChange}
        onConfirm={() => {
          if (resetDialog.data) void mutations.resetQuota.mutateAsync(resetDialog.data).catch(() => null);
        }}
      />

      <ConfirmDialog
        open={deleteDialog.open}
        title={t("accounts.deleteDialog.title", { name: deleteTarget?.name ?? "" })}
        description={t("accounts.deleteDialog.description")}
        confirmLabel={t("common.actions.delete")}
        onOpenChange={(open) => {
          deleteDialog.onOpenChange(open);
          if (!open) setDeleteHistory(false);
        }}
        onConfirm={() => {
          const accountId = deleteDialog.data;
          if (!accountId) return;
          void mutations.remove
            .mutateAsync({ accountId, deleteHistory })
            .then(() => {
              if (requestedId === accountId) {
                const next = new URLSearchParams(searchParams);
                next.delete("selected");
                setSearchParams(next);
              }
            })
            .catch(() => null)
            .finally(() => setDeleteHistory(false));
        }}
      >
        <div className="flex items-center gap-2">
          <Checkbox
            id="delete-history"
            checked={deleteHistory}
            onCheckedChange={(checked) => setDeleteHistory(checked === true)}
          />
          <label htmlFor="delete-history" className="cursor-pointer text-sm text-muted-foreground">
            {t("accounts.deleteDialog.deleteHistory")}
          </label>
        </div>
      </ConfirmDialog>
    </div>
  );
}
