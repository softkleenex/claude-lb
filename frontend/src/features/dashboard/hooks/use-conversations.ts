import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import { getConversationDetail, getConversations } from "@/features/dashboard/api";
import { DASHBOARD_REFRESH_MS } from "@/features/dashboard/hooks/use-dashboard";
import {
  REQUEST_LOG_TIMEFRAMES,
  REQUEST_LOG_VIEWS,
  type RequestLogTimeframe,
  type RequestLogView,
} from "@/features/dashboard/schemas";

export type ConversationFilterState = {
  search: string;
  timeframe: RequestLogTimeframe;
  limit: number;
  offset: number;
};

export const DEFAULT_CONVERSATION_FILTERS: ConversationFilterState = {
  search: "",
  timeframe: "all",
  limit: 25,
  offset: 0,
};

/** URL params of the conversations view; prefixed so they never clash with request-log filters. */
const PARAMS = {
  search: "convSearch",
  timeframe: "convTimeframe",
  limit: "convLimit",
  offset: "convOffset",
} as const;

export function parseRequestLogView(value: string | null): RequestLogView {
  return (REQUEST_LOG_VIEWS as readonly string[]).includes(value ?? "") ? (value as RequestLogView) : "requests";
}

function positiveInt(value: string | null, fallback: number, min: number): number {
  const parsed = Number(value);
  return value !== null && Number.isInteger(parsed) && parsed >= min ? parsed : fallback;
}

export function parseConversationFilters(params: URLSearchParams): ConversationFilterState {
  const timeframe = params.get(PARAMS.timeframe);
  return {
    search: params.get(PARAMS.search) ?? "",
    timeframe: (REQUEST_LOG_TIMEFRAMES as readonly string[]).includes(timeframe ?? "")
      ? (timeframe as RequestLogTimeframe)
      : DEFAULT_CONVERSATION_FILTERS.timeframe,
    limit: Math.min(200, positiveInt(params.get(PARAMS.limit), DEFAULT_CONVERSATION_FILTERS.limit, 1)),
    offset: positiveInt(params.get(PARAMS.offset), 0, 0),
  };
}

export function writeConversationFilters(state: ConversationFilterState, base?: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams(base);
  for (const key of Object.values(PARAMS)) params.delete(key);
  if (state.search) params.set(PARAMS.search, state.search);
  if (state.timeframe !== DEFAULT_CONVERSATION_FILTERS.timeframe) params.set(PARAMS.timeframe, state.timeframe);
  if (state.limit !== DEFAULT_CONVERSATION_FILTERS.limit) params.set(PARAMS.limit, String(state.limit));
  if (state.offset > 0) params.set(PARAMS.offset, String(state.offset));
  return params;
}

/** Which table the request-log section shows (`?view=conversations`). */
export function useRequestLogView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const view = parseRequestLogView(searchParams.get("view"));
  const setView = useCallback(
    (next: RequestLogView) => {
      setSearchParams(
        (current) => {
          const params = new URLSearchParams(current);
          if (next === "requests") params.delete("view");
          else params.set("view", next);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  return { view, setView };
}

export function useConversations(enabled: boolean) {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => parseConversationFilters(searchParams), [searchParams]);

  const conversationsQuery = useQuery({
    queryKey: ["dashboard", "conversations", filters],
    queryFn: () => getConversations(filters),
    enabled,
    placeholderData: keepPreviousData,
    refetchInterval: DASHBOARD_REFRESH_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  const updateFilters = useCallback(
    (patch: Partial<ConversationFilterState>) => {
      setSearchParams(
        (current) => writeConversationFilters({ ...parseConversationFilters(current), ...patch }, current),
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return { filters, conversationsQuery, updateFilters };
}

export function useConversationDetail(sessionKey: string | null) {
  return useQuery({
    queryKey: ["dashboard", "conversation", sessionKey],
    queryFn: () => getConversationDetail(sessionKey as string),
    enabled: !!sessionKey,
    staleTime: 30_000,
  });
}
