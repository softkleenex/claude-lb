import type { TFunction } from "i18next";

const DELETED = /^\(deleted: (.+)\)$/;

/** Translate the server's placeholder labels; real names and dates pass through. */
export function formatGroupLabel(t: TFunction, label: string): string {
  if (label === "(unattributed)") return t("reports.labels.unattributed");
  if (label === "(unknown)") return t("reports.labels.unknownUserAgent");
  const deleted = DELETED.exec(label);
  if (deleted) return t("reports.labels.deleted", { id: deleted[1] });
  return label;
}
