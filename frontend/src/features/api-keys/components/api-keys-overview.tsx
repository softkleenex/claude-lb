import { useTranslation } from "react-i18next";

import type { KeysOverview, KeyUsageRow } from "@/features/api-keys/schemas";
import { formatCompactNumber, formatCurrency } from "@/utils/formatters";

type RankMetric = "cost" | "tokens";

function Stat({ label, value, meta, testId }: { label: string; value: string; meta?: string; testId: string }) {
  return (
    <div className="rounded-xl border bg-card p-4" data-testid={testId}>
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-[1.55rem] font-semibold tracking-tight tabular-nums">{value}</p>
      {meta ? <p className="mt-1 text-xs text-muted-foreground">{meta}</p> : null}
    </div>
  );
}

function sharePercent(share: number): string {
  const percent = share * 100;
  return `${percent.toLocaleString(undefined, { maximumFractionDigits: percent < 10 ? 1 : 0 })}%`;
}

function Ranking({ title, subtitle, metric, rows }: { title: string; subtitle: string; metric: RankMetric; rows: KeyUsageRow[] }) {
  const { t } = useTranslation();
  const valueOf = (row: KeyUsageRow) => (metric === "cost" ? row.costUsd : row.totalTokens);
  const ranked = rows.filter((row) => valueOf(row) > 0).sort((a, b) => valueOf(b) - valueOf(a));
  const total = ranked.reduce((sum, row) => sum + valueOf(row), 0);

  return (
    <div className="rounded-xl border bg-card p-4" data-testid={`api-keys-ranking-${metric}`}>
      <div className="mb-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
      </div>
      {ranked.length === 0 ? (
        <div className="flex h-24 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
          {t("apiKeys.overview.noUsage")}
        </div>
      ) : (
        <ol className="max-h-72 space-y-3 overflow-y-auto pr-1">
          {ranked.map((row) => {
            const share = valueOf(row) / total;
            return (
              <li key={row.id} className="space-y-1.5">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate font-medium">
                    {row.name}
                    <span className="ml-1 font-mono text-muted-foreground">…{row.keyHint}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {metric === "cost" ? formatCurrency(row.costUsd) : formatCompactNumber(row.totalTokens)} ·{" "}
                    {sharePercent(share)}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(share * 100, 1)}%` }} />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

export function ApiKeysOverview({ overview }: { overview: KeysOverview }) {
  const { t } = useTranslation();
  return (
    <section className="space-y-4" aria-label={t("apiKeys.overview.title")}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat
          testId="api-keys-stat-total"
          label={t("apiKeys.overview.total")}
          value={formatCompactNumber(overview.total)}
          meta={t("apiKeys.overview.totalMeta", { disabled: overview.disabled, expired: overview.expired })}
        />
        <Stat
          testId="api-keys-stat-active"
          label={t("apiKeys.overview.active")}
          value={formatCompactNumber(overview.active)}
          meta={t("apiKeys.overview.activeMeta", { count: overview.usedLast7d })}
        />
        <Stat
          testId="api-keys-stat-idle"
          label={t("apiKeys.overview.idle")}
          value={formatCompactNumber(overview.idle)}
          meta={t("apiKeys.overview.idleMeta")}
        />
        <Stat
          testId="api-keys-stat-requests"
          label={t("apiKeys.overview.lifetimeRequests")}
          value={formatCompactNumber(overview.lifetimeRequests)}
          meta={t("apiKeys.overview.tokensMeta", { tokens: formatCompactNumber(overview.lifetimeTokens) })}
        />
        <Stat
          testId="api-keys-stat-cost"
          label={t("apiKeys.overview.lifetimeCost")}
          value={formatCurrency(overview.lifetimeCostUsd)}
          meta={t("apiKeys.overview.lifetimeCostMeta")}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Ranking
          metric="cost"
          title={t("apiKeys.overview.costByKey")}
          subtitle={t("apiKeys.overview.rankingSubtitle")}
          rows={overview.byKey}
        />
        <Ranking
          metric="tokens"
          title={t("apiKeys.overview.tokensByKey")}
          subtitle={t("apiKeys.overview.rankingSubtitle")}
          rows={overview.byKey}
        />
      </div>
    </section>
  );
}
