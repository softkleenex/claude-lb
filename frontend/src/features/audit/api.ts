import { get } from "@/lib/api-client";

import { AuditActionsSchema, AuditPageSchema, type AuditFilters } from "@/features/audit/schemas";

export function getAuditEvents(filters: AuditFilters) {
  const query = new URLSearchParams();
  query.set("limit", String(filters.limit));
  query.set("offset", String(filters.offset));
  if (filters.search.trim()) query.set("search", filters.search.trim());
  if (filters.target.trim()) query.set("target", filters.target.trim());
  if (filters.timeframe !== "all") query.set("timeframe", filters.timeframe);
  if (filters.result !== "all") query.set("ok", filters.result === "ok" ? "true" : "false");
  for (const action of filters.actions) query.append("action", action);
  return get(`/api/audit/events?${query.toString()}`, AuditPageSchema);
}

export function getAuditActions() {
  return get("/api/audit/actions", AuditActionsSchema);
}
