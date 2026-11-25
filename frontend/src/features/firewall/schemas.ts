import { z } from "zod";

/** `allow_all` or `allowlist` (only listed addresses may call `/v1/*`). */
export const FirewallModeSchema = z.enum(["allow_all", "allowlist"]);

export const FirewallEntrySchema = z.object({
  id: z.string(),
  network: z.string(),
  note: z.string(),
  version: z.number().int(),
  addresses: z.number(),
  coversClient: z.boolean().default(false),
  createdAt: z.string(),
});

/** `GET /api/firewall` (also returned by `PUT /api/firewall/mode`). */
export const FirewallStateSchema = z.object({
  mode: FirewallModeSchema,
  entries: z.array(FirewallEntrySchema),
  clientIp: z.string(),
  clientAllowed: z.boolean(),
  clientCovered: z.boolean(),
});

/** `GET /api/firewall/check?network=`. */
export const FirewallCheckSchema = z.object({
  network: z.string(),
  clientIp: z.string(),
  coversClient: z.boolean(),
  clientAllowedAfter: z.boolean(),
});

export type FirewallMode = z.infer<typeof FirewallModeSchema>;
export type FirewallEntry = z.infer<typeof FirewallEntrySchema>;
export type FirewallState = z.infer<typeof FirewallStateSchema>;
export type FirewallCheck = z.infer<typeof FirewallCheckSchema>;
