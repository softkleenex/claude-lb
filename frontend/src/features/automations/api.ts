import { del, get, patch, post } from "@/lib/api-client";

import {
  CyclesResponseSchema,
  type JobInput,
  JobSchema,
  JobsResponseSchema,
  type RunFilters,
  RunNowResponseSchema,
} from "@/features/automations/schemas";

const BASE = "/api/automations";

export function listJobs() {
  return get(BASE, JobsResponseSchema);
}

export function createJob(input: JobInput) {
  return post(BASE, JobSchema, { body: input });
}

export function updateJob(jobId: string, changes: Partial<JobInput>) {
  return patch(`${BASE}/${encodeURIComponent(jobId)}`, JobSchema, { body: changes });
}

export function deleteJob(jobId: string) {
  return del(`${BASE}/${encodeURIComponent(jobId)}`);
}

export function runJobNow(jobId: string) {
  return post(`${BASE}/${encodeURIComponent(jobId)}/run`, RunNowResponseSchema);
}

export function listRuns(filters: RunFilters) {
  const params = new URLSearchParams();
  for (const id of filters.jobId) params.append("job_id", id);
  for (const status of filters.status) params.append("status", status);
  if (filters.trigger) params.set("trigger", filters.trigger);
  params.set("limit", String(filters.limit));
  params.set("offset", String(filters.offset));
  return get(`${BASE}/runs?${params}`, CyclesResponseSchema);
}
