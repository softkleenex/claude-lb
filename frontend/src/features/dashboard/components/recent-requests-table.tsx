import { Inbox } from "lucide-react";
import { useMemo, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PlanBadge } from "@/features/accounts/components/account-badges";
import { PaginationControls } from "@/features/dashboard/components/filters/pagination-controls";
import { RequestStatusBadge } from "@/features/dashboard/components/request-status-badge";
import {
  ALL_REQUEST_LOG_COLUMNS,
  MAX_REQUEST_LOG_COLUMN_WIDTH,
  MIN_REQUEST_LOG_COLUMN_WIDTH,
  REQUEST_LOG_COLUMN_DEFAULT_WIDTHS,
  REQUEST_LOG_COLUMN_WIDTH_STEP,
  clampRequestLogColumnWidth,
  type RequestLogColumnId,
  type RequestLogColumnWidths,
} from "@/features/dashboard/request-log-columns";
import type { RequestLog } from "@/features/dashboard/schemas";
import { formatMs, formatUsd, toIso } from "@/features/dashboard/utils";
import { useDateDisplayFormatStore } from "@/hooks/use-date-format";
import { cn } from "@/lib/utils";
import { formatCompactNumber, formatDateTimeLines } from "@/utils/formatters";

export type RecentRequestsTableProps = {
  requests: RequestLog[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  filtersApplied?: boolean;
  visibleColumns?: readonly RequestLogColumnId[];
  columnWidths?: RequestLogColumnWidths;
  onColumnWidthChange?: (column: RequestLogColumnId, width: number) => void;
  onLimitChange: (limit: number) => void;
  onOffsetChange: (offset: number) => void;
  onSelect: (requestId: string) => void;
};

type RequestLogTableHeadProps = {
  column: RequestLogColumnId;
  label: string;
  resizeLabel: string;
  className?: string;
  width?: number;
  onWidthChange?: (column: RequestLogColumnId, width: number) => void;
};

function RequestLogTableHead({
  column,
  label,
  resizeLabel,
  className,
  width,
  onWidthChange,
}: RequestLogTableHeadProps) {
  const resizeState = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const resolvedWidth = clampRequestLogColumnWidth(
    width ?? REQUEST_LOG_COLUMN_DEFAULT_WIDTHS[column],
  );

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!onWidthChange) {
      return;
    }

    event.preventDefault();
    const measuredWidth = event.currentTarget.parentElement?.getBoundingClientRect().width;
    resizeState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: measuredWidth && measuredWidth > 0 ? measuredWidth : resolvedWidth,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = resizeState.current;
    if (!state || state.pointerId !== event.pointerId || !onWidthChange) {
      return;
    }

    onWidthChange(
      column,
      clampRequestLogColumnWidth(state.startWidth + event.clientX - state.startX),
    );
  };

  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (resizeState.current?.pointerId !== event.pointerId) {
      return;
    }

    resizeState.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onWidthChange || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) {
      return;
    }

    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    onWidthChange(
      column,
      clampRequestLogColumnWidth(
        resolvedWidth + direction * REQUEST_LOG_COLUMN_WIDTH_STEP,
      ),
    );
  };

  return (
    <TableHead
      aria-label={label}
      className={cn(
        "relative text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80",
        className,
      )}
      style={onWidthChange ? { width: resolvedWidth } : undefined}
    >
      {label}
      {onWidthChange ? (
        <div
          role="separator"
          aria-label={resizeLabel}
          aria-orientation="vertical"
          aria-valuemin={MIN_REQUEST_LOG_COLUMN_WIDTH}
          aria-valuemax={MAX_REQUEST_LOG_COLUMN_WIDTH}
          aria-valuenow={resolvedWidth}
          tabIndex={0}
          className="group absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize touch-none select-none outline-none"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onLostPointerCapture={() => {
            resizeState.current = null;
          }}
          onKeyDown={handleKeyDown}
        >
          <span
            aria-hidden="true"
            className="absolute left-1/2 top-1 h-[calc(100%-0.5rem)] w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-primary group-focus-visible:bg-primary"
          />
        </div>
      ) : null}
    </TableHead>
  );
}


const RIGHT = new Set<RequestLogColumnId>(["latency", "ttft", "tokens", "cost", "attempts"]);

