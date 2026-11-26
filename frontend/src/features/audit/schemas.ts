import { z } from "zod";

/** claude-lb `GET /api/audit/events` and `GET /api/audit/actions` (camelized by the api-client). */

export const AuditEventSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  action: z.string(),
  target: z.string(),
  detail: z.string(),
  actor: z.string(),
  clientIp: z.string(),
  ok: z.boolean(),
});

export const AuditPageSchema = z.object({
  events: z.array(AuditEventSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
});

export const AuditActionCountSchema = z.object({ action: z.string(), count: z.number() });
export const AuditActionsSchema = z.array(AuditActionCountSchema);

export const AUDIT_TIMEFRAMES = ["all", "1h", "24h", "7d", "30d"] as const;
export type AuditTimeframe = (typeof AUDIT_TIMEFRAMES)[number];

export const AUDIT_RESULTS = ["all", "ok", "failed"] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type AuditPage = z.infer<typeof AuditPageSchema>;
export type AuditActionCount = z.infer<typeof AuditActionCountSchema>;

export type AuditFilters = {
  search: string;
  actions: string[];
  target: string;
  timeframe: AuditTimeframe;
  result: AuditResult;
  limit: number;
  offset: number;
};
