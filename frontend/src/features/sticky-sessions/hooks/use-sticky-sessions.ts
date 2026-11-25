import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import {
  deleteAccountStickySessions,
  deleteStickySession,
  deleteStickySessions,
  listStickySessions,
  purgeExpiredStickySessions,
} from "@/features/sticky-sessions/api";
import type { StickyFilters } from "@/features/sticky-sessions/schemas";

export const DEFAULT_STICKY_FILTERS: StickyFilters = {
  accountId: null,
  search: "",
  includeExpired: true,
  limit: 25,
  offset: 0,
};

const QUERY_KEY = ["sticky-sessions"] as const;

function intParam(value: string | null, fallback: number, min: number): number {
  const parsed = Number(value);
  return value !== null && Number.isInteger(parsed) && parsed >= min ? parsed : fallback;
}

export function parseStickyFilters(params: URLSearchParams): StickyFilters {
  return {
    accountId: params.get("account") || null,
    search: params.get("search") ?? "",
    includeExpired: params.get("expired") !== "hide",
    limit: Math.min(500, intParam(params.get("limit"), DEFAULT_STICKY_FILTERS.limit, 1)),
    offset: intParam(params.get("offset"), 0, 0),
  };
}

export function writeStickyFilters(filters: StickyFilters, base?: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams(base);
  for (const key of ["account", "search", "expired", "limit", "offset"]) params.delete(key);
  if (filters.accountId) params.set("account", filters.accountId);
  if (filters.search) params.set("search", filters.search);
  if (!filters.includeExpired) params.set("expired", "hide");
  if (filters.limit !== DEFAULT_STICKY_FILTERS.limit) params.set("limit", String(filters.limit));
  if (filters.offset > 0) params.set("offset", String(filters.offset));
  return params;
}

export function useStickySessions() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => parseStickyFilters(searchParams), [searchParams]);

  const listQuery = useQuery({
    queryKey: [...QUERY_KEY, filters],
    queryFn: () => listStickySessions(filters),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });

  const updateFilters = useCallback(
    (patch: Partial<StickyFilters>) => {
      setSearchParams((current) => writeStickyFilters({ ...parseStickyFilters(current), ...patch }, current), {
        replace: true,
      });
    },
    [setSearchParams],
  );

  const settle = () => void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  const failed = (error: Error) => toast.error(error.message || t("stickySessions.toasts.failed"));
  const deleted = (count: number) => toast.success(t("stickySessions.toasts.deleted", { count }));

  const deleteOne = useMutation({
    mutationFn: deleteStickySession,
    onSuccess: () => deleted(1),
    onError: failed,
    onSettled: settle,
  });
  const deleteMany = useMutation({
    mutationFn: deleteStickySessions,
    onSuccess: (result) => deleted(result.deletedCount),
    onError: failed,
    onSettled: settle,
  });
  const deleteAccount = useMutation({
    mutationFn: deleteAccountStickySessions,
    onSuccess: (result) => deleted(result.deletedCount),
    onError: failed,
    onSettled: settle,
  });
  const purge = useMutation({
    mutationFn: purgeExpiredStickySessions,
    onSuccess: (result) => toast.success(t("stickySessions.toasts.purged", { count: result.deletedCount })),
    onError: failed,
    onSettled: settle,
  });

  const busy = deleteOne.isPending || deleteMany.isPending || deleteAccount.isPending || purge.isPending;
  return { filters, listQuery, updateFilters, deleteOne, deleteMany, deleteAccount, purge, busy };
}
