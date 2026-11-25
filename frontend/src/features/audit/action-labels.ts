import type { TFunction } from "i18next";

/**
 * Every action the backend records (`audit.service.record(action=…)`). Each has a
 * translated label under `audit.action.<action>`; anything else shows its raw code.
 */
export const KNOWN_AUDIT_ACTIONS = [
  "account.created",
  "account.deleted",
  "account.imported",
  "account.model_blocks_cleared",
  "account.probed",
  "account.quota_reset",
  "account.updated",
  "api_key.created",
  "api_key.deleted",
  "api_key.disabled",
  "api_key.enabled",
  "api_key.regenerated",
  "api_key.updated",
  "auth.guest_access_disabled",
  "auth.guest_access_enabled",
  "auth.guest_login",
  "auth.guest_password_cleared",
  "auth.guest_password_set",
  "auth.login",
  "auth.password_rotated",
  "auth.password_set",
  "auth.sessions_revoked",
  "auth.totp_disabled",
  "auth.totp_enabled",
  "auth.totp_enroll_started",
  "automation.created",
  "automation.deleted",
  "automation.disabled",
  "automation.enabled",
  "automation.run_now",
  "automation.updated",
  "firewall.entry_added",
  "firewall.entry_removed",
  "firewall.entry_updated",
  "firewall.mode_changed",
  "health.model_sync",
  "health.probe",
  "settings.reset",
  "settings.updated",
  "sticky.account_cleared",
  "sticky.deleted",
  "sticky.purged",
] as const;

export function auditActionLabel(t: TFunction, action: string): string {
  return t(`audit.action.${action}`, { defaultValue: action });
}

/** The area an action belongs to (`account`, `auth`, …), for the colour dot. */
export function auditActionArea(action: string): string {
  return action.split(".", 1)[0] ?? action;
}
