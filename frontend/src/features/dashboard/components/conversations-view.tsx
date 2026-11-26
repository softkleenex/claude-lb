import { Inbox } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { AlertMessage } from "@/components/alert-message";
import { EmptyState } from "@/components/empty-state";
import { SearchInput } from "@/components/search-input";
import { Button } from "@/components/ui/button";
import { SpinnerBlock } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConversationDetailsDialog } from "@/features/dashboard/components/conversation-details-dialog";
import { PaginationControls } from "@/features/dashboard/components/filters/pagination-controls";
import { TimeframeSelect } from "@/features/dashboard/components/filters/timeframe-select";
import { useConversations } from "@/features/dashboard/hooks/use-conversations";
import type { Conversation } from "@/features/dashboard/schemas";
import { formatConversationDuration, formatUsd, shortConversationKey, toIso } from "@/features/dashboard/utils";
import { useDateDisplayFormatStore } from "@/hooks/use-date-format";
import { cn } from "@/lib/utils";
import { formatCompactNumber, formatDateTimeLines, formatNumber } from "@/utils/formatters";

const HEAD = "text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80";

function Aggregate({ values, mono = false }: { values: string[]; mono?: boolean }) {
  const { t } = useTranslation();
  if (values.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="min-w-0 leading-tight">
      <div className={cn("truncate text-sm", mono && "font-mono text-xs")} title={values.join(", ")}>
        <span translate={mono ? "no" : undefined}>{values[0]}</span>
      </div>
      {values.length > 1 ? (
        <div className="mt-1 text-[11px] text-muted-foreground">
          {t("dashboard.conversations.more", { count: values.length - 1 })}
        </div>
      ) : null}
    </div>
  );
}

function ConversationRow({
  conversation,
  onShowRequests,
  onDetails,
}: {
  conversation: Conversation;
  onShowRequests: (key: string) => void;
  onDetails: (key: string) => void;
}) {
  const { t } = useTranslation();
  const dateDisplayFormat = useDateDisplayFormatStore((state) => state.dateDisplayFormat);
  const time = formatDateTimeLines(toIso(conversation.lastAt), dateDisplayFormat);
  const short = shortConversationKey(conversation.sessionKey);
  return (
    <TableRow
      data-testid={`conversation-row-${short}`}
      className="cursor-pointer align-top"
      title={t("dashboard.conversations.rowHint")}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button, a")) return;
        onShowRequests(conversation.sessionKey);
      }}
    >
      <TableCell className="pl-4 align-top">
        <div className="leading-tight">
          <div className="text-sm font-medium">{time.primary}</div>
          <div className="text-xs text-muted-foreground">{time.secondary}</div>
        </div>
      </TableCell>
      <TableCell className="align-top font-mono text-xs tabular-nums">
        {formatConversationDuration(conversation.durationMs)}
      </TableCell>
      <TableCell className="align-top">
        <span className="font-mono text-xs" title={conversation.sessionKey} translate="no">
          {short}
        </span>
      </TableCell>
      <TableCell className="align-top">
        <Aggregate values={conversation.accounts.map((account) => account.name)} />
      </TableCell>
      <TableCell className="align-top">
        <Aggregate values={conversation.apiKeys.map((key) => key.name)} />
      </TableCell>
      <TableCell className="align-top">
        <Aggregate values={conversation.models} mono />
      </TableCell>
      <TableCell className="text-right align-top font-mono text-xs tabular-nums">
        <div>{formatNumber(conversation.requests)}</div>
        {conversation.errors > 0 ? (
          <div className="mt-1 text-[11px] text-red-600 dark:text-red-400">
            {t("dashboard.conversations.errors", { count: conversation.errors })}
          </div>
        ) : null}
      </TableCell>
      <TableCell className="text-right align-top font-mono text-xs tabular-nums">
        <div>{formatCompactNumber(conversation.totalTokens)}</div>
        {conversation.cacheReadInputTokens > 0 ? (
          <div className="mt-1 text-[11px] font-sans text-muted-foreground">
            {t("dashboard.requests.cachedShort", { tokens: formatCompactNumber(conversation.cacheReadInputTokens) })}
          </div>
        ) : null}
      </TableCell>
      <TableCell className="text-right align-top font-mono text-xs tabular-nums">
        {formatUsd(conversation.costUsd)}
      </TableCell>
      <TableCell className="pr-4 align-top">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[11px]"
          onClick={() => onDetails(conversation.sessionKey)}
          aria-label={t("dashboard.conversations.detailsAria", { key: short })}
        >
          {t("dashboard.requests.viewDetails")}
        </Button>
      </TableCell>
    </TableRow>
  );
}