function Cell({ request, column, onSelect }: { request: RequestLog; column: RequestLogColumnId; onSelect: (id: string) => void }) {
  const { t } = useTranslation();
  const dateDisplayFormat = useDateDisplayFormatStore((state) => state.dateDisplayFormat);
  switch (column) {
    case "time": {
      const time = formatDateTimeLines(toIso(request.createdAt), dateDisplayFormat);
      return (
        <div className="leading-tight">
          <div className="text-sm font-medium tabular-nums">{time.primary}</div>
          <div className="text-xs text-muted-foreground">{time.secondary}</div>
        </div>
      );
    }
    case "account":
      return (
        <span className="block truncate text-sm" title={request.accountName ?? undefined}>
          {request.accountName ?? (request.accountId ? t("dashboard.requests.deletedAccount") : t("dashboard.requests.unassigned"))}
        </span>
      );
    case "plan":
      return request.planType ? <PlanBadge planType={request.planType} /> : <span className="text-xs text-muted-foreground">—</span>;
    case "apiKey":
      return (
        <span className="block truncate text-xs text-muted-foreground" title={request.apiKeyName ?? undefined}>
          {request.apiKeyName ?? "—"}
        </span>
      );
    case "model":
      return (
        <div className="min-w-0 leading-tight">
          <span className="block truncate font-mono text-xs" title={request.model ?? undefined}>
            {request.model ?? "—"}
          </span>
          {request.streaming ? (
            <span className="text-[11px] text-muted-foreground">{t("dashboard.requests.streaming")}</span>
          ) : null}
        </div>
      );
    case "status":
      return <RequestStatusBadge status={request.status} statusCode={request.statusCode} />;
    case "latency":
      return <span className="font-mono text-xs tabular-nums">{formatMs(request.durationMs)}</span>;
    case "ttft":
      return <span className="font-mono text-xs tabular-nums">{formatMs(request.ttftMs)}</span>;
    case "tokens":
      return (
        <div className="font-mono text-xs leading-tight tabular-nums">
          <div>{formatCompactNumber(request.totalTokens)}</div>
          {request.cacheReadInputTokens > 0 ? (
            <div className="text-[11px] text-muted-foreground">
              {t("dashboard.requests.cachedShort", { tokens: formatCompactNumber(request.cacheReadInputTokens) })}
            </div>
          ) : null}
        </div>
      );
    case "cost":
      return (
        <div className="font-mono text-xs leading-tight tabular-nums">
          <div>{formatUsd(request.costUsd)}</div>
          {request.cacheSavingsUsd > 0 ? (
            <div className="text-[11px] text-emerald-600 dark:text-emerald-400">
              {t("dashboard.requests.savedShort", { amount: formatUsd(request.cacheSavingsUsd) })}
            </div>
          ) : null}
        </div>
      );
    case "attempts":
      return (
        <span className={cn("font-mono text-xs tabular-nums", request.attempts > 1 && "text-amber-600 dark:text-amber-400")}>
          {request.attempts}
        </span>
      );
    case "details":
      return (
        <div className="flex min-w-0 items-center gap-2">
          {request.error ? (
            <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={request.error}>
              {request.error}
            </p>
          ) : (
            <span className="flex-1" />
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-2 text-[11px]"
            onClick={() => onSelect(request.id)}
          >
            {t("dashboard.requests.viewDetails")}
          </Button>
        </div>
      );
  }
}

export function RecentRequestsTable({
  requests,
  total,
  limit,
  offset,
  hasMore,
  filtersApplied = false,
  visibleColumns: configuredVisibleColumns,
  columnWidths,
  onColumnWidthChange,
  onLimitChange,
  onOffsetChange,
  onSelect,
}: RecentRequestsTableProps) {
  const { t } = useTranslation();
  const visibleColumns = configuredVisibleColumns ?? ALL_REQUEST_LOG_COLUMNS;
  const tableWidth = useMemo(
    () =>
      visibleColumns.reduce(
        (sum, column) =>
          sum + clampRequestLogColumnWidth(columnWidths?.[column] ?? REQUEST_LOG_COLUMN_DEFAULT_WIDTHS[column]),
        0,
      ),
    [visibleColumns, columnWidths],
  );

  if (requests.length === 0) {
    const filtered = filtersApplied || total > 0;
    return (
      <EmptyState
        icon={Inbox}
        title={filtered ? t("dashboard.requests.emptyFilteredTitle") : t("dashboard.requests.emptyTitle")}
        description={
          filtered ? t("dashboard.requests.emptyFilteredDescription") : t("dashboard.requests.emptyDescription")
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border bg-card">
        <div className="relative overflow-x-auto">
          <Table className="w-full table-fixed" style={{ width: tableWidth, minWidth: "100%" }}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {visibleColumns.map((column, index) => {
                  const label = t(`dashboard.requests.columns.${column}`);
                  return (
                    <RequestLogTableHead
                      key={column}
                      column={column}
                      label={label}
                      resizeLabel={t("dashboard.requests.resizeColumn", { column: label })}
                      className={cn(
                        index === 0 && "pl-4",
                        index === visibleColumns.length - 1 && "pr-4",
                        RIGHT.has(column) && "text-right",
                      )}
                      width={columnWidths?.[column]}
                      onWidthChange={onColumnWidthChange}
                    />
                  );
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.map((request) => (
                <TableRow
                  key={request.id}
                  data-testid={`request-row-${request.id}`}
                  className="cursor-pointer"
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest("button, a")) return;
                    onSelect(request.id);
                  }}
                >
                  {visibleColumns.map((column, index) => (
                    <TableCell
                      key={column}
                      className={cn(
                        "align-top",
                        index === 0 && "pl-4",
                        index === visibleColumns.length - 1 && "pr-4",
                        RIGHT.has(column) && "text-right",
                      )}
                    >
                      <Cell request={request} column={column} onSelect={onSelect} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="flex justify-end">
        <PaginationControls
          total={total}
          limit={limit}
          offset={offset}
          hasMore={hasMore}
          onLimitChange={onLimitChange}
          onOffsetChange={onOffsetChange}
        />
      </div>
    </div>
  );
}
