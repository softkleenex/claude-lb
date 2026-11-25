import { useTranslation } from "react-i18next";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "@/components/lazy-recharts";
import { useReducedMotion } from "@/hooks/use-reduced-motion";

import { shortDay } from "../date";
import type { DailyPoint } from "../schemas";
import { ChartTooltip } from "./chart-tooltip";
import { ReportChartCard } from "./report-chart-card";

export type DailySeries = {
  /** Field of the daily point to plot. */
  key: keyof DailyPoint;
  label: string;
  color: string;
  /** Lines suit medians (gaps where a day has no samples); areas suit sums. */
  kind?: "area" | "line";
};

export type DailyTrendChartProps = {
  id: string;
  title: string;
  subtitle?: string;
  note?: string;
  daily: DailyPoint[];
  series: DailySeries[];
  formatValue: (value: number) => string;
  formatAxis?: (value: number) => string;
  stacked?: boolean;
};

/** One chart of the report's zero-filled daily series. */
export function DailyTrendChart({
  id,
  title,
  subtitle,
  note,
  daily,
  series,
  formatValue,
  formatAxis = formatValue,
  stacked = false,
}: DailyTrendChartProps) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const data = daily.map((point) => {
    const row: Record<string, number | string | null> = { day: shortDay(point.day), fullDay: point.day };
    for (const entry of series) row[entry.key] = point[entry.key] as number | null;
    return row;
  });
  const empty = !data.some((row) => series.some((entry) => typeof row[entry.key] === "number" && row[entry.key] !== 0));
  const names = Object.fromEntries(series.map((entry) => [entry.key, entry.label]));

  return (
    <ReportChartCard
      title={title}
      subtitle={subtitle}
      note={note}
      empty={empty}
      testId={`report-chart-${id}`}
      legend={
        series.length > 1
          ? series.map((entry) => ({ label: entry.label, color: entry.color }))
          : undefined
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
          <defs>
            {series.map((entry) => (
              <linearGradient key={entry.key} id={`grad-${id}-${entry.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={entry.color} stopOpacity={0.28} />
                <stop offset="100%" stopColor={entry.color} stopOpacity={0.04} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" opacity={0.06} />
          <XAxis
            dataKey="day"
            tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            axisLine={false}
            tickLine={false}
            minTickGap={12}
          />
          <YAxis
            tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            axisLine={false}
            tickLine={false}
            width={48}
            tickFormatter={formatAxis}
          />
          <Tooltip
            content={<ChartTooltip names={names} formatValue={formatValue} emptyLabel={t("reports.charts.noSamples")} />}
          />
          {series.map((entry) =>
            entry.kind === "line" ? (
              <Line
                key={entry.key}
                type="monotone"
                dataKey={entry.key}
                stroke={entry.color}
                strokeWidth={2}
                dot={{ r: 2 }}
                connectNulls={false}
                isAnimationActive={!reducedMotion}
              />
            ) : (
              <Area
                key={entry.key}
                type="monotone"
                dataKey={entry.key}
                stackId={stacked ? "stack" : undefined}
                stroke={entry.color}
                strokeWidth={2}
                fill={`url(#grad-${id}-${entry.key})`}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 1.5 }}
                isAnimationActive={!reducedMotion}
              />
            ),
          )}
        </AreaChart>
      </ResponsiveContainer>
    </ReportChartCard>
  );
}
