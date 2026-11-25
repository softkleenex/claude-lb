import { RotateCcw, ScrollText } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { AlertMessage } from "@/components/alert-message";
import { EmptyState } from "@/components/empty-state";
import { SearchInput } from "@/components/search-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SpinnerBlock } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { auditActionArea, auditActionLabel } from "@/features/audit/action-labels";
import { auditFiltersApplied, useAudit } from "@/features/audit/hooks/use-audit";
import { AUDIT_RESULTS, type AuditEvent, type AuditResult } from "@/features/audit/schemas";
import { MultiSelectFilter } from "@/features/dashboard/components/filters/multi-select-filter";
import { PaginationControls } from "@/features/dashboard/components/filters/pagination-controls";
import { TimeframeSelect } from "@/features/dashboard/components/filters/timeframe-select";
import { toIso } from "@/features/dashboard/utils";
import { useDateDisplayFormatStore } from "@/hooks/use-date-format";
import { cn } from "@/lib/utils";
import { formatDateTimeLines } from "@/utils/formatters";

const HEAD = "text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80";

const AREA_DOT: Record<string, string> = {
  account: "bg-sky-500",
  api_key: "bg-violet-500",
  auth: "bg-amber-500",
  health: "bg-emerald-500",
  settings: "bg-slate-400",
  sticky: "bg-pink-500",
};

function EventRow({ event }: { event: AuditEvent }) {
  const { t } = useTranslation();
  const dateDisplayFormat = useDateDisplayFormatStore((state) => state.dateDisplayFormat);
  const time = formatDateTimeLines(toIso(event.createdAt), dateDisplayFormat);
  return (
    <TableRow className="align-top" data-testid={`audit-row-${event.id}`}>
      <TableCell className="pl-4 align-top">
        <div className="leading-tight">
          <div className="text-sm font-medium">{time.primary}</div>
          <div className="text-xs text-muted-foreground">{time.secondary}</div>
        </div>
      </TableCell>
      <TableCell className="align-top">
        <div className="flex items-start gap-2">
          <span
            className={cn(
              "mt-1.5 h-2 w-2 shrink-0 rounded-full",
              AREA_DOT[auditActionArea(event.action)] ?? "bg-muted",
            )}
            aria-hidden="true"
          />
          <div className="min-w-0 leading-tight">
            <div className="text-sm">{auditActionLabel(t, event.action)}</div>
            <div className="truncate font-mono text-[11px] text-muted-foreground" translate="no">
              {event.action}
            </div>
          </div>
        </div>
      </TableCell>
      <TableCell className="max-w-0 align-top">
        <span className="block truncate text-sm" title={event.target || undefined}>
          {event.target || "—"}
        </span>
      </TableCell>
      <TableCell className="max-w-0 align-top">
        <span className="block break-words text-xs text-muted-foreground">{event.detail || "—"}</span>
      </TableCell>
      <TableCell className="align-top font-mono text-xs">{event.clientIp || "—"}</TableCell>
      <TableCell className="pr-4 align-top">
        {event.ok ? (
          <Badge variant="outline" className="border-emerald-500/30 text-emerald-700 dark:text-emerald-400">
            {t("audit.result.ok")}
          </Badge>
        ) : (
          <Badge variant="outline" className="border-red-500/30 text-red-700 dark:text-red-400">
            {t("audit.result.failed")}
          </Badge>
        )}
      </TableCell>
    </TableRow>
  );
}

