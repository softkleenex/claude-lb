import { z } from "zod";

/** Mirrors `claude_lb.modules.proxy.load_balancer.STRATEGIES` (the server sends the live list too). */
export const ROUTING_STRATEGIES = [
  "capacity_weighted",
  "relative_availability",
  "usage_weighted",
  "reset_drain",
  "sequential_drain",
  "round_robin",
  "least_used",
  "fill_first",
  "single_account",
] as const;

export type KnownRoutingStrategy = (typeof ROUTING_STRATEGIES)[number];

export function isKnownRoutingStrategy(value: string): value is KnownRoutingStrategy {
  return (ROUTING_STRATEGIES as readonly string[]).includes(value);
}

/** Bounds from `claude_lb.modules.settings.service.RuntimeSettings`. */
export const SETTINGS_LIMITS = {
  maxAttempts: { min: 1, max: 10 },
  stickyTtlSeconds: { min: 0, max: 24 * 3600 },
  healthProbeIntervalSeconds: { min: 30, max: 3600 },
  modelSyncIntervalSeconds: { min: 300, max: 24 * 3600 },
  requestLogRetentionDays: { min: 1, max: 3650 },
} as const;

/** `RuntimeSettings` (after the api-client's snake_case → camelCase conversion). */
export const RuntimeSettingsSchema = z.object({
  // A string, not an enum: a newer server may offer strategies this build does not know.
  routingStrategy: z.string(),
  maxAttempts: z.number().int(),
  stickySessionsEnabled: z.boolean(),
  stickyTtlSeconds: z.number().int(),
  healthProbeEnabled: z.boolean(),
  healthProbeIntervalSeconds: z.number().int(),
  modelSyncEnabled: z.boolean(),
  modelSyncIntervalSeconds: z.number().int(),
  requestLogRetentionDays: z.number().int(),
});

/** `GET/PATCH /api/settings` and `POST /api/settings/reset`. */
export const SettingsEnvelopeSchema = z.object({
  settings: RuntimeSettingsSchema,
  availableStrategies: z.array(z.string()),
});

export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;
export type SettingsEnvelope = z.infer<typeof SettingsEnvelopeSchema>;
/** `PATCH /api/settings` body: only the keys present are written. */
export type SettingsPatch = Partial<RuntimeSettings>;
