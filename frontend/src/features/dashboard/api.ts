import { get } from "@/lib/api-client";

import {
  ConversationDetailSchema,
  ConversationPageSchema,
  DEFAULT_OVERVIEW_TIMEFRAME,
  DashboardOverviewSchema,
  DashboardProjectionsSchema,
  RequestLogDetailSchema,
  RequestLogFilterOptionsSchema,
  RequestLogsResponseSchema,
  UsageTrendSchema,
  type OverviewTimeframe,
  type RequestLogTimeframe,
} from "@/features/dashboard/schemas";

export type RequestLogsListFilters = {
  limit?: number;
  offset?: number;
  search?: string;
  timeframe?: RequestLogTimeframe;
  accountIds?: string[];
  apiKeyIds?: string[];
  models?: string[];
  statuses?: string[];
  sessionKey?: string | null;
};

function appendMany(params: URLSearchParams, key: string, values?: string[]): void {
  for (const value of values ?? []) {
    if (value) params.append(key, value);
  }
}

function withQuery(path: string, query: URLSearchParams): string {
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}

export function getDashboardOverview(timeframe: OverviewTimeframe = DEFAULT_OVERVIEW_TIMEFRAME) {
  return get(`/api/dashboard/overview?timeframe=${timeframe}`, DashboardOverviewSchema);
}

export function getDashboardProjections() {
  return get("/api/dashboard/projections", DashboardProjectionsSchema);
}

/** Daily totals from the rollups, so the chart survives request-log retention. */
export function getUsageTrend(days = 28) {
  return get(`/api/usage/trend?days=${days}`, UsageTrendSchema);
}

export function getRequestLogs(params: RequestLogsListFilters = {}) {
  const query = new URLSearchParams();
  if (typeof params.limit === "number") query.set("limit", String(params.limit));
  if (typeof params.offset === "number") query.set("offset", String(params.offset));
  if (params.search?.trim()) query.set("search", params.search.trim());
  if (params.timeframe && params.timeframe !== "all") query.set("timeframe", params.timeframe);
  appendMany(query, "accountId", params.accountIds);
  appendMany(query, "apiKeyId", params.apiKeyIds);
  appendMany(query, "model", params.models);
  appendMany(query, "status", params.statuses);
  if (params.sessionKey) query.set("sessionKey", params.sessionKey);
  return get(withQuery("/api/request-logs", query), RequestLogsResponseSchema);
}

export function getRequestLogOptions(params: { timeframe?: RequestLogTimeframe } = {}) {
  const query = new URLSearchParams();
  if (params.timeframe && params.timeframe !== "all") query.set("timeframe", params.timeframe);
  return get(withQuery("/api/request-logs/options", query), RequestLogFilterOptionsSchema);
}

export function getRequestLogDetail(requestId: string) {
  return get(`/api/request-logs/${encodeURIComponent(requestId)}`, RequestLogDetailSchema);
}

export type ConversationListFilters = {
  limit?: number;
  offset?: number;
  search?: string;
  timeframe?: RequestLogTimeframe;
};

export function getConversations(params: ConversationListFilters = {}) {
  const query = new URLSearchParams();
  if (typeof params.limit === "number") query.set("limit", String(params.limit));
  if (typeof params.offset === "number") query.set("offset", String(params.offset));
  if (params.search?.trim()) query.set("search", params.search.trim());
  if (params.timeframe && params.timeframe !== "all") query.set("timeframe", params.timeframe);
  return get(withQuery("/api/conversations", query), ConversationPageSchema);
}

export function getConversationDetail(sessionKey: string) {
  return get(`/api/conversations/${encodeURIComponent(sessionKey)}`, ConversationDetailSchema);
}
