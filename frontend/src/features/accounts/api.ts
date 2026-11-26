import { z } from "zod";

import { del, get, patch, post } from "@/lib/api-client";
import { camelizeKeys } from "@/lib/casing";

import {
  AccountListSchema,
  AccountProbeResponseSchema,
  AccountSchema,
  AccountTrendsSchema,
  PoolQuotaSchema,
  type AccountCreateRequest,
  type AccountImportRequest,
  type AccountUpdateRequest,
} from "@/features/accounts/schemas";

const BASE = "/api/accounts";

function accountPath(accountId: string, suffix = ""): string {
  return `${BASE}/${encodeURIComponent(accountId)}${suffix}`;
}

export function listAccounts() {
  return get(BASE, AccountListSchema);
}

export function createAccount(payload: AccountCreateRequest) {
  return post(BASE, AccountSchema, { body: payload });
}

/**
 * The credential bundle's keys are data (`claudeAiOauth.accessToken`, `refresh_token`…),
 * so this request skips key conversion and spells the envelope in snake_case itself.
 */
export async function importAccount(payload: AccountImportRequest) {
  const body: Record<string, unknown> = {
    name: payload.name,
    credentials: payload.credentials,
  };
  if (payload.planType) body.plan_type = payload.planType;
  if (payload.routingPolicy) body.routing_policy = payload.routingPolicy;
  if (payload.transport) body.transport = payload.transport;
  const raw = await post(`${BASE}/import`, z.unknown(), { body, rawKeys: true });
  return AccountSchema.parse(camelizeKeys(raw));
}

export function updateAccount(accountId: string, payload: AccountUpdateRequest) {
  return patch(accountPath(accountId), AccountSchema, { body: payload });
}

export function deleteAccount(accountId: string, deleteHistory = false) {
  return del(accountPath(accountId, deleteHistory ? "?delete_history=true" : ""));
}

export function probeAccount(accountId: string) {
  return post(accountPath(accountId, "/probe"), AccountProbeResponseSchema);
}

export function resetAccountQuota(accountId: string) {
  return post(accountPath(accountId, "/reset-quota"), AccountSchema);
}

export function clearModelBlocks(accountId: string, model?: string) {
  const query = model ? `?model=${encodeURIComponent(model)}` : "";
  return del(accountPath(accountId, `/model-blocks${query}`), AccountSchema);
}

export function getAccountTrends(accountId: string, days = 7) {
  return get(accountPath(accountId, `/trends?days=${days}`), AccountTrendsSchema);
}

export function getPoolQuota() {
  return get("/api/usage/quota", PoolQuotaSchema);
}
