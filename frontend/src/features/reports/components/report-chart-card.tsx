import { BarChart3 } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "@/components/empty-state";

export type ReportChartCardProps = {
  title: string;
  subtitle?: string;
  /** Small caveat under the chart (e.g. limited by log retention). */
  note?: string;
  empty: boolean;
  testId?: string;
  legend?: Array<{ label: string; color: string }>;
  /** Cartesian charts need a fixed height; a donut with its legend sizes itself. */
  autoHeight?: boolean;
  children: ReactNode;
};

export function ReportChartCard({ title, subtitle, note, empty, testId, legend, autoHeight = false, children }: ReportChartCardProps) {
  const { t } = useTranslation();

  return (
    <section className="min-w-0 rounded-xl border bg-card p-5" aria-label={title} data-testid={testId}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {subtitle ? <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p> : null}
        </div>
        {legend && !empty ? (
          <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            {legend.map((entry) => (
              <li key={entry.label} className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: entry.color }} />
                {entry.label}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {empty ? (
        <div className="mt-4">
          <EmptyState
            icon={BarChart3}
            title={t("reports.charts.emptyTitle")}
            description={t("reports.charts.emptyDescription")}
          />
        </div>
      ) : (
        <div className={autoHeight ? "mt-4 min-h-[200px]" : "mt-4 h-[200px]"}>{children}</div>
      )}
      {note ? <p className="mt-2 text-[11px] text-muted-foreground">{note}</p> : null}
    </section>
  );
}
