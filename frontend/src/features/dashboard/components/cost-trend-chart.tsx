import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "@/components/lazy-recharts";
import type { UsageTrendPoint } from "@/features/dashboard/schemas";
import { formatUsd } from "@/features/dashboard/utils";
import { useChartColors } from "@/hooks/use-chart-colors";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { formatCompactNumber } from "@/utils/formatters";

const CHART_MARGIN = { top: 4, right: 4, bottom: 0, left: 0 } as const;

type Point = UsageTrendPoint & { label: string };

function CostTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload?: Point }> }) {
  const { t } = useTranslation();
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-popover-foreground shadow-md">
      <p className="mb-1 text-[11px] text-muted-foreground">{point.day}</p>
      <p className="text-xs font-medium tabular-nums">{formatUsd(point.costUsd)}</p>
      <p className="text-xs tabular-nums text-muted-foreground">
        {t("dashboard.costTrend.requests", { count: point.requests, formatted: formatCompactNumber(point.requests) })}
      </p>
    </div>
  );
}

/** Daily cost from the rollups (not limited by request-log retention). */
export function CostTrendChart({ points }: { points: UsageTrendPoint[] }) {
  const { t } = useTranslation();
  const colors = useChartColors();
  const reducedMotion = useReducedMotion();
  const data = useMemo<Point[]>(() => points.map((point) => ({ ...point, label: point.day.slice(5) })), [points]);
  const total = points.reduce((sum, point) => sum + point.costUsd, 0);
  const hasData = points.some((point) => point.costUsd > 0 || point.requests > 0);

  return (
    <section className="min-w-0 rounded-xl border bg-card p-5" aria-label={t("dashboard.costTrend.title")}>
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{t("dashboard.costTrend.title")}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("dashboard.costTrend.subtitle", { days: points.length })}
          </p>
        </div>
        <p className="shrink-0 text-sm font-semibold tabular-nums" data-testid="cost-trend-total">
          {formatUsd(total)}
        </p>
      </div>
      {hasData ? (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={CHART_MARGIN}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" opacity={0.06} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              minTickGap={12}
            />
            <YAxis
              tickFormatter={(value: number) => `$${formatCompactNumber(value)}`}
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              width={44}
            />
            <Tooltip content={<CostTooltip />} cursor={{ fill: "currentColor", opacity: 0.04 }} />
            <Bar dataKey="costUsd" fill={colors[0]} radius={[3, 3, 0, 0]} isAnimationActive={!reducedMotion} />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <div className="flex h-[200px] items-center justify-center text-xs text-muted-foreground">
          {t("dashboard.costTrend.empty")}
        </div>
      )}
    </section>
  );
}
