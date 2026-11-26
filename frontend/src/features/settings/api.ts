import { get, patch, post } from "@/lib/api-client";
import { SettingsEnvelopeSchema, type SettingsPatch } from "@/features/settings/schemas";

const SETTINGS_PATH = "/api/settings";

export function getSettings() {
  return get(SETTINGS_PATH, SettingsEnvelopeSchema);
}

export function updateSettings(changes: SettingsPatch) {
  return patch(SETTINGS_PATH, SettingsEnvelopeSchema, { body: changes });
}

/** Drops every stored override; the server falls back to its environment defaults. */
export function resetSettings() {
  return post(`${SETTINGS_PATH}/reset`, SettingsEnvelopeSchema);
}