export function AuditPage() {
  const { t } = useTranslation();
  const { filters, eventsQuery, actionsQuery, updateFilters, resetFilters } = useAudit();
  const page = eventsQuery.data;
  const applied = auditFiltersApplied(filters);

  const actionOptions = useMemo(
    () =>
      (actionsQuery.data ?? [])
        .map((item) => ({ value: item.action, label: `${auditActionLabel(t, item.action)} (${item.count})` }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [actionsQuery.data, t],
  );
  const onSearch = useCallback((search: string) => updateFilters({ search, offset: 0 }), [updateFilters]);
  const onTarget = useCallback((target: string) => updateFilters({ target, offset: 0 }), [updateFilters]);

  return (
    <div className="animate-fade-in-up min-w-0 space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <ScrollText className="h-5 w-5 text-primary" aria-hidden="true" />
          {t("audit.page.title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("audit.page.subtitle")}</p>
      </div>

      <div className="space-y-2 rounded-xl border bg-card p-3 sm:p-4">
        <div className="flex items-center gap-2">
          <SearchInput
            className="flex-1"
            name="audit-search"
            value={filters.search}
            onChange={onSearch}
            placeholder={t("audit.filters.searchPlaceholder")}
            ariaLabel={t("audit.filters.search")}
          />
          <TimeframeSelect
            value={filters.timeframe}
            onChange={(timeframe) => updateFilters({ timeframe, offset: 0 })}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MultiSelectFilter
            label={t("audit.filters.action")}
            values={filters.actions}
            options={actionOptions}
            onChange={(actions) => updateFilters({ actions, offset: 0 })}
          />
          <SearchInput
            className="w-40"
            icon={false}
            name="audit-target"
            value={filters.target}
            onChange={onTarget}
            placeholder={t("audit.filters.targetPlaceholder")}
            ariaLabel={t("audit.filters.target")}
          />
          <Select
            value={filters.result}
            onValueChange={(value) => updateFilters({ result: value as AuditResult, offset: 0 })}
          >
            <SelectTrigger size="sm" className="w-32" aria-label={t("audit.filters.result")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              {AUDIT_RESULTS.map((result) => (
                <SelectItem key={result} value={result}>
                  {t(`audit.filters.results.${result}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {applied ? (
            <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={resetFilters}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t("audit.filters.reset")}
            </Button>
          ) : null}
          {page ? (
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {t("audit.page.total", { count: page.total })}
            </span>
          ) : null}
        </div>
      </div>

      {eventsQuery.error && !page ? (
        <div className="space-y-3 rounded-xl border bg-card p-4">
          <div role="alert">
            <AlertMessage variant="error">{eventsQuery.error.message}</AlertMessage>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => void eventsQuery.refetch()}>
            {t("common.actions.retry")}
          </Button>
        </div>
      ) : !page ? (
        <div className="rounded-xl border bg-card py-8">
          <SpinnerBlock />
        </div>
      ) : page.events.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title={applied ? t("audit.empty.filteredTitle") : t("audit.empty.title")}
          description={applied ? t("audit.empty.filteredDescription") : t("audit.empty.description")}
        />
      ) : (
        <div className={cn("space-y-3 transition-opacity", eventsQuery.isPlaceholderData && "opacity-60")}>
          <div className="rounded-xl border bg-card">
            <div className="relative overflow-x-auto">
              <Table className="min-w-[860px] table-fixed">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className={cn("w-[13%] pl-4", HEAD)}>{t("audit.columns.time")}</TableHead>
                    <TableHead className={cn("w-[22%]", HEAD)}>{t("audit.columns.action")}</TableHead>
                    <TableHead className={cn("w-[16%]", HEAD)}>{t("audit.columns.target")}</TableHead>
                    <TableHead className={cn("w-[27%]", HEAD)}>{t("audit.columns.detail")}</TableHead>
                    <TableHead className={cn("w-[12%]", HEAD)}>{t("audit.columns.clientIp")}</TableHead>
                    <TableHead className={cn("w-[10%] pr-4", HEAD)}>{t("audit.columns.result")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {page.events.map((event) => (
                    <EventRow key={event.id} event={event} />
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">{t("audit.page.retentionNote")}</p>
            <PaginationControls
              total={page.total}
              limit={filters.limit}
              offset={filters.offset}
              hasMore={page.hasMore}
              onLimitChange={(limit) => updateFilters({ limit, offset: 0 })}
              onOffsetChange={(offset) => updateFilters({ offset })}
            />
          </div>
        </div>
      )}
    </div>
  );
}
