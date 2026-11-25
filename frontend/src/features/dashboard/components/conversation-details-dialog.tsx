import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { AlertMessage } from "@/components/alert-message";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SpinnerBlock } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RequestStatusBadge } from "@/features/dashboard/components/request-status-badge";
import { useConversationDetail } from "@/features/dashboard/hooks/use-conversations";
import type { ConversationDetail } from "@/features/dashboard/schemas";
import { formatConversationDuration, formatMs, formatUsd, toIso } from "@/features/dashboard/utils";
import { useDateDisplayFormatStore } from "@/hooks/use-date-format";
import { formatCompactNumber, formatDateTimeInline, formatNumber } from "@/utils/formatters";

const HEAD = "text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <div className={HEAD}>{label}</div>
      <div className="break-words text-sm leading-relaxed">{children}</div>
    </div>
  );
}

function Body({ detail, onShowRequests }: { detail: ConversationDetail; onShowRequests: (key: string) => void }) {
  const { t } = useTranslation();
  const dateDisplayFormat = useDateDisplayFormatStore((state) => state.dateDisplayFormat);
  const when = (value: string) => formatDateTimeInline(toIso(value), dateDisplayFormat);

  return (
    <div className="grid min-h-0 gap-4 overflow-y-auto" data-testid="conversation-details">
      <div className="space-y-3 rounded-md border bg-muted/30 p-4">
        <div className="min-w-0 space-y-1">
          <div className="flex h-7 items-center gap-1.5">
            <div className={HEAD}>{t("dashboard.conversations.details.key")}</div>
            <CopyButton
              value={detail.sessionKey}
              label={t("dashboard.requestDetails.copyField", { field: t("dashboard.conversations.details.key") })}
              iconOnly
            />
          </div>
          <p className="break-all font-mono text-xs" translate="no">
            {detail.sessionKey}
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t("dashboard.conversations.details.started")}>{when(detail.firstAt)}</Field>
          <Field label={t("dashboard.conversations.details.latest")}>{when(detail.lastAt)}</Field>
          <Field label={t("dashboard.conversations.details.duration")}>
            {formatConversationDuration(detail.durationMs)}
          </Field>
          <Field label={t("dashboard.conversations.details.requests")}>
            {formatNumber(detail.requests)}
            {detail.errors > 0 ? (
              <span className="ml-1 text-xs text-red-600 dark:text-red-400">
                ({t("dashboard.conversations.errors", { count: detail.errors })})
              </span>
            ) : null}
          </Field>
          <Field label={t("dashboard.conversations.details.busy")}>{formatConversationDuration(detail.busyMs)}</Field>
          <Field label={t("dashboard.conversations.details.cost")}>{formatUsd(detail.costUsd)}</Field>
          <Field label={t("dashboard.conversations.details.accounts", { count: detail.accountCount })}>
            {detail.accounts.length === 0
              ? "—"
              : detail.accounts.map((account) => `${account.name} (${account.requests})`).join(", ")}
          </Field>
          <Field label={t("dashboard.conversations.details.apiKeys")}>
            {detail.apiKeys.length === 0
              ? t("dashboard.conversations.details.noKey")
              : detail.apiKeys.map((key) => `${key.name} (${key.requests})`).join(", ")}
          </Field>
          <Field label={t("dashboard.conversations.details.userAgent")}>
            {detail.dominantUserAgentFamily ?? "—"}
            {detail.dominantUserAgent && detail.dominantUserAgent !== detail.dominantUserAgentFamily ? (
              <span className="block truncate text-xs text-muted-foreground" title={detail.dominantUserAgent}>
                {detail.dominantUserAgent}
              </span>
            ) : null}
          </Field>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t("dashboard.conversations.details.byModel")}</h3>
        <div className="overflow-x-auto rounded-md border">
          <Table className="min-w-[640px]" data-testid="conversation-model-table">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={HEAD}>{t("dashboard.requests.columns.model")}</TableHead>
                <TableHead className={`${HEAD} text-right`}>{t("dashboard.conversations.columns.requests")}</TableHead>
                <TableHead className={`${HEAD} text-right`}>{t("dashboard.conversations.details.time")}</TableHead>
                <TableHead className={`${HEAD} text-right`}>{t("dashboard.requestDetails.tokens.input")}</TableHead>
                <TableHead className={`${HEAD} text-right`}>{t("dashboard.requestDetails.tokens.output")}</TableHead>
                <TableHead className={`${HEAD} text-right`}>{t("dashboard.conversations.columns.cost")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.models.map((stat) => (
                <TableRow key={stat.model ?? "-"}>
                  <TableCell className="font-mono text-xs" translate="no">
                    {stat.model ?? "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {formatNumber(stat.requests)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {formatMs(stat.durationMs)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    <div>
                      {formatCompactNumber(
                        stat.inputTokens + stat.cacheReadInputTokens + stat.cacheCreationInputTokens,
                      )}
                    </div>
                    {stat.cacheReadInputTokens > 0 ? (
                      <div className="text-[11px] font-sans text-muted-foreground">
                        {t("dashboard.requests.cachedShort", {
                          tokens: formatCompactNumber(stat.cacheReadInputTokens),
                        })}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {formatCompactNumber(stat.outputTokens)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{formatUsd(stat.costUsd)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{t("dashboard.conversations.details.timeline")}</h3>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => onShowRequests(detail.sessionKey)}
          >
            {t("dashboard.conversations.showRequests")}
          </Button>
        </div>
        <div className="max-h-[40vh] overflow-auto rounded-md border">
          <Table className="min-w-[640px]" data-testid="conversation-timeline">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={HEAD}>{t("dashboard.requests.columns.time")}</TableHead>
                <TableHead className={HEAD}>{t("dashboard.requests.columns.account")}</TableHead>
                <TableHead className={HEAD}>{t("dashboard.requests.columns.model")}</TableHead>
                <TableHead className={HEAD}>{t("dashboard.requests.columns.status")}</TableHead>
                <TableHead className={`${HEAD} text-right`}>{t("dashboard.requests.columns.latency")}</TableHead>
                <TableHead className={`${HEAD} text-right`}>{t("dashboard.requests.columns.tokens")}</TableHead>
                <TableHead className={`${HEAD} text-right`}>{t("dashboard.requests.columns.cost")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.timeline.map((request) => (
                <TableRow key={request.id}>
                  <TableCell className="whitespace-nowrap text-xs">{when(request.createdAt)}</TableCell>
                  <TableCell className="text-xs">{request.accountName ?? t("dashboard.requests.unassigned")}</TableCell>
                  <TableCell className="font-mono text-xs" translate="no">
                    {request.model ?? "—"}
                  </TableCell>
                  <TableCell>
                    <RequestStatusBadge status={request.status} statusCode={request.statusCode} />
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {formatMs(request.durationMs)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {formatCompactNumber(request.totalTokens)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {formatUsd(request.costUsd)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {detail.timelineTruncated ? (
          <p className="text-[11px] text-muted-foreground">
            {t("dashboard.conversations.details.timelineTruncated", { count: detail.timeline.length })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export type ConversationDetailsDialogProps = {
  sessionKey: string | null;
  onClose: () => void;
  onShowRequests: (sessionKey: string) => void;
};

export function ConversationDetailsDialog({ sessionKey, onClose, onShowRequests }: ConversationDetailsDialogProps) {
  const { t } = useTranslation();
  const query = useConversationDetail(sessionKey);
  return (
    <Dialog open={sessionKey !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[88vh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t("dashboard.conversations.details.title")}</DialogTitle>
          <DialogDescription>{t("dashboard.conversations.details.description")}</DialogDescription>
        </DialogHeader>
        {query.data ? (
          <Body detail={query.data} onShowRequests={onShowRequests} />
        ) : query.error ? (
          <AlertMessage variant="error">{query.error.message}</AlertMessage>
        ) : (
          <SpinnerBlock />
        )}
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}
