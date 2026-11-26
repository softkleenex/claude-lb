import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import { getReport, getReportOptions } from "../api";
import { dateRangeProblem, daysAgoUtcISO, utcDateISO } from "../date";
import { REPORT_GROUPINGS, type ReportFilters, type ReportGrouping } from "../schemas";

export const REPORT_REFRESH_MS = 60_000;
export const REPORT_PRESETS = [7, 30, 90] as const;
export type ReportPreset = (typeof REPORT_PRESETS)[number];
export const DEFAULT_PRESET: ReportPreset = 30;

/** The page state held in the URL: a preset (rolling window) or a fixed start/end. */
export type ReportUrlState = ReportFilters & { preset: ReportPreset | null };

const PARAM_KEYS = ["preset", "start", "end", "groupBy", "accountId", "apiKeyId", "model", "userAgent"] as const;

function presetRange(days: number, now: Date = new Date()): { start: string; end: string } {
  return { start: daysAgoUtcISO(days - 1, now), end: utcDateISO(now) };
}

function parsePreset(value: string | null): ReportPreset | null {
  const days = Number(value);
  return (REPORT_PRESETS as readonly number[]).includes(days) ? (days as ReportPreset) : null;
}

export function parseReportState(params: URLSearchParams, now: Date = new Date()): ReportUrlState {
  const groupParam = params.get("groupBy");
  const groupBy: ReportGrouping = (REPORT_GROUPINGS as readonly string[]).includes(groupParam ?? "")
    ? (groupParam as ReportGrouping)
    : "day";
  const start = params.get("start");
  const end = params.get("end");
  // A fixed range wins only when both ends are given and no preset is selected.
  const preset = parsePreset(params.get("preset")) ?? (start !== null && end !== null ? null : DEFAULT_PRESET);
  const range = preset ? presetRange(preset, now) : { start: start ?? "", end: end ?? "" };
  return {
    ...range,
    preset,
    groupBy,
    accountIds: params.getAll("accountId"),
    apiKeyIds: params.getAll("apiKeyId"),
    models: params.getAll("model"),
    userAgents: params.getAll("userAgent"),
  };
}

export function writeReportState(state: ReportUrlState, base?: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams(base);
  for (const key of PARAM_KEYS) params.delete(key);
  if (state.preset) {
    if (state.preset !== DEFAULT_PRESET) params.set("preset", String(state.preset));
  } else {
    params.set("start", state.start);
    params.set("end", state.end);
  }
  if (state.groupBy !== "day") params.set("groupBy", state.groupBy);
  for (const value of state.accountIds) params.append("accountId", value);
  for (const value of state.apiKeyIds) params.append("apiKeyId", value);
  for (const value of state.models) params.append("model", value);
  for (const value of state.userAgents) params.append("userAgent", value);
  return params;
}

export function useReportState() {
  const [searchParams, setSearchParams] = useSearchParams();
  const state = useMemo(() => parseReportState(searchParams), [searchParams]);

  const update = useCallback(
    (patch: Partial<ReportUrlState>) => {
      setSearchParams((current) => writeReportState({ ...parseReportState(current), ...patch }, current), {
        replace: true,
      });
    },
    [setSearchParams],
  );

  const selectPreset = useCallback((preset: ReportPreset) => update({ preset, ...presetRange(preset) }), [update]);
  const setRange = useCallback(
    (range: { start?: string; end?: string }) => update({ preset: null, ...range }),
    [update],
  );

  return { state, update, selectPreset, setRange };
}

function filtersOf(state: ReportUrlState): ReportFilters {
  return {
    start: state.start,
    end: state.end,
    groupBy: state.groupBy,
    accountIds: state.accountIds,
    apiKeyIds: state.apiKeyIds,
    models: state.models,
    userAgents: state.userAgents,
  };
}

export function useReport(state: ReportUrlState) {
  const filters = useMemo(() => filtersOf(state), [state]);
  const valid = dateRangeProblem(filters.start, filters.end) === null;
  return useQuery({
    queryKey: ["reports", "report", filters],
    queryFn: () => getReport(filters),
    enabled: valid,
    placeholderData: keepPreviousData,
    refetchInterval: REPORT_REFRESH_MS,
    refetchIntervalInBackground: false,
  });
}

export function useReportOptions(start: string, end: string) {
  const valid = dateRangeProblem(start, end) === null;
  return useQuery({
    queryKey: ["reports", "options", start, end],
    queryFn: () => getReportOptions({ start, end }),
    enabled: valid,
    placeholderData: keepPreviousData,
    refetchInterval: REPORT_REFRESH_MS,
    refetchIntervalInBackground: false,
  });
}

export { filtersOf as reportFiltersOf };
