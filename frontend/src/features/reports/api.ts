import { get } from "@/lib/api-client";

import { ReportOptionsSchema, ReportSchema, type ReportFilters } from "./schemas";

/** Query string shared by the JSON report and the server-side CSV export. */
export function reportQuery(filters: ReportFilters): URLSearchParams {
  const query = new URLSearchParams({ start: filters.start, end: filters.end, group_by: filters.groupBy });
  for (const id of filters.accountIds) query.append("account_id", id);
  for (const id of filters.apiKeyIds) query.append("api_key_id", id);
  for (const model of filters.models) query.append("model", model);
  for (const agent of filters.userAgents) query.append("user_agent", agent);
  return query;
}

export function getReport(filters: ReportFilters) {
  return get(`/api/reports?${reportQuery(filters).toString()}`, ReportSchema);
}

export function getReportOptions(range: { start: string; end: string }) {
  const query = new URLSearchParams(range);
  return get(`/api/reports/options?${query.toString()}`, ReportOptionsSchema);
}

/** `GET /api/usage/report.csv` honours the same filters and grouping as the page. */
export function reportCsvUrl(filters: ReportFilters): string {
  return `/api/usage/report.csv?${reportQuery(filters).toString()}`;
}
