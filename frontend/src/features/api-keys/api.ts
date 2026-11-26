import { del, get, patch, post } from "@/lib/api-client";

import {
  ApiKeyCreateRequestSchema,
  ApiKeyCreatedSchema,
  ApiKeyListSchema,
  ApiKeySchema,
  ApiKeyUpdateRequestSchema,
  CatalogModelListSchema,
  KeysOverviewSchema,
  KeyTrendsSchema,
} from "@/features/api-keys/schemas";

export const API_KEYS_BASE_PATH = "/api/keys";

function keyPath(keyId: string): string {
  return `${API_KEYS_BASE_PATH}/${encodeURIComponent(keyId)}`;
}

export function listApiKeys() {
  return get(API_KEYS_BASE_PATH, ApiKeyListSchema);
}

export function getKeysOverview() {
  return get(`${API_KEYS_BASE_PATH}/overview`, KeysOverviewSchema);
}

export function createApiKey(payload: unknown) {
  return post(API_KEYS_BASE_PATH, ApiKeyCreatedSchema, { body: ApiKeyCreateRequestSchema.parse(payload) });
}

export function updateApiKey(keyId: string, payload: unknown) {
  return patch(keyPath(keyId), ApiKeySchema, { body: ApiKeyUpdateRequestSchema.parse(payload) });
}

export function deleteApiKey(keyId: string) {
  return del(keyPath(keyId));
}

export function regenerateApiKey(keyId: string) {
  return post(`${keyPath(keyId)}/regenerate`, ApiKeyCreatedSchema);
}

export function getApiKeyTrends(keyId: string, days = 7) {
  return get(`${keyPath(keyId)}/trends?days=${days}`, KeyTrendsSchema);
}

export function listCatalogModels() {
  return get("/api/health/models", CatalogModelListSchema);
}
