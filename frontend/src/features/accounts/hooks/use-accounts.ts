import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  clearModelBlocks,
  createAccount,
  deleteAccount,
  getAccountTrends,
  getPoolQuota,
  importAccount,
  listAccounts,
  probeAccount,
  resetAccountQuota,
  updateAccount,
} from "@/features/accounts/api";
import { POOL_STATUS_QUERY_KEY } from "@/features/accounts/pool-status";
import type { Account, AccountUpdateRequest } from "@/features/accounts/schemas";

export const ACCOUNTS_QUERY_KEY = ["accounts", "list"] as const;
export const POOL_QUOTA_QUERY_KEY = ["usage", "quota"] as const;

export function accountTrendsQueryKey(accountId: string) {
  return ["accounts", "trends", accountId] as const;
}

/** Write a fresh account into the list cache, then refetch everything derived from it. */
function applyAccount(queryClient: QueryClient, account: Account | null) {
  if (account) {
    queryClient.setQueryData<Account[]>(ACCOUNTS_QUERY_KEY, (current) =>
      current?.map((item) => (item.id === account.id ? account : item)),
    );
  }
  void queryClient.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: POOL_STATUS_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: POOL_QUOTA_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
}

export function useAccounts() {
  return useQuery({
    queryKey: ACCOUNTS_QUERY_KEY,
    queryFn: listAccounts,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function usePoolQuota() {
  return useQuery({
    queryKey: POOL_QUOTA_QUERY_KEY,
    queryFn: getPoolQuota,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

export function useAccountTrends(accountId: string | null) {
  return useQuery({
    queryKey: accountTrendsQueryKey(accountId ?? ""),
    queryFn: () => getAccountTrends(accountId as string),
    enabled: !!accountId,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
  });
}

function errorMessage(error: Error, fallback: string): string {
  return error.message || fallback;
}

/**
 * Every account write the UI can make. Errors surface as toasts; callers that need
 * the result (probe, delete) use `mutateAsync`.
 */
export function useAccountMutations() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: createAccount,
    onSuccess: (account) => {
      toast.success(t("accounts.toasts.created", { name: account.name }));
      applyAccount(queryClient, null);
    },
  });

  const importCredentials = useMutation({
    mutationFn: importAccount,
    onSuccess: (account) => {
      toast.success(t("accounts.toasts.imported", { name: account.name }));
      applyAccount(queryClient, null);
    },
  });

  const update = useMutation({
    mutationFn: ({ accountId, patch }: { accountId: string; patch: AccountUpdateRequest }) =>
      updateAccount(accountId, patch),
    onSuccess: (account, { patch }) => {
      if (patch.enabled === false) toast.success(t("accounts.toasts.paused", { name: account.name }));
      else if (patch.enabled === true) toast.success(t("accounts.toasts.resumed", { name: account.name }));
      else toast.success(t("accounts.toasts.updated", { name: account.name }));
      applyAccount(queryClient, account);
    },
    onError: (error: Error) => toast.error(errorMessage(error, t("accounts.toasts.updateFailed"))),
  });

  const remove = useMutation({
    mutationFn: ({ accountId, deleteHistory }: { accountId: string; deleteHistory: boolean }) =>
      deleteAccount(accountId, deleteHistory),
    onSuccess: () => {
      toast.success(t("accounts.toasts.deleted"));
      applyAccount(queryClient, null);
    },
    onError: (error: Error) => toast.error(errorMessage(error, t("accounts.toasts.deleteFailed"))),
  });

  const probe = useMutation({
    mutationFn: (accountId: string) => probeAccount(accountId),
    onSuccess: (result) => {
      if (result.probe.ok) toast.success(t("accounts.toasts.probeOk", { name: result.account.name }));
      else toast.error(t("accounts.toasts.probeFailed", { name: result.account.name, detail: result.probe.detail }));
      applyAccount(queryClient, result.account);
    },
    onError: (error: Error) => toast.error(errorMessage(error, t("accounts.toasts.probeError"))),
  });

  const resetQuota = useMutation({
    mutationFn: (accountId: string) => resetAccountQuota(accountId),
    onSuccess: (account) => {
      toast.success(t("accounts.toasts.quotaReset", { name: account.name }));
      applyAccount(queryClient, account);
      void queryClient.invalidateQueries({ queryKey: accountTrendsQueryKey(account.id) });
    },
    onError: (error: Error) => toast.error(errorMessage(error, t("accounts.toasts.updateFailed"))),
  });

  const clearBlocks = useMutation({
    mutationFn: ({ accountId, model }: { accountId: string; model?: string }) => clearModelBlocks(accountId, model),
    onSuccess: (account) => {
      toast.success(t("accounts.toasts.blocksCleared", { name: account.name }));
      applyAccount(queryClient, account);
    },
    onError: (error: Error) => toast.error(errorMessage(error, t("accounts.toasts.updateFailed"))),
  });

  const busy =
    update.isPending || remove.isPending || probe.isPending || resetQuota.isPending || clearBlocks.isPending;

  return { create, importCredentials, update, remove, probe, resetQuota, clearBlocks, busy };
}
