import { z } from "zod";

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const RunStatusSchema = z.enum(["pending", "running", "success", "failed", "skipped"]);
export const CycleStatusSchema = z.enum(["pending", "running", "success", "partial", "failed", "skipped"]);

export const ScheduleSchema = z.object({
  days: z.array(z.enum(WEEKDAYS)),
  time: z.string(),
  timezone: z.string(),
  spreadMinutes: z.number().int(),
});

export const RunSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  jobName: z.string(),
  cycleKey: z.string(),
  trigger: z.enum(["scheduled", "manual"]),
  status: RunStatusSchema,
  scheduledFor: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  accountId: z.string().nullable(),
  accountName: z.string(),
  model: z.string(),
  httpStatus: z.number().int().nullable(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
  durationMs: z.number().nullable(),
  error: z.string().nullable(),
});

export const CycleSchema = z.object({
  cycleKey: z.string(),
  jobId: z.string(),
  jobName: z.string(),
  trigger: z.enum(["scheduled", "manual"]),
  status: CycleStatusSchema,
  scheduledFor: z.string(),
  finishedAt: z.string().nullable(),
  total: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
  pending: z.number().int(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
  runs: z.array(RunSchema),
});

export const JobSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  schedule: ScheduleSchema,
  model: z.string(),
  prompt: z.string(),
  maxTokens: z.number().int(),
  accountIds: z.array(z.string()),
  includePausedAccounts: z.boolean(),
  targets: z.array(z.object({ id: z.string(), name: z.string(), planType: z.string(), paused: z.boolean() })),
  missingAccountIds: z.array(z.string()),
  nextRunAt: z.string().nullable(),
  lastCycle: CycleSchema.nullable(),
  estimate: z.object({
    promptTokens: z.number(),
    perRequestUsd: z.number(),
    apiAccounts: z.number().int(),
    subscriptionAccounts: z.number().int(),
    perRunUsd: z.number(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** `GET /api/automations`. */
export const JobsResponseSchema = z.object({
  jobs: z.array(JobSchema),
  total: z.number().int(),
  maxTokensCap: z.number().int(),
  maxSpreadMinutes: z.number().int(),
  minIntervalMinutes: z.number().int(),
});

/** `GET /api/automations/runs` — runs grouped into cycles, newest first. */
export const CyclesResponseSchema = z.object({
  cycles: z.array(CycleSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
  hasMore: z.boolean(),
});

export const RunNowResponseSchema = z.object({ cycleKey: z.string(), runs: z.number().int() });

export type RunStatus = z.infer<typeof RunStatusSchema>;
export type CycleStatus = z.infer<typeof CycleStatusSchema>;
export type AutomationRun = z.infer<typeof RunSchema>;
export type AutomationCycle = z.infer<typeof CycleSchema>;
export type AutomationJob = z.infer<typeof JobSchema>;
export type JobsResponse = z.infer<typeof JobsResponseSchema>;
export type CyclesResponse = z.infer<typeof CyclesResponseSchema>;

/** Body of `POST /api/automations` (and, partially, `PATCH`). camelCase; the client snakifies. */
export type JobInput = {
  name: string;
  enabled: boolean;
  schedule: { days: Weekday[]; time: string; timezone: string; spreadMinutes: number };
  model: string;
  prompt: string;
  maxTokens: number;
  accountIds: string[];
  includePausedAccounts: boolean;
};

export type RunFilters = {
  jobId: string[];
  status: string[];
  trigger: string | null;
  limit: number;
  offset: number;
};
