import { get } from "@/lib/api-client";

import { HealthResponseSchema } from "@/features/health/schemas";

export function getHealth() {
  return get("/health", HealthResponseSchema);
}

/** Process up *and* database reachable. */
export function getServiceReadiness() {
  return get("/health/ready", HealthResponseSchema);
}
