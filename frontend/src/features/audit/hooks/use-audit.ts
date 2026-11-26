import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import { getAuditActions, getAuditEvents } from "@/features/audit/api";
import {
  AUDIT_RESULTS,
  AUDIT_TIMEFRAMES,
  type AuditFilters,
  type AuditResult,
  type AuditTimeframe,
} from "@/features/audit/schemas";

export const DEFAULT_AUDIT_FILTERS: AuditFilters = {
  search: "",
  actions: [],
  target: "",
  timeframe: "all",
  result: "all",
  limit: 50,
  offset: 0,
};

const PARAM_KEYS = ["search", "action", "target", "timeframe", "result", "limit", "offset"] as const;

function nonNegativeInt(value: string | null, fallback: number, min: number): number {
  const parsed = Number(value);
  return value !== null && Number.isInteger(parsed) && parsed >= min ? parsed : fallback;
}

export function parseAuditFilters(params: URLSearchParams): AuditFilters {
  const timeframe = params.get("timeframe");
  const result = params.get("result");
  return {
    search: params.get("search") ?? "",
    actions: params.getAll("action"),
    target: params.get("target") ?? "",
    timeframe: (AUDIT_TIMEFRAMES as readonly string[]).includes(timeframe ?? "")
      ? (timeframe as AuditTimeframe)
      : "all",
    result: (AUDIT_RESULTS as readonly string[]).includes(result ?? "") ? (result as AuditResult) : "all",
    limit: Math.min(500, nonNegativeInt(params.get("limit"), DEFAULT_AUDIT_FILTERS.limit, 1)),
    offset: nonNegativeInt(params.get("offset"), 0, 0),
  };
}

export function writeAuditFilters(filters: AuditFilters, base?: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams(base);
  for (const key of PARAM_KEYS) params.delete(key);
  if (filters.search) params.set("search", filters.search);
  for (const action of filters.actions) params.append("action", action);
  if (filters.target) params.set("target", filters.target);
  if (filters.timeframe !== "all") params.set("timeframe", filters.timeframe);
  if (filters.result !== "all") params.set("result", filters.result);
  if (filters.limit !== DEFAULT_AUDIT_FILTERS.limit) params.set("limit", String(filters.limit));
  if (filters.offset > 0) params.set("offset", String(filters.offset));
  return params;
}

export function auditFiltersApplied(filters: AuditFilters): boolean {
  return Boolean(
    filters.search.trim() ||
    filters.actions.length ||
    filters.target.trim() ||
    filters.timeframe !== "all" ||
    filters.result !== "all",
  );
}

export function useAudit() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => parseAuditFilters(searchParams), [searchParams]);

  const eventsQuery = useQuery({
    queryKey: ["audit", "events", filters],
    queryFn: () => getAuditEvents(filters),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  const actionsQuery = useQuery({
    queryKey: ["audit", "actions"],
    queryFn: getAuditActions,
    staleTime: 60_000,
  });

  const updateFilters = useCallback(
    (patch: Partial<AuditFilters>) => {
      setSearchParams((current) => writeAuditFilters({ ...parseAuditFilters(current), ...patch }, current), {
        replace: true,
      });
    },
    [setSearchParams],
  );

  const resetFilters = useCallback(() => {
    updateFilters({ ...DEFAULT_AUDIT_FILTERS, limit: filters.limit });
  }, [filters.limit, updateFilters]);

  return { filters, eventsQuery, actionsQuery, updateFilters, resetFilters };
}
