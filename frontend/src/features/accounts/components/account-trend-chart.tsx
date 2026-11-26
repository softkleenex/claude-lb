import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "@/components/lazy-recharts";
import { useChartColors } from "@/hooks/use-chart-colors";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import type { AccountTrends } from "@/features/accounts/schemas";
import { formatAbsolute } from "@/features/accounts/lib/time";
import { formatCurrency } from "@/utils/formatters";
import { parseServerDate } from "@/utils/server-date";

const CHART_MARGIN = { top: 4, right: 8, bottom: 0, left: 0 } as const;

type QuotaPoint = { t: number; primary: number | null; secondary: number | null };

type TooltipEntry = { dataKey?: string | number; value?: number; color?: string; name?: string };

function QuotaTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipEntry[]; label?: number }) {
  if (!active || !payload?.length || label === undefined) return null;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-popover-foreground shadow-md">
      <p className="mb-1 text-[11px] text-muted-foreground">{formatAbsolute(new Date(label))}</p>
      {payload.map((entry) => (
        <div key={String(entry.dataKey)} className="flex items-center gap-2 text-xs">
          <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: entry.color }} />
          <span className="text-muted-foreground">{entry.name}</span>
          <span className="ml-auto tabular-nums font-medium">
            {typeof entry.value === "number" ? `${entry.value.toFixed(1)}%` : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

function UsageTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipEntry[]; label?: string }) {
  const { t } = useTranslation();
  if (!active || !payload?.length) return null;
  const entry = payload[0] as TooltipEntry & { payload?: { requests: number; costUsd: number } };
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-popover-foreground shadow-md">
      <p className="mb-1 text-[11px] text-muted-foreground">{label}</p>
      <p className="text-xs tabular-nums">{t("accounts.trend.requestsValue", { count: entry.payload?.requests ?? 0 })}</p>
      <p className="text-xs tabular-nums">{formatCurrency(entry.payload?.costUsd ?? 0)}</p>
    </div>
  );
}

export type AccountTrendChartProps = {
  trends: AccountTrends;
  /** Draw the 5h/7d utilization chart (subscriptions); otherwise only daily requests. */
  showQuota: boolean;
};

/** 7-day 5h/7d utilization (hourly maxima) and daily request counts for one account. */
export function AccountTrendChart({ trends, showQuota }: AccountTrendChartProps) {
  const { t } = useTranslation();
  const colors = useChartColors();
  const reducedMotion = useReducedMotion();

  const quota = useMemo<QuotaPoint[]>(
    () =>
      trends.quota
        .map((point) => ({
          t: parseServerDate(point.t)?.getTime() ?? 0,
          primary: point.primaryUsedPercent,
          secondary: point.secondaryUsedPercent,
        }))
        .filter((point) => point.t > 0),
    [trends.quota],
  );
  const usage = useMemo(
    () => trends.usage.map((day) => ({ ...day, label: day.day.slice(5) })),
    [trends.usage],
  );
  const hasUsage = usage.some((day) => day.requests > 0);

  return (
    <section className="space-y-4 rounded-lg border bg-muted/30 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {t("accounts.trend.title", { days: trends.days })}
      </h3>

      {showQuota ? (
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs font-medium">{t("accounts.trend.utilization")}</p>
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: colors[0] }} />
                {t("accounts.quota.fiveHour")}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: colors[1] }} />
                {t("accounts.quota.sevenDay")}
              </span>
            </div>
          </div>
          {quota.length === 0 ? (
            <div className="flex h-[160px] items-center justify-center text-xs text-muted-foreground">
              {t("accounts.trend.noQuota")}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={quota} margin={CHART_MARGIN}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" opacity={0.06} />
                <XAxis
                  dataKey="t"
                  type="number"
                  scale="time"
                  domain={["dataMin", "dataMax"]}
                  tickFormatter={(value: number) => formatAbsolute(new Date(value)).split(/,\s*/)[0] ?? ""}
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={40}
                />
                <YAxis
                  domain={[0, 100]}
                  ticks={[0, 25, 50, 75, 100]}
                  tickFormatter={(value: number) => `${value}%`}
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  tickLine={false}
                  axisLine={false}
                  width={38}
                />
                <Tooltip content={<QuotaTooltip />} />
                <Area
                  type="monotone"
                  dataKey="primary"
                  name={t("accounts.quota.fiveHour")}
                  stroke={colors[0]}
                  fill={colors[0]}
                  fillOpacity={0.08}
                  strokeWidth={1.5}
                  dot={false}
                  connectNulls
                  isAnimationActive={!reducedMotion}
                />
                <Area
                  type="monotone"
                  dataKey="secondary"
                  name={t("accounts.quota.sevenDay")}
                  stroke={colors[1]}
                  fill={colors[1]}
                  fillOpacity={0.08}
                  strokeWidth={1.5}
                  dot={false}
                  connectNulls
                  isAnimationActive={!reducedMotion}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      ) : null}

      <div>
        <p className="mb-2 text-xs font-medium">{t("accounts.trend.dailyRequests")}</p>
        {hasUsage ? (
          <ResponsiveContainer width="100%" height={120}>
            <BarChart data={usage} margin={CHART_MARGIN}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" opacity={0.06} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={false}
                width={38}
              />
              <Tooltip content={<UsageTooltip />} cursor={{ fill: "currentColor", opacity: 0.04 }} />
              <Bar dataKey="requests" fill={colors[0]} radius={[3, 3, 0, 0]} isAnimationActive={!reducedMotion} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-[80px] items-center justify-center text-xs text-muted-foreground">
            {t("accounts.trend.noUsage")}
          </div>
        )}
      </div>
    </section>
  );
}
