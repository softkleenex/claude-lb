import { KeyRound, Pause, Pencil, Play, RefreshCw, Trash2 } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";

import { AlertMessage } from "@/components/alert-message";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useNow } from "@/features/accounts/lib/time";
import type { ApiKey, KeyTrends } from "@/features/api-keys/schemas";
import type { AccountCostDonutProps } from "@/features/apis/components/account-cost-donut";
import { ApiKeyInfo } from "@/features/apis/components/api-key-info";
import { ApiKeyLimits } from "@/features/apis/components/api-key-limits";
import type { ApiTrendChartProps } from "@/features/apis/components/api-trend-chart";
import { KeyStatusBadge } from "@/features/apis/components/key-status-badge";
import { formatCompactNumber, formatCurrency, formatNumber } from "@/utils/formatters";

const AccountCostDonut = lazy(() =>
  import("@/features/apis/components/account-cost-donut").then((module) => ({
    default: (props: AccountCostDonutProps) => <module.AccountCostDonut {...props} />,
  })),
);
const ApiTrendChart = lazy(() =>
  import("@/features/apis/components/api-trend-chart").then((module) => ({
    default: (props: ApiTrendChartProps) => <module.ApiTrendChart {...props} />,
  })),
);

export type ApiDetailProps = {
  apiKey: ApiKey | null;
  trends?: KeyTrends | null;
  trendsLoading?: boolean;
  trendsError?: string | null;
  busy: boolean;
  onEdit: (apiKey: ApiKey) => void;
  onDelete: (apiKey: ApiKey) => void;
  onRegenerate: (apiKey: ApiKey) => void;
  onToggleEnabled: (apiKey: ApiKey) => void;
};

function Total({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

export function ApiDetail({
  apiKey,
  trends,
  trendsLoading = false,
  trendsError = null,
  busy,
  onEdit,
  onDelete,
  onRegenerate,
  onToggleEnabled,
}: ApiDetailProps) {
  const { t } = useTranslation();
  const now = useNow();
  const [accumulated, setAccumulated] = useState(false);

  if (!apiKey) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed p-12">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted">
          <KeyRound className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="mt-3 text-sm font-medium text-muted-foreground">{t("apis.detail.emptyTitle")}</p>
        <p className="mt-1 text-xs text-muted-foreground/70">{t("apis.detail.emptyDescription")}</p>
      </div>
    );
  }

  const totals = trends?.totals;
  const hasCost = (trends?.byAccount ?? []).some((row) => row.costUsd > 0);

  return (
    <div key={apiKey.id} className="animate-fade-in-up min-w-0 space-y-4 rounded-xl border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-base font-semibold">{apiKey.name}</h2>
          <KeyStatusBadge status={apiKey.status} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => onEdit(apiKey)} disabled={busy}>
            <Pencil className="h-3.5 w-3.5" />
            {t("common.actions.edit")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-xs"
            onClick={() => onToggleEnabled(apiKey)}
            disabled={busy}
          >
            {apiKey.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {apiKey.enabled ? t("apis.detail.disable") : t("apis.detail.enable")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-xs"
            onClick={() => onRegenerate(apiKey)}
            disabled={busy}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t("apis.detail.regenerate")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            className="h-8 gap-1.5 text-xs"
            onClick={() => onDelete(apiKey)}
            disabled={busy}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("common.actions.delete")}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ApiKeyInfo apiKey={apiKey} now={now} />
        <ApiKeyLimits limits={apiKey.limits} now={now} />
      </div>

      {trendsError ? <AlertMessage variant="error">{trendsError}</AlertMessage> : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="api-7d-totals">
        <Total label={t("apis.detail.requests7d")} value={totals ? formatNumber(totals.requests) : "—"} />
        <Total label={t("apis.detail.tokens7d")} value={totals ? formatCompactNumber(totals.totalTokens) : "—"} />
        <Total label={t("apis.detail.cost7d")} value={totals ? formatCurrency(totals.costUsd) : "—"} />
        <Total label={t("apis.detail.errors7d")} value={totals ? formatNumber(totals.errors) : "—"} />
      </div>

      <div className="min-w-0 rounded-xl border p-4 lg:flex lg:items-start lg:gap-4" data-testid="api-usage-panel">
        {hasCost && trends ? (
          <div className="lg:w-[32%] lg:shrink-0">
            <Suspense fallback={<div className="h-[240px]" />}>
              <AccountCostDonut accountCosts={trends.byAccount} totalCostUsd={trends.totals.costUsd} />
            </Suspense>
          </div>
        ) : null}
        <div
          className={hasCost ? "mt-4 min-w-0 flex-1 border-t pt-4 lg:mt-0 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-4" : "min-w-0 flex-1"}
          data-testid="api-trend-panel"
        >
          <div className="mb-3 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <h3 className="text-sm font-semibold">{t("apis.detail.usageTrend")}</h3>
              <p className="text-xs text-muted-foreground">{t("apis.detail.usageTrendDescription")}</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-full bg-chart-2" />
                  {t("apis.trend.tokens")}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-full bg-chart-1" />
                  {t("apis.trend.cost")}
                </span>
              </div>
              <div className="flex items-center gap-1.5 rounded-md border px-2 py-1">
                <span id="api-trend-accumulated-label" className="text-[10px]">
                  {t("apis.detail.accumulated")}
                </span>
                <Switch
                  size="sm"
                  aria-labelledby="api-trend-accumulated-label"
                  checked={accumulated}
                  onCheckedChange={setAccumulated}
                />
              </div>
            </div>
          </div>
          {trends ? (
            <Suspense fallback={<div className="h-[280px]" />}>
              <ApiTrendChart usage={trends.usage} accumulated={accumulated} />
            </Suspense>
          ) : (
            <div className="flex h-[280px] items-center justify-center text-xs text-muted-foreground">
              {trendsLoading ? t("apis.detail.loadingUsage") : t("apis.detail.usageUnavailable")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