export type ConversationsViewProps = {
  /** Switch to the request log filtered to this conversation. */
  onShowRequests: (sessionKey: string) => void;
};

export function ConversationsView({ onShowRequests }: ConversationsViewProps) {
  const { t } = useTranslation();
  const { filters, conversationsQuery, updateFilters } = useConversations(true);
  const [selected, setSelected] = useState<string | null>(null);
  const onSearch = useCallback((search: string) => updateFilters({ search, offset: 0 }), [updateFilters]);

  const page = conversationsQuery.data;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-xl border bg-card p-3 sm:p-4">
        <SearchInput
          className="flex-1"
          name="conversation-search"
          value={filters.search}
          onChange={onSearch}
          placeholder={t("dashboard.conversations.searchPlaceholder")}
          ariaLabel={t("dashboard.conversations.search")}
        />
        <TimeframeSelect value={filters.timeframe} onChange={(timeframe) => updateFilters({ timeframe, offset: 0 })} />
      </div>

      {conversationsQuery.error && !page ? (
        <div className="space-y-3 rounded-xl border bg-card p-4">
          <div role="alert">
            <AlertMessage variant="error">{conversationsQuery.error.message}</AlertMessage>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void conversationsQuery.refetch()}
            disabled={conversationsQuery.isFetching}
          >
            {t("common.actions.retry")}
          </Button>
        </div>
      ) : !page ? (
        <div className="rounded-xl border bg-card py-8">
          <SpinnerBlock />
        </div>
      ) : page.conversations.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={t("dashboard.conversations.emptyTitle")}
          description={
            filters.search || filters.timeframe !== "all"
              ? t("dashboard.conversations.emptyFilteredDescription")
              : t("dashboard.conversations.emptyDescription")
          }
        />
      ) : (
        <div className={cn("space-y-3 transition-opacity", conversationsQuery.isPlaceholderData && "opacity-60")}>
          <div className="rounded-xl border bg-card">
            <div className="relative overflow-x-auto">
              <Table className="min-w-[1040px] table-fixed">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className={cn("w-[10%] pl-4", HEAD)}>
                      {t("dashboard.conversations.columns.lastRequest")}
                    </TableHead>
                    <TableHead className={cn("w-[8%]", HEAD)}>
                      {t("dashboard.conversations.columns.duration")}
                    </TableHead>
                    <TableHead className={cn("w-[11%]", HEAD)}>
                      {t("dashboard.conversations.columns.conversation")}
                    </TableHead>
                    <TableHead className={cn("w-[12%]", HEAD)}>
                      {t("dashboard.conversations.columns.accounts")}
                    </TableHead>
                    <TableHead className={cn("w-[12%]", HEAD)}>
                      {t("dashboard.conversations.columns.apiKeys")}
                    </TableHead>
                    <TableHead className={cn("w-[15%]", HEAD)}>{t("dashboard.conversations.columns.models")}</TableHead>
                    <TableHead className={cn("w-[8%] text-right", HEAD)}>
                      {t("dashboard.conversations.columns.requests")}
                    </TableHead>
                    <TableHead className={cn("w-[9%] text-right", HEAD)}>
                      {t("dashboard.conversations.columns.tokens")}
                    </TableHead>
                    <TableHead className={cn("w-[7%] text-right", HEAD)}>
                      {t("dashboard.conversations.columns.cost")}
                    </TableHead>
                    <TableHead className={cn("w-[8%] pr-4", HEAD)}>
                      <span className="sr-only">{t("dashboard.requests.columns.details")}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {page.conversations.map((conversation) => (
                    <ConversationRow
                      key={conversation.sessionKey}
                      conversation={conversation}
                      onShowRequests={onShowRequests}
                      onDetails={setSelected}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">{t("dashboard.conversations.hint")}</p>
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

      <ConversationDetailsDialog
        sessionKey={selected}
        onClose={() => setSelected(null)}
        onShowRequests={(key) => {
          setSelected(null);
          onShowRequests(key);
        }}
      />
    </div>
  );
}
