import { useTranslation } from "react-i18next";

import { formatRatio, formatUsd } from "@/features/dashboard/utils";
import { cn } from "@/lib/utils";
import { formatCompactNumber, formatNumber } from "@/utils/formatters";

import { compareToPrevious, type Tone } from "../compare";
import type { ReportPrevious, ReportSummary } from "../schemas";

const TONE_CLASS: Record<Tone, string> = {
  up: "text-emerald-600 dark:text-emerald-400",
  down: "text-red-600 dark:text-red-400",
};

export type ReportsSummaryCardsProps = {
  summary: ReportSummary;
  previous: ReportPrevious;
};

export function ReportsSummaryCards({ summary, previous }: ReportsSummaryCardsProps) {
  const { t } = useTranslation();
  const cards = [
    {
      id: "cost",
      label: t("reports.summary.totalCost"),
      value: formatUsd(summary.totalCostUsd),
      lines: [t("reports.summary.avgCostPerDay", { cost: formatUsd(summary.avgCostPerDay) })],
      delta: compareToPrevious(summary.totalCostUsd, previous.totalCostUsd, previous.canCompare),
    },
    {
      id: "requests",
      label: t("reports.summary.requests"),
      value: formatNumber(summary.requests),
      lines: [
        t("reports.summary.avgRequestsPerDay", { requests: formatNumber(Math.round(summary.avgRequestsPerDay)) }),
        t("reports.summary.accountsUsed", { count: summary.accountsUsed }),
      ],
      delta: compareToPrevious(summary.requests, previous.requests, previous.canCompare),
    },
    {
      id: "tokens",
      label: t("reports.summary.tokens"),
      value: formatCompactNumber(summary.totalTokens),
      lines: [
        t("reports.summary.tokensInput", {
          input: formatCompactNumber(summary.inputTokens),
          output: formatCompactNumber(summary.outputTokens),
        }),
        t("reports.summary.tokensCache", {
          read: formatCompactNumber(summary.cacheReadInputTokens),
          write: formatCompactNumber(summary.cacheCreationInputTokens),
        }),
      ],
      delta: compareToPrevious(summary.totalTokens, previous.totalTokens, previous.canCompare),
    },
    {
      id: "savings",
      label: t("reports.summary.cacheSavings"),
      value: formatUsd(summary.cacheSavingsUsd),
      valueClass: "text-emerald-600 dark:text-emerald-400",
      lines: [t("reports.summary.cacheHitRate", { rate: formatRatio(summary.cacheHitRate) })],
      delta: null,
    },
    {
      id: "errors",
      label: t("reports.summary.errors"),
      value: formatNumber(summary.errors),
      lines: [
        t("reports.summary.errorRate", { rate: formatRatio(summary.errorRate) }),
        t("reports.summary.aborted", { count: summary.aborted }),
      ],
      delta: null,
    },
    {
      id: "conversations",
      label: t("reports.summary.conversations"),
      value: formatNumber(summary.conversations),
      lines: [t("reports.summary.conversationsSub")],
      delta: null,
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {cards.map((card) => (
        <div key={card.id} data-testid={`report-summary-${card.id}`} className="min-w-0 rounded-xl border bg-card p-4">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{card.label}</div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
            <div className={cn("text-[1.5rem] font-semibold tracking-[-0.02em] tabular-nums", card.valueClass)}>
              {card.value}
            </div>
            {card.delta ? (
              <div
                className={cn("text-xs font-medium", TONE_CLASS[card.delta.tone])}
                title={t("reports.summary.vsPrevious", { start: previous.start, end: previous.end })}
              >
                {card.delta.text}
              </div>
            ) : null}
          </div>
          {card.lines.map((line) => (
            <div key={line} className="mt-0.5 text-xs text-muted-foreground">
              {line}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
