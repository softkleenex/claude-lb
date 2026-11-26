import { keepPreviousData, useQuery } from "@tanstack/react-query";

import {
  getDashboardOverview,
  getDashboardProjections,
  getRequestLogDetail,
  getUsageTrend,
} from "@/features/dashboard/api";
import { DEFAULT_OVERVIEW_TIMEFRAME, type OverviewTimeframe } from "@/features/dashboard/schemas";

/** Live refresh: every 30 s while the tab is visible (React Query pauses hidden tabs). */
export const DASHBOARD_REFRESH_MS = 30_000;

const LIVE = {
  refetchInterval: DASHBOARD_REFRESH_MS,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
} as const;

export function useDashboardOverview(timeframe: OverviewTimeframe = DEFAULT_OVERVIEW_TIMEFRAME) {
  return useQuery({
    queryKey: ["dashboard", "overview", timeframe],
    queryFn: () => getDashboardOverview(timeframe),
    placeholderData: keepPreviousData,
    ...LIVE,
  });
}

export function useDashboardProjections() {
  return useQuery({
    queryKey: ["dashboard", "projections"],
    queryFn: getDashboardProjections,
    ...LIVE,
  });
}

export function useCostTrend(days = 28) {
  return useQuery({
    queryKey: ["dashboard", "cost-trend", days],
    queryFn: () => getUsageTrend(days),
    staleTime: 60_000,
    ...LIVE,
    refetchInterval: 5 * 60_000,
  });
}

export function useRequestLogDetail(requestId: string | null) {
  return useQuery({
    queryKey: ["dashboard", "request-log", requestId],
    queryFn: () => getRequestLogDetail(requestId as string),
    enabled: !!requestId,
    staleTime: 30_000,
  });
}
