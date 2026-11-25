import { del, get, post } from "@/lib/api-client";

import { DeletedCountSchema, StickyPageSchema, type StickyFilters } from "@/features/sticky-sessions/schemas";

const PATH = "/api/sticky-sessions";

export function listStickySessions(filters: StickyFilters) {
  const query = new URLSearchParams();
  query.set("limit", String(filters.limit));
  query.set("offset", String(filters.offset));
  if (filters.accountId) query.set("account_id", filters.accountId);
  if (filters.search.trim()) query.set("search", filters.search.trim());
  if (!filters.includeExpired) query.set("include_expired", "false");
  return get(`${PATH}?${query.toString()}`, StickyPageSchema);
}

export function deleteStickySession(key: string) {
  return del(`${PATH}/${encodeURIComponent(key)}`);
}

export function deleteStickySessions(keys: string[]) {
  return post(`${PATH}/delete`, DeletedCountSchema, { body: { keys } });
}

export function deleteAccountStickySessions(accountId: string) {
  return post(`${PATH}/delete-account`, DeletedCountSchema, { body: { accountId } });
}

export function purgeExpiredStickySessions() {
  return post(`${PATH}/purge`, DeletedCountSchema);
}
