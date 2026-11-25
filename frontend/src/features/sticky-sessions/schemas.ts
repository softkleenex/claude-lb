import { z } from "zod";

/** claude-lb `GET /api/sticky-sessions` (the in-memory conversation → account map). */

export const StickyEntrySchema = z.object({
  key: z.string(),
  accountId: z.string(),
  accountName: z.string().nullable(),
  expiresAt: z.string(),
  remainingSeconds: z.number(),
  expired: z.boolean(),
});

export const StickyPageSchema = z.object({
  entries: z.array(StickyEntrySchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
  size: z.number(),
  expiredCount: z.number(),
  capacity: z.number(),
  enabled: z.boolean(),
  ttlSeconds: z.number(),
  byAccount: z.array(z.object({ accountId: z.string(), accountName: z.string().nullable(), entries: z.number() })),
});

export const DeletedCountSchema = z.object({ deletedCount: z.number() });

export type StickyEntry = z.infer<typeof StickyEntrySchema>;
export type StickyPage = z.infer<typeof StickyPageSchema>;

export type StickyFilters = {
  accountId: string | null;
  search: string;
  includeExpired: boolean;
  limit: number;
  offset: number;
};
