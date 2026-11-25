import { ArrowDown, ArrowUp, ArrowUpDown, Download } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatRatio, formatUsd } from "@/features/dashboard/utils";
import { formatCompactNumber, formatNumber } from "@/utils/formatters";

import type { BreakdownRow, BreakdownTotal, ReportGrouping } from "../schemas";
import { formatGroupLabel } from "./group-label";

type SortKey =
  | "label"
  | "requests"
  | "errors"
  | "inputTokens"
  | "cacheReadInputTokens"
  | "cacheCreationInputTokens"
  | "outputTokens"
  | "cacheHitRate"
  | "cacheSavingsUsd"
  | "costUsd";

const NUMERIC_COLUMNS: Array<{ key: Exclude<SortKey, "label">; labelKey: string }> = [
  { key: "requests", labelKey: "reports.breakdown.columns.requests" },
  { key: "errors", labelKey: "reports.breakdown.columns.errors" },
  { key: "inputTokens", labelKey: "reports.breakdown.columns.input" },
  { key: "cacheReadInputTokens", labelKey: "reports.breakdown.columns.cacheRead" },
  { key: "cacheCreationInputTokens", labelKey: "reports.breakdown.columns.cacheWrite" },
  { key: "outputTokens", labelKey: "reports.breakdown.columns.output" },
  { key: "cacheHitRate", labelKey: "reports.breakdown.columns.cacheHit" },
  { key: "cacheSavingsUsd", labelKey: "reports.breakdown.columns.saved" },
  { key: "costUsd", labelKey: "reports.breakdown.columns.cost" },
];

const HEAD = "text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80";

function formatCell(key: Exclude<SortKey, "label">, row: BreakdownRow | BreakdownTotal): string {
  const value = row[key];
  if (key === "costUsd" || key === "cacheSavingsUsd") return formatUsd(value);
  if (key === "cacheHitRate") return formatRatio(value);
  if (key === "requests" || key === "errors") return formatNumber(value);
  return formatCompactNumber(value);
}

export type BreakdownTableProps = {
  groupBy: ReportGrouping;
  rows: BreakdownRow[];
  total: BreakdownTotal;
  csvUrl: string;
};

/** The grouped cost report (day / account / API key / model / user agent) with a totals row. */
export function BreakdownTable({ groupBy, rows, total, csvUrl }: BreakdownTableProps) {
  const { t } = useTranslation();
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean } | null>(null);

  const sorted = sort
    ? [...rows].sort((a, b) => {
        const order =
          sort.key === "label" ? a.label.localeCompare(b.label) : (a[sort.key] as number) - (b[sort.key] as number);
        return sort.desc ? -order : order;
      })
    : rows;

  const toggle = (key: SortKey) =>
    setSort((current) => (current?.key === key ? { key, desc: !current.desc } : { key, desc: key !== "label" }));

  const sortIcon = (key: SortKey) => {
    if (sort?.key !== key) return <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden />;
    return sort.desc ? <ArrowDown className="h-3 w-3" aria-hidden /> : <ArrowUp className="h-3 w-3" aria-hidden />;
  };
  const ariaSort = (key: SortKey) =>
    sort?.key === key ? (sort.desc ? "descending" : "ascending") : ("none" as const);

  return (
    <section className="min-w-0 rounded-xl border bg-card" aria-label={t("reports.breakdown.title")}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5 pb-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{t("reports.breakdown.title")}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("reports.breakdown.subtitle", { group: t(`reports.groupBy.${groupBy}`) })}
          </p>
        </div>
        <Button asChild variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
          <a href={csvUrl} download data-testid="report-csv-link">
            <Download className="h-3.5 w-3.5" aria-hidden />
            {t("reports.breakdown.csv")}
          </a>
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="px-5 pb-5 text-xs text-muted-foreground">{t("reports.breakdown.empty")}</p>
      ) : (
        <div className="max-h-[28rem] overflow-auto">
          <Table className="min-w-[880px]">
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow className="hover:bg-transparent">
                <TableHead className={`${HEAD} pl-5`} aria-sort={ariaSort("label")}>
                  <button type="button" className="inline-flex items-center gap-1" onClick={() => toggle("label")}>
                    {t(`reports.groupBy.${groupBy}`)}
                    {sortIcon("label")}
                  </button>
                </TableHead>
                {NUMERIC_COLUMNS.map((column, index) => (
                  <TableHead
                    key={column.key}
                    className={`${HEAD} text-right ${index === NUMERIC_COLUMNS.length - 1 ? "pr-5" : ""}`}
                    aria-sort={ariaSort(column.key)}
                  >
                    <button
                      type="button"
                      className="inline-flex items-center gap-1"
                      onClick={() => toggle(column.key)}
                    >
                      {t(column.labelKey)}
                      {sortIcon(column.key)}
                    </button>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((row) => (
                <TableRow key={row.key ?? "__none__"} data-testid="report-breakdown-row">
                  <TableCell
                    className={`pl-5 text-xs ${groupBy === "model" || groupBy === "user_agent" ? "font-mono" : ""}`}
                  >
                    {formatGroupLabel(t, row.label)}
                  </TableCell>
                  {NUMERIC_COLUMNS.map((column, index) => (
                    <TableCell
                      key={column.key}
                      className={`text-right text-xs tabular-nums ${index === NUMERIC_COLUMNS.length - 1 ? "pr-5 font-medium" : ""} ${
                        column.key === "cacheSavingsUsd" ? "text-emerald-600 dark:text-emerald-400" : ""
                      } ${column.key === "errors" && row.errors > 0 ? "text-red-600 dark:text-red-400" : ""}`}
                    >
                      {formatCell(column.key, row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
            <TableFooter className="sticky bottom-0 bg-muted/80 backdrop-blur">
              <TableRow data-testid="report-breakdown-total">
                <TableCell className="pl-5 text-xs font-semibold">{t("reports.breakdown.total")}</TableCell>
                {NUMERIC_COLUMNS.map((column, index) => (
                  <TableCell
                    key={column.key}
                    className={`text-right text-xs font-semibold tabular-nums ${index === NUMERIC_COLUMNS.length - 1 ? "pr-5" : ""}`}
                  >
                    {formatCell(column.key, total)}
                  </TableCell>
                ))}
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      )}
    </section>
  );
}
