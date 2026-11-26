import { del, get, patch, post, put } from "@/lib/api-client";

import {
  FirewallCheckSchema,
  FirewallEntrySchema,
  type FirewallMode,
  FirewallStateSchema,
} from "@/features/firewall/schemas";

const BASE = "/api/firewall";

export function getFirewall() {
  return get(BASE, FirewallStateSchema);
}

export function checkFirewallEntry(network: string) {
  return get(`${BASE}/check?${new URLSearchParams({ network })}`, FirewallCheckSchema);
}

export function setFirewallMode(mode: FirewallMode) {
  return put(`${BASE}/mode`, FirewallStateSchema, { body: { mode } });
}

export function addFirewallEntry(network: string, note: string) {
  return post(`${BASE}/entries`, FirewallEntrySchema, { body: { network, note } });
}

export function updateFirewallEntry(entryId: string, note: string) {
  return patch(`${BASE}/entries/${encodeURIComponent(entryId)}`, FirewallEntrySchema, { body: { note } });
}

export function deleteFirewallEntry(entryId: string) {
  return del(`${BASE}/entries/${encodeURIComponent(entryId)}`);
}
