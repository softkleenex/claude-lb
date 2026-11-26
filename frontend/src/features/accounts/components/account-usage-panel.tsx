import { Clock } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { Account, AccountTrends } from "@/features/accounts/schemas";
import { UsageBar } from "@/features/accounts/components/account-quota-bars";
import { formatAbsolute, formatAgo, formatUntil } from "@/features/accounts/lib/time";
import { isSubscription } from "@/features/accounts/status";
import { formatCompactNumber, formatCurrency, formatNumber } from "@/utils/formatters";
import { parseServerDate } from "@/utils/server-date";

function WindowRow({
  label,
  usedPercent,
  resetAt,
  now,
}: {
  label: string;
  usedPercent: number | null;
  resetAt: string | null;
  now: number;
}) {
  const { t } = useTranslation();
  const until = formatUntil(resetAt, now);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums font-medium">
          {usedPercent === null ? t("accounts.quota.notObserved") : t("accounts.quota.used", { percent: Math.round(usedPercent) })}
        </span>
      </div>
      <UsageBar usedPercent={usedPercent} label={t("accounts.quota.usedAria", { label })} />
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span>
          {until
            ? t("accounts.quota.resetsAtIn", { time: formatAbsolute(resetAt), label: until })
            : t("accounts.quota.noReset")}
        </span>
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-3 text-xs">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium">{children}</dd>
    </div>
  );
}

function headerStatusLabel(value: string | null, t: ReturnType<typeof useTranslation>["t"]): string {
  if (!value) return t("accounts.usage.notReported");
  return t(`accounts.unified.${value}`, { defaultValue: value });
}

export type AccountUsagePanelProps = {
  account: Account;
  now: number;
  trends?: AccountTrends | null;
};

/** Quota windows, rate-limit headroom, credential and lifetime totals for one account. */
export function AccountUsagePanel({ account, now, trends }: AccountUsagePanelProps) {
  const { t } = useTranslation();
  const subscription = isSubscription(account);
  const showWindows = subscription || account.primaryUsedPercent !== null || account.secondaryUsedPercent !== null;
  const showRateLimits = account.rlRequestsLimit !== null || account.rlTokensLimit !== null || !subscription;
  const expiresAt = parseServerDate(account.credentialExpiresAt);
  const expiresIn = formatUntil(account.credentialExpiresAt, now);
  const observed = formatAgo(account.quotaObservedAt, now);

  return (
    <section className="min-w-0 space-y-4 rounded-lg border bg-muted/30 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t("accounts.usage.title")}
        </h3>
        {observed ? (
          <span className="text-[11px] text-muted-foreground">{t("accounts.usage.observed", { label: observed })}</span>
        ) : null}
      </div>

      {showWindows ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <WindowRow
              label={t("accounts.quota.fiveHourLong")}
              usedPercent={account.primaryUsedPercent}
              resetAt={account.primaryResetAt}
              now={now}
            />
            <WindowRow
              label={t("accounts.quota.sevenDayLong")}
              usedPercent={account.secondaryUsedPercent}
              resetAt={account.secondaryResetAt}
              now={now}
            />
          </div>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
            <Fact label={t("accounts.usage.unifiedStatus")}>{headerStatusLabel(account.unifiedStatus, t)}</Fact>
            <Fact label={t("accounts.usage.overageStatus")}>{headerStatusLabel(account.overageStatus, t)}</Fact>
          </dl>
        </>
      ) : null}

      {showRateLimits ? (
        <div className="space-y-1.5 rounded-md border bg-background/60 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("accounts.usage.rateLimits")}
          </p>
          {account.rlRequestsLimit === null && account.rlTokensLimit === null ? (
            <p className="text-xs text-muted-foreground">{t("accounts.usage.rateLimitsEmpty")}</p>
          ) : (
            <dl className="space-y-1.5">
              {account.rlRequestsLimit !== null ? (
                <Fact label={t("accounts.usage.requestsRemaining")}>
                  {formatNumber(account.rlRequestsRemaining ?? 0)} / {formatNumber(account.rlRequestsLimit)}
                </Fact>
              ) : null}
              {account.rlTokensLimit !== null ? (
                <Fact label={t("accounts.usage.tokensRemaining")}>
                  {formatCompactNumber(account.rlTokensRemaining ?? 0)} / {formatCompactNumber(account.rlTokensLimit)}
                </Fact>
              ) : null}
              {account.rlResetAt ? (
                <Fact label={t("accounts.usage.rateLimitReset")}>{formatAbsolute(account.rlResetAt)}</Fact>
              ) : null}
              <Fact label={t("accounts.usage.headroom")}>{Math.round(account.headroom * 100)}%</Fact>
            </dl>
          )}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 rounded-md border bg-background/60 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("accounts.usage.lifetime")}
          </p>
          <dl className="space-y-1.5">
            <Fact label={t("accounts.usage.requests")}>{formatNumber(account.totalRequests)}</Fact>
            <Fact label={t("accounts.usage.tokens")}>
              {t("accounts.usage.tokensInOut", {
                input: formatCompactNumber(account.totalInputTokens),
                output: formatCompactNumber(account.totalOutputTokens),
              })}
            </Fact>
            <Fact label={t("accounts.usage.cost")}>{formatCurrency(account.totalCostUsd)}</Fact>
            <Fact label={t("accounts.usage.lastUsed")}>
              {formatAgo(account.lastUsedAt, now) ?? t("accounts.usage.never")}
            </Fact>
          </dl>
        </div>
        <div className="space-y-1.5 rounded-md border bg-background/60 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("accounts.usage.window", { days: trends?.days ?? 7 })}
          </p>
          {trends ? (
            <dl className="space-y-1.5">
              <Fact label={t("accounts.usage.requests")}>{formatNumber(trends.totals.requests)}</Fact>
              <Fact label={t("accounts.usage.errors")}>{formatNumber(trends.totals.errors)}</Fact>
              <Fact label={t("accounts.usage.tokens")}>
                {t("accounts.usage.tokensInOut", {
                  input: formatCompactNumber(trends.totals.inputTokens),
                  output: formatCompactNumber(trends.totals.outputTokens),
                })}
              </Fact>
              <Fact label={t("accounts.usage.cost")}>{formatCurrency(trends.totals.costUsd)}</Fact>
            </dl>
          ) : (
            <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
          )}
        </div>
      </div>

      <div className="space-y-1.5 rounded-md border bg-background/60 px-3 py-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("accounts.usage.credential")}
        </p>
        <dl className="space-y-1.5">
          <Fact label={t("accounts.usage.credentialType")}>
            {subscription ? t("accounts.provider.subscriptionToken") : t("accounts.provider.consoleKey")}
          </Fact>
          <Fact label={t("accounts.usage.credentialHint")}>
            <code className="font-mono">{account.credentialHint || "—"}</code>
          </Fact>
          <Fact label={t("accounts.usage.expires")}>
            {expiresAt
              ? expiresIn
                ? t("accounts.usage.expiresAtIn", { time: formatAbsolute(expiresAt), label: expiresIn })
                : t("accounts.usage.expired", { time: formatAbsolute(expiresAt) })
              : t("accounts.usage.noExpiry")}
          </Fact>
          {account.refreshFailures > 0 ? (
            <Fact label={t("accounts.usage.refreshFailures")}>{account.refreshFailures}</Fact>
          ) : null}
          {account.baseUrl ? <Fact label={t("accounts.usage.baseUrl")}>{account.baseUrl}</Fact> : null}
          <Fact label={t("accounts.usage.added")}>{formatAbsolute(account.createdAt)}</Fact>
        </dl>
      </div>
    </section>
  );
}
