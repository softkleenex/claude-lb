import { get, post } from "@/lib/api-client";

import { CatalogSchema, ProbeResultSchema, SyncResultSchema } from "@/features/model-catalog/schemas";

export function getCatalog() {
  return get("/api/health/catalog", CatalogSchema);
}

/** Keys are account names (data), so they must not be camelized. */
export function syncModels() {
  return post("/api/health/sync-models", SyncResultSchema, { rawKeys: true });
}

export function probeUnhealthy() {
  return post("/api/health/probe", ProbeResultSchema);
}
