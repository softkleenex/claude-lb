import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import { getRequestLogOptions, getRequestLogs, type RequestLogsListFilters } from "@/features/dashboard/api";
import { DASHBOARD_REFRESH_MS } from "@/features/dashboard/hooks/use-dashboard";
import { FilterStateSchema, type FilterState } from "@/features/dashboard/schemas";

export const DEFAULT_FILTER_STATE: FilterState = {
  search: "",
  timeframe: "all",
  accountIds: [],
  apiKeyIds: [],
  models: [],
  statuses: [],
  sessionKey: null,
  limit: 25,
  offset: 0,
};

/** URL search params that hold the request-log filters (the overview owns `window`). */
const PARAM_KEYS = [
  "search",
  "timeframe",
  "accountId",
  "apiKeyId",
  "model",
  "status",
  "session",
  "limit",
  "offset",
] as const;

export function requestLogFiltersApplied(filters: FilterState): boolean {
  return (
    filters.search.trim() !== "" ||
    filters.timeframe !== DEFAULT_FILTER_STATE.timeframe ||
    filters.accountIds.length > 0 ||
    filters.apiKeyIds.length > 0 ||
    filters.models.length > 0 ||
    filters.statuses.length > 0 ||
    Boolean(filters.sessionKey)
  );
}

function parseNumber(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseFilterState(params: URLSearchParams): FilterState {
  const parsed = FilterStateSchema.safeParse({
    search: params.get("search") ?? "",
    timeframe: params.get("timeframe") ?? "all",
    accountIds: params.getAll("accountId"),
    apiKeyIds: params.getAll("apiKeyId"),
    models: params.getAll("model"),
    statuses: params.getAll("status"),
    sessionKey: params.get("session") || null,
    limit: parseNumber(params.get("limit"), DEFAULT_FILTER_STATE.limit),
    offset: parseNumber(params.get("offset"), DEFAULT_FILTER_STATE.offset),
  });
  return parsed.success ? parsed.data : DEFAULT_FILTER_STATE;
}

export function writeFilterState(state: FilterState, base?: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams(base);
  for (const key of PARAM_KEYS) params.delete(key);
  if (state.search) params.set("search", state.search);
  if (state.timeframe !== "all") params.set("timeframe", state.timeframe);
  for (const value of state.accountIds) params.append("accountId", value);
  for (const value of state.apiKeyIds) params.append("apiKeyId", value);
  for (const value of state.models) params.append("model", value);
  for (const value of state.statuses) params.append("status", value);
  if (state.sessionKey) params.set("session", state.sessionKey);
  if (state.limit !== DEFAULT_FILTER_STATE.limit) params.set("limit", String(state.limit));
  if (state.offset > 0) params.set("offset", String(state.offset));
  return params;
}

export function useRequestLogs() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => parseFilterState(searchParams), [searchParams]);
  const filtersApplied = requestLogFiltersApplied(filters);

  const listFilters = useMemo<RequestLogsListFilters>(
    () => ({
      search: filters.search,
      timeframe: filters.timeframe,
      limit: filters.limit,
      offset: filters.offset,
      accountIds: filters.accountIds,
      apiKeyIds: filters.apiKeyIds,
      models: filters.models,
      statuses: filters.statuses,
      sessionKey: filters.sessionKey,
    }),
    [filters],
  );

  const logsQuery = useQuery({
    queryKey: ["dashboard", "request-logs", listFilters],
    queryFn: () => getRequestLogs(listFilters),
    placeholderData: keepPreviousData,
    refetchInterval: DASHBOARD_REFRESH_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  const optionsQuery = useQuery({
    queryKey: ["dashboard", "request-log-options", filters.timeframe],
    queryFn: () => getRequestLogOptions({ timeframe: filters.timeframe }),
    placeholderData: keepPreviousData,
    refetchInterval: DASHBOARD_REFRESH_MS,
    refetchIntervalInBackground: false,
  });

  const updateFilters = useCallback(
    (patch: Partial<FilterState>) => {
      setSearchParams(
        (current) => writeFilterState({ ...parseFilterState(current), ...patch }, current),
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const resetFilters = useCallback(() => {
    updateFilters({ ...DEFAULT_FILTER_STATE, limit: filters.limit });
  }, [filters.limit, updateFilters]);

  return { filters, filtersApplied, logsQuery, optionsQuery, updateFilters, resetFilters };
}
