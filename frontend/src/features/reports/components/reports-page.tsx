import { Info, RefreshCw } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { AlertMessage } from "@/components/alert-message";
import { Button } from "@/components/ui/button";
import { formatMs, formatUsd } from "@/features/dashboard/utils";
import { useChartColors } from "@/hooks/use-chart-colors";
import { formatCompactNumber } from "@/utils/formatters";
import { getErrorMessageOrNull } from "@/utils/errors";

import { reportCsvUrl } from "../api";
import { useReportChartVisibility } from "../hooks/use-report-chart-visibility";
import { reportFiltersOf, useReport, useReportOptions, useReportState } from "../hooks/use-reports";
import { BreakdownTable } from "./breakdown-table";
import { DailyTrendChart } from "./daily-trend-chart";
import { DistributionDonut } from "./distribution-donut";
import { formatGroupLabel } from "./group-label";
import { ReportsFilters } from "./reports-filters";
import { ReportsSummaryCards } from "./reports-summary-cards";

const ERROR_COLOR = "#ef4444";

export function ReportsPage() {
  const { t } = useTranslation();
  const colors = useChartColors();
  const { state, update, selectPreset, setRange } = useReportState();
  const { visibleChartIds, setVisibleChartIds } = useReportChartVisibility();
  const reportQuery = useReport(state);
  const optionsQuery = useReportOptions(state.start, state.end);
  const report = reportQuery.data;
  const visible = new Set(visibleChartIds);

  const options = optionsQuery.data;
  const accountOptions = useMemo(
    () => (options?.accounts ?? []).map((account) => ({ value: account.id, label: formatGroupLabel(t, account.name) })),
    [options, t],
  );
  const apiKeyOptions = useMemo(
    () =>
      (options?.apiKeys ?? []).map((key) => ({
        value: key.id,
        label: key.keyHint ? `${formatGroupLabel(t, key.name)} · ${key.keyHint}` : formatGroupLabel(t, key.name),
      })),
    [options, t],
  );
  const modelOptions = useMemo(() => (options?.models ?? []).map((m) => ({ value: m, label: m })), [options]);
  const userAgentOptions = useMemo(
    () => (options?.userAgents ?? []).map((ua) => ({ value: ua, label: formatGroupLabel(t, ua) })),
    [options, t],
  );

  const error = getErrorMessageOrNull(reportQuery.error) ?? getErrorMessageOrNull(optionsQuery.error);
  const logNote =
    report && report.coverage.logsTruncated && report.source === "rollups"
      ? t("reports.coverage.chartNote", { date: report.coverage.logsFrom })
      : undefined;

  return (
    <div className="mx-auto w-full max-w-[1500px] flex-1 space-y-5 px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{t("reports.page.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("reports.page.subtitle")}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={reportQuery.isFetching}
          onClick={() => {
            void reportQuery.refetch();
            void optionsQuery.refetch();
          }}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${reportQuery.isFetching ? "animate-spin" : ""}`} aria-hidden />
          {t("reports.page.refresh")}
        </Button>
      </div>

      <ReportsFilters
        state={state}
        accountOptions={accountOptions}
        apiKeyOptions={apiKeyOptions}
        modelOptions={modelOptions}
        userAgentOptions={userAgentOptions}
        visibleChartIds={visibleChartIds}
        onPresetSelect={selectPreset}
        onRangeChange={setRange}
        onChange={update}
        onVisibleChartIdsChange={setVisibleChartIds}
      />

      {error ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <AlertMessage variant="error" className="flex-1">
            {t("reports.errors.data", { error })}
          </AlertMessage>
          <Button type="button" variant="outline" size="sm" onClick={() => void reportQuery.refetch()}>
            {t("common.actions.retry")}
          </Button>
        </div>
      ) : null}

      {report ? (
        <>
          {report.source === "request_logs" ? (
            <Notice testId="report-source-notice">
              {t("reports.coverage.logsOnly", { days: report.coverage.retentionDays })}
            </Notice>
          ) : report.coverage.logsTruncated ? (
            <Notice testId="report-coverage-notice">
              {t("reports.coverage.truncated", { date: report.coverage.logsFrom, days: report.coverage.retentionDays })}
            </Notice>
          ) : null}

          <ReportsSummaryCards summary={report.summary} previous={report.previous} />

          {visibleChartIds.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {visible.has("costByDay") ? (
                <DailyTrendChart
                  id="costByDay"
                  title={t("reports.charts.costByDay")}
                  subtitle={t("reports.charts.costSubtitle", { cost: formatUsd(report.summary.totalCostUsd) })}
                  daily={report.daily}
                  series={[
                    { key: "costUsd", label: t("reports.charts.cost"), color: colors[0] },
                    { key: "cacheSavingsUsd", label: t("reports.charts.saved"), color: colors[2] },
                  ]}
                  formatValue={formatUsd}
                  formatAxis={(value) => `$${formatCompactNumber(value)}`}
                />
              ) : null}
              {visible.has("tokensByDay") ? (
                <DailyTrendChart
                  id="tokensByDay"
                  title={t("reports.charts.tokensByDay")}
                  daily={report.daily}
                  stacked
                  series={[
                    { key: "inputTokens", label: t("reports.charts.input"), color: colors[1] },
                    { key: "cacheReadInputTokens", label: t("reports.charts.cacheRead"), color: colors[2] },
                    { key: "cacheCreationInputTokens", label: t("reports.charts.cacheWrite"), color: colors[3] },
                    { key: "outputTokens", label: t("reports.charts.output"), color: colors[4] },
                  ]}
                  formatValue={formatCompactNumber}
                />
              ) : null}
              {visible.has("requestsByDay") ? (
                <DailyTrendChart
                  id="requestsByDay"
                  title={t("reports.charts.requestsByDay")}
                  daily={report.daily}
                  series={[
                    { key: "requests", label: t("reports.charts.requests"), color: colors[0] },
                    { key: "errors", label: t("reports.charts.errors"), color: ERROR_COLOR },
                  ]}
                  formatValue={formatCompactNumber}
                />
              ) : null}
              {visible.has("timeToFirstToken") ? (
                <DailyTrendChart
                  id="timeToFirstToken"
                  title={t("reports.charts.timeToFirstToken")}
                  subtitle={t("reports.charts.ttftSubtitle", { value: formatMs(report.summary.medianTtftMs) })}
                  note={logNote}
                  daily={report.daily}
                  series={[{ key: "medianTtftMs", label: t("reports.charts.medianTtft"), color: colors[3], kind: "line" }]}
                  formatValue={formatMs}
                  formatAxis={(value) => `${(value / 1000).toFixed(1)}s`}
                />
              ) : null}
              {visible.has("tokensPerSecond") ? (
                <DailyTrendChart
                  id="tokensPerSecond"
                  title={t("reports.charts.tokensPerSecond")}
                  subtitle={t("reports.charts.tpsSubtitle", {
                    value: report.summary.medianTps == null ? "—" : report.summary.medianTps.toFixed(1),
                  })}
                  note={logNote}
                  daily={report.daily}
                  series={[{ key: "medianTps", label: t("reports.charts.medianTps"), color: colors[1], kind: "line" }]}
                  formatValue={(value) => t("reports.charts.tpsValue", { value: value.toFixed(1) })}
                  formatAxis={(value) => value.toFixed(0)}
                />
              ) : null}
              {visible.has("modelDistribution") ? (
                <DistributionDonut
                  id="modelDistribution"
                  title={t("reports.distribution.byModel")}
                  entries={report.byModel}
                  formatLabel={(entry) => formatGroupLabel(t, entry.label)}
                />
              ) : null}
              {visible.has("userAgentDistribution") ? (
                <DistributionDonut
                  id="userAgentDistribution"
                  title={t("reports.distribution.byUserAgent")}
                  note={logNote}
                  entries={report.byUserAgent}
                  formatLabel={(entry) => formatGroupLabel(t, entry.label)}
                />
              ) : null}
            </div>
          ) : null}

          <BreakdownTable
            groupBy={report.groupBy}
            rows={report.breakdown}
            total={report.breakdownTotal}
            csvUrl={reportCsvUrl(reportFiltersOf(state))}
          />
        </>
      ) : reportQuery.isLoading ? (
        <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">{t("common.loading")}</div>
      ) : null}
    </div>
  );
}

function Notice({ children, testId }: { children: string; testId: string }) {
  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
      data-testid={testId}
      role="note"
    >
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </div>
  );
}
