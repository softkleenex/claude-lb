import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { formatAbsolute, formatAgo, formatUntil } from "@/features/accounts/lib/time";
import { useAccounts } from "@/features/accounts/hooks/use-accounts";
import type { ApiKey } from "@/features/api-keys/schemas";
import { cn } from "@/lib/utils";
import { formatCompactNumber, formatCurrency, formatNumber } from "@/utils/formatters";

function Row({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="flex items-start justify-between gap-3" data-testid={testId}>
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium break-words">{children}</dd>
    </div>
  );
}

export function ApiKeyInfo({ apiKey, now }: { apiKey: ApiKey; now: number }) {
  const { t } = useTranslation();
  const { data: accounts } = useAccounts();
  const accountName = (id: string) =>
    accounts?.find((account) => account.id === id)?.name ?? t("apiKeys.accountSelect.deleted");

  const expiresIn = formatUntil(apiKey.expiresAt, now);
  const lastUsed = formatAgo(apiKey.lastUsedAt, now);
  const assigned = apiKey.assignedAccountIds ?? (apiKey.pinnedAccountId ? [apiKey.pinnedAccountId] : null);

  return (
    <div className="space-y-4 rounded-lg border bg-muted/30 p-4" data-testid="api-key-info">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("apis.keyInfo.title")}</h3>
      <dl className="space-y-2 text-xs">
        <Row label={t("apis.keyInfo.secret")}>
          <span className="font-mono">clb_…{apiKey.keyHint}</span>
        </Row>
        <Row label={t("apis.keyInfo.created")}>{formatAbsolute(apiKey.createdAt)}</Row>
        <Row label={t("apis.keyInfo.expires")} testId="key-info-expires">
          {apiKey.expiresAt ? (
            <span className={cn(apiKey.status === "expired" && "text-red-600 dark:text-red-400")}>
              {formatAbsolute(apiKey.expiresAt)}
              <span className="ml-1 font-normal text-muted-foreground">
                {expiresIn ? t("apis.keyInfo.inDuration", { duration: expiresIn }) : t("apiKeys.status.expired")}
              </span>
            </span>
          ) : (
            t("apis.keyInfo.never")
          )}
        </Row>
        <Row label={t("apis.keyInfo.lastUsed")}>{lastUsed ?? t("apis.keyInfo.neverUsed")}</Row>
        <Row label={t("apiKeys.form.allowedModels")} testId="key-info-models">
          {apiKey.allowedModels ? (
            <span className="font-mono">{apiKey.allowedModels.join(", ")}</span>
          ) : (
            t("apiKeys.modelSelect.all")
          )}
        </Row>
        {apiKey.enforcedModel ? (
          <Row label={t("apiKeys.form.enforcedModel")}>
            <span className="font-mono">{apiKey.enforcedModel}</span>
          </Row>
        ) : null}
        <Row label={t("apiKeys.form.assignedAccounts")} testId="key-info-accounts">
          {assigned ? assigned.map(accountName).join(", ") : t("apiKeys.accountSelect.all")}
        </Row>
        <div className="border-t pt-2" />
        <Row label={t("apis.keyInfo.lifetime")}>
          <span className="tabular-nums">
            {t("apis.keyInfo.requests", {
              count: apiKey.lifetimeRequests,
              formatted: formatNumber(apiKey.lifetimeRequests),
            })}
            <span className="mx-1 text-muted-foreground/50">·</span>
            {t("apis.keyInfo.tokens", { tokens: formatCompactNumber(apiKey.totalTokens) })}
            <span className="mx-1 text-muted-foreground/50">·</span>
            {formatCurrency(apiKey.lifetimeCostUsd)}
          </span>
        </Row>
      </dl>
    </div>
  );
}
