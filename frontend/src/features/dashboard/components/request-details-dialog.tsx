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
import { RequestStatusBadge } from "@/features/dashboard/components/request-status-badge";
import { useRequestLogDetail } from "@/features/dashboard/hooks/use-dashboard";
import type { RequestLogDetail } from "@/features/dashboard/schemas";
import { formatMs, formatUsd, toIso } from "@/features/dashboard/utils";
import { useDateDisplayFormatStore } from "@/hooks/use-date-format";
import { formatDateTimeInline, formatNumber } from "@/utils/formatters";

export type RequestDetailsDialogProps = {
  requestId: string | null;
  onClose: () => void;
  /** Filter the request log to this request's conversation. */
  onShowConversation?: (sessionKey: string) => void;
};

function Field({
  label,
  value,
  copyValue,
  mono = false,
  children,
}: {
  label: string;
  value?: string;
  copyValue?: string | null;
  mono?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex h-7 items-center gap-1.5">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">{label}</div>
        {copyValue ? (
          <CopyButton value={copyValue} label={t("dashboard.requestDetails.copyField", { field: label })} iconOnly />
        ) : null}
      </div>
      {children ?? <p className={`break-all text-sm leading-relaxed ${mono ? "font-mono" : ""}`}>{value ?? "—"}</p>}
    </div>
  );
}

function TokenTable({ detail }: { detail: RequestLogDetail }) {
  const { t } = useTranslation();
  const rows = [
    { label: t("dashboard.requestDetails.tokens.input"), tokens: detail.inputTokens, usd: detail.costBreakdown.inputUsd },
    {
      label: t("dashboard.requestDetails.tokens.cacheWrite"),
      tokens: detail.cacheCreationInputTokens,
      usd: detail.costBreakdown.cacheWriteUsd,
    },
    {
      label: t("dashboard.requestDetails.tokens.cacheRead"),
      tokens: detail.cacheReadInputTokens,
      usd: detail.costBreakdown.cacheReadUsd,
    },
    { label: t("dashboard.requestDetails.tokens.output"), tokens: detail.outputTokens, usd: detail.costBreakdown.outputUsd },
  ];
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{t("dashboard.requestDetails.tokens.title")}</h3>
      <table className="w-full text-xs" data-testid="request-token-breakdown">
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-b last:border-0">
              <td className="py-1.5 text-muted-foreground">{row.label}</td>
              <td className="py-1.5 text-right font-mono tabular-nums">{formatNumber(row.tokens)}</td>
              <td className="py-1.5 pl-4 text-right font-mono tabular-nums">{formatUsd(row.usd)}</td>
            </tr>
          ))}
          <tr className="font-medium">
            <td className="pt-2">{t("dashboard.requestDetails.tokens.total")}</td>
            <td className="pt-2 text-right font-mono tabular-nums">{formatNumber(detail.totalTokens)}</td>
            <td className="pt-2 pl-4 text-right font-mono tabular-nums">{formatUsd(detail.costUsd)}</td>
          </tr>
        </tbody>
      </table>
      <p className="text-[11px] text-muted-foreground">
        {detail.cacheSavingsUsd > 0
          ? t("dashboard.requestDetails.tokens.saved", { amount: formatUsd(detail.cacheSavingsUsd) })
          : null}{" "}
        {t("dashboard.requestDetails.tokens.estimateNote")}
      </p>
    </div>
  );
}

function DetailBody({ detail, onShowConversation }: { detail: RequestLogDetail; onShowConversation?: (key: string) => void }) {
  const { t } = useTranslation();
  const dateDisplayFormat = useDateDisplayFormatStore((state) => state.dateDisplayFormat);
  const accountLabel = detail.accountName ?? detail.accountId ?? t("dashboard.requests.unassigned");
  return (
    <div className="grid min-h-0 gap-4 overflow-y-auto">
      <div className="space-y-3 rounded-md border bg-muted/30 p-4">
        <Field label={t("dashboard.requestDetails.requestId")} value={detail.id} copyValue={detail.id} mono />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t("dashboard.requests.columns.status")}>
            <div className="flex items-center gap-2">
              <RequestStatusBadge status={detail.status} statusCode={detail.statusCode} />
            </div>
          </Field>
          <Field label={t("dashboard.requests.columns.time")} value={formatDateTimeInline(toIso(detail.createdAt), dateDisplayFormat)} />
          <Field label={t("dashboard.requestDetails.path")} value={detail.path} mono />
          <Field label={t("dashboard.requests.columns.account")} value={accountLabel} copyValue={detail.accountName} />
          <Field label={t("dashboard.requests.columns.apiKey")} value={detail.apiKeyName ?? "—"} copyValue={detail.apiKeyName} />
          <Field label={t("dashboard.requests.columns.model")} value={detail.model ?? "—"} copyValue={detail.model} mono />
          <Field label={t("dashboard.requests.columns.latency")} value={formatMs(detail.durationMs)} />
          <Field label={t("dashboard.requests.columns.ttft")} value={formatMs(detail.ttftMs)} />
          <Field
            label={t("dashboard.requests.columns.attempts")}
            value={t("dashboard.requestDetails.attemptsValue", { count: detail.attempts })}
          />
          <Field
            label={t("dashboard.requestDetails.mode")}
            value={detail.streaming ? t("dashboard.requests.streaming") : t("dashboard.requestDetails.buffered")}
          />
          <Field label={t("dashboard.requestDetails.clientIp")} value={detail.clientIp ?? "—"} copyValue={detail.clientIp} mono />
        </div>
        <Field label={t("dashboard.requestDetails.userAgent")} value={detail.userAgent ?? "—"} copyValue={detail.userAgent} />
        <Field label={t("dashboard.requestDetails.conversation")} copyValue={detail.sessionKey}>
          {detail.sessionKey ? (
            <div className="space-y-1">
              <p className="break-all font-mono text-xs">{detail.sessionKey}</p>
              {detail.conversation ? (
                <p className="text-xs text-muted-foreground">
                  {t("dashboard.requestDetails.conversationSummary", {
                    count: detail.conversation.requests,
                    cost: formatUsd(detail.conversation.costUsd),
                  })}
                </p>
              ) : null}
              {onShowConversation ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => onShowConversation(detail.sessionKey as string)}
                >
                  {t("dashboard.requestDetails.showConversation")}
                </Button>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("dashboard.requestDetails.noConversation")}</p>
          )}
        </Field>
      </div>

      <TokenTable detail={detail} />

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">{t("dashboard.requestDetails.error")}</h3>
          {detail.error ? <CopyButton value={detail.error} label={t("dashboard.requestDetails.copyError")} iconOnly /> : null}
        </div>
        <div className="max-h-[30vh] overflow-y-auto rounded-md bg-muted/50 p-3">
          <p className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
            {detail.error ?? t("dashboard.requestDetails.noError")}
          </p>
        </div>
      </div>
    </div>
  );
}

export function RequestDetailsDialog({ requestId, onClose, onShowConversation }: RequestDetailsDialogProps) {
  const { t } = useTranslation();
  const query = useRequestLogDetail(requestId);
  return (
    <Dialog open={requestId !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[88vh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("dashboard.requestDetails.title")}</DialogTitle>
          <DialogDescription>{t("dashboard.requestDetails.description")}</DialogDescription>
        </DialogHeader>
        {query.data ? (
          <DetailBody
            detail={query.data}
            onShowConversation={
              onShowConversation
                ? (key) => {
                    onClose();
                    onShowConversation(key);
                  }
                : undefined
            }
          />
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
