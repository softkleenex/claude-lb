import { z } from "zod";

/** `GET /health` and `GET /health/ready` (the latter answers 503 when the DB is down). */
export const HealthResponseSchema = z.object({
  status: z.string(),
  version: z.string().optional(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
