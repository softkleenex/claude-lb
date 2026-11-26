import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Cell, Pie, PieChart, ResponsiveContainer, Sector, type PieSectorShapeProps } from "@/components/lazy-recharts";
import { formatUsd } from "@/features/dashboard/utils";
import { useChartColors } from "@/hooks/use-chart-colors";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { formatCompactNumber } from "@/utils/formatters";

import type { DistributionEntry } from "../schemas";
import { DistributionMetricToggle, type DistributionMetric } from "./distribution-metric-toggle";
import { ReportChartCard } from "./report-chart-card";

export type DistributionDonutProps = {
  id: string;
  title: string;
  note?: string;
  entries: DistributionEntry[];
  /** Renders an entry's label (e.g. "(unknown)" → translated). */
  formatLabel?: (entry: DistributionEntry) => string;
};

const EXTRA_COLORS = ["#06b6d4", "#84cc16", "#f97316", "#a855f7", "#64748b"];
const ACTIVE_OFFSET = 4;

function metricValue(entry: DistributionEntry, metric: DistributionMetric): number {
  if (metric === "cost") return entry.costUsd;
  if (metric === "tokens") return entry.totalTokens;
  return entry.requests;
}

function formatMetric(value: number, metric: DistributionMetric): string {
  return metric === "cost" ? formatUsd(value) : formatCompactNumber(value);
}

/** Share of cost, tokens or requests per model / user agent, with a metric toggle. */
export function DistributionDonut({ id, title, note, entries, formatLabel }: DistributionDonutProps) {
  const { t } = useTranslation();
  const colors = useChartColors();
  const reducedMotion = useReducedMotion();
  const [metric, setMetric] = useState<DistributionMetric>("cost");
  const [activeId, setActiveId] = useState<string | null>(null);
  const palette = [...colors, ...EXTRA_COLORS];

  const sorted = [...entries].sort((a, b) => metricValue(b, metric) - metricValue(a, metric));
  const total = sorted.reduce((sum, entry) => sum + metricValue(entry, metric), 0);
  const data = sorted.map((entry, index) => ({
    id: entry.key ?? `__none_${index}`,
    name: formatLabel ? formatLabel(entry) : entry.label,
    value: metricValue(entry, metric),
    fill: palette[index % palette.length],
  }));

  const renderSlice = (props: PieSectorShapeProps) => {
    const datum = props.payload as { id?: string } | undefined;
    const highlighted = props.isActive || datum?.id === activeId;
    const outer = typeof props.outerRadius === "number" ? props.outerRadius : 65;
    return <Sector {...props} outerRadius={outer + (highlighted ? ACTIVE_OFFSET : 0)} />;
  };

  return (
    <ReportChartCard title={title} note={note} empty={total <= 0} testId={`report-chart-${id}`} autoHeight>
      <div className="flex h-full min-w-0 flex-col">
        <div className="flex justify-end">
          <DistributionMetricToggle metric={metric} onChange={setMetric} label={t("reports.distribution.metricLabel")} />
        </div>
        <div className="mt-2 flex min-w-0 flex-1 flex-col items-stretch gap-4 sm:flex-row sm:items-center">
          <div className="relative h-[140px] w-[140px] shrink-0 self-center">
            <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center text-center">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {t("reports.distribution.total")}
              </span>
              <span
                className="max-w-[80px] text-sm font-semibold leading-tight tabular-nums"
                data-testid={`${id}-total`}
              >
                {formatMetric(total, metric)}
              </span>
            </div>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={45}
                  outerRadius={64}
                  strokeWidth={0}
                  shape={renderSlice}
                  isAnimationActive={!reducedMotion}
                  onMouseEnter={(entry: { id: string }) => setActiveId(entry.id)}
                  onMouseLeave={() => setActiveId(null)}
                >
                  {data.map((entry) => (
                    <Cell key={entry.id} fill={entry.fill} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="max-h-[150px] min-w-0 flex-1 overflow-y-auto text-xs" data-testid={`${id}-legend`}>
            {data.map((entry) => (
              <li
                key={entry.id}
                className="flex h-7 min-w-0 items-center justify-between gap-2 rounded-md px-1.5 data-[active=true]:bg-muted/60"
                data-active={activeId === entry.id}
                onMouseEnter={() => setActiveId(entry.id)}
                onMouseLeave={() => setActiveId(null)}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: entry.fill }} />
                  <span className="truncate" title={entry.name}>
                    {entry.name}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2 tabular-nums">
                  <span className="text-muted-foreground">
                    {total > 0 ? `${((entry.value / total) * 100).toFixed(1)}%` : "—"}
                  </span>
                  <span className="font-medium">{formatMetric(entry.value, metric)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </ReportChartCard>
  );
}
