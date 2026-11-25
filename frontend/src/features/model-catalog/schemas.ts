import { z } from "zod";

/** claude-lb `GET /api/health/catalog`, `POST /api/health/sync-models`, `POST /api/health/probe`. */

type Price = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  longContextThreshold?: number | null;
  longContext?: Price | null;
};

export const PriceSchema: z.ZodType<Price> = z.lazy(() =>
  z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite5m: z.number(),
    cacheWrite1h: z.number(),
    longContextThreshold: z.number().nullable().optional(),
    longContext: PriceSchema.nullable().optional(),
  }),
);

export const CatalogModelSchema = z.object({
  modelId: z.string(),
  displayName: z.string(),
  accounts: z.array(z.object({ id: z.string(), name: z.string() })),
  maxInputTokens: z.number().nullable(),
  maxOutputTokens: z.number().nullable(),
  syncedAt: z.string().nullable(),
  price: PriceSchema.nullable(),
  priceKey: z.string().nullable(),
});

export const CatalogSchema = z.object({
  models: z.array(CatalogModelSchema),
  prices: z.array(z.object({ model: z.string(), price: PriceSchema })),
  blocks: z.array(
    z.object({
      accountId: z.string(),
      accountName: z.string(),
      planType: z.string(),
      model: z.string(),
      until: z.string(),
    }),
  ),
  accounts: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      planType: z.string(),
      enabled: z.boolean(),
      paused: z.boolean(),
      models: z.number(),
      modelsSyncedAt: z.string().nullable(),
    }),
  ),
  lastSyncedAt: z.string().nullable(),
});

/** Account name → number of models synced. */
export const SyncResultSchema = z.record(z.string(), z.number());

export const ProbeResultSchema = z.array(
  z.object({
    accountId: z.string(),
    accountName: z.string(),
    ok: z.boolean(),
    statusCode: z.number().nullable(),
    detail: z.string(),
    models: z.number(),
  }),
);

export type ModelPrice = Price;
export type Catalog = z.infer<typeof CatalogSchema>;
export type CatalogModel = z.infer<typeof CatalogModelSchema>;
export type CatalogBlock = Catalog["blocks"][number];
export type CatalogAccount = Catalog["accounts"][number];
export type SyncResult = z.infer<typeof SyncResultSchema>;
export type ProbeResult = z.infer<typeof ProbeResultSchema>;
