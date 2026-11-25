import { RotateCcw } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  MultiSelectFilter,
  type MultiSelectOption,
} from "@/features/dashboard/components/filters/multi-select-filter";

import { MAX_REPORT_DAYS, dateRangeProblem, utcDateISO } from "../date";
import { REPORT_CHART_DEFINITIONS, type ReportChartId } from "../hooks/use-report-chart-visibility";
import { REPORT_PRESETS, type ReportPreset, type ReportUrlState } from "../hooks/use-reports";
import { REPORT_GROUPINGS, type ReportGrouping } from "../schemas";

export type ReportsFiltersProps = {
  state: ReportUrlState;
  accountOptions: MultiSelectOption[];
  apiKeyOptions: MultiSelectOption[];
  modelOptions: MultiSelectOption[];
  userAgentOptions: MultiSelectOption[];
  visibleChartIds: ReportChartId[];
  onPresetSelect: (preset: ReportPreset) => void;
  onRangeChange: (range: { start?: string; end?: string }) => void;
  onChange: (patch: Partial<ReportUrlState>) => void;
  onVisibleChartIdsChange: (ids: string[]) => void;
};

const DATE_INPUT =
  "h-8 rounded-md border bg-transparent px-2 text-xs text-foreground aria-invalid:border-destructive aria-invalid:ring-destructive/20";

export function ReportsFilters({
  state,
  accountOptions,
  apiKeyOptions,
  modelOptions,
  userAgentOptions,
  visibleChartIds,
  onPresetSelect,
  onRangeChange,
  onChange,
  onVisibleChartIdsChange,
}: ReportsFiltersProps) {
  const { t } = useTranslation();
  const errorId = useId();
  const today = utcDateISO();
  const problem = dateRangeProblem(state.start, state.end);
  const invalid = problem !== null;
  const filtered =
    state.accountIds.length + state.apiKeyIds.length + state.models.length + state.userAgents.length > 0;

  return (
    <div className="space-y-2 rounded-xl border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1" role="group" aria-label={t("reports.filters.presets")}>
          {REPORT_PRESETS.map((days) => (
            <Button
              key={days}
              type="button"
              variant={state.preset === days ? "default" : "outline"}
              size="sm"
              aria-pressed={state.preset === days}
              onClick={() => onPresetSelect(days)}
            >
              {t("reports.filters.preset", { days })}
            </Button>
          ))}
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              name="report-start-date"
              autoComplete="off"
              aria-label={t("reports.filters.startDate")}
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? errorId : undefined}
              max={today}
              value={state.start}
              onChange={(event) => onRangeChange({ start: event.target.value })}
              className={DATE_INPUT}
            />
            <span aria-hidden="true" className="text-xs text-muted-foreground">
              —
            </span>
            <input
              type="date"
              name="report-end-date"
              autoComplete="off"
              aria-label={t("reports.filters.endDate")}
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? errorId : undefined}
              max={today}
              value={state.end}
              onChange={(event) => onRangeChange({ end: event.target.value })}
              className={DATE_INPUT}
            />
            <span className="text-[11px] text-muted-foreground">{t("reports.filters.utc")}</span>
          </div>
          {problem ? (
            <p id={errorId} role="alert" className="text-xs text-destructive">
              {t(`reports.filters.dateError.${problem}`, { max: MAX_REPORT_DAYS })}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <MultiSelectFilter
          label={t("reports.filters.accounts")}
          values={state.accountIds}
          options={accountOptions}
          onChange={(accountIds) => onChange({ accountIds })}
        />
        <MultiSelectFilter
          label={t("reports.filters.apiKeys")}
          values={state.apiKeyIds}
          options={apiKeyOptions}
          onChange={(apiKeyIds) => onChange({ apiKeyIds })}
        />
        <MultiSelectFilter
          label={t("reports.filters.models")}
          values={state.models}
          options={modelOptions}
          onChange={(models) => onChange({ models })}
        />
        <MultiSelectFilter
          label={t("reports.filters.userAgents")}
          values={state.userAgents}
          options={userAgentOptions}
          onChange={(userAgents) => onChange({ userAgents })}
        />
        {filtered ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1 text-xs"
            onClick={() => onChange({ accountIds: [], apiKeyIds: [], models: [], userAgents: [] })}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            {t("reports.filters.clear")}
          </Button>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <Select value={state.groupBy} onValueChange={(value) => onChange({ groupBy: value as ReportGrouping })}>
            <SelectTrigger aria-label={t("reports.filters.groupBy")} className="h-8 w-auto min-w-40 text-xs">
              <span className="text-muted-foreground">{t("reports.filters.groupBy")}:</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REPORT_GROUPINGS.map((grouping) => (
                <SelectItem key={grouping} value={grouping} className="text-xs">
                  {t(`reports.groupBy.${grouping}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <MultiSelectFilter
            label={t("reports.filters.charts")}
            values={visibleChartIds}
            options={REPORT_CHART_DEFINITIONS.map(({ id, labelKey }) => ({ value: id, label: t(labelKey) }))}
            onChange={onVisibleChartIdsChange}
          />
        </div>
      </div>
    </div>
  );
}
