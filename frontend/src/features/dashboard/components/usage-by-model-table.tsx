import { useTranslation } from "react-i18next";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ModelUsage } from "@/features/dashboard/schemas";
import { formatRatio, formatUsd } from "@/features/dashboard/utils";
import { formatCompactNumber } from "@/utils/formatters";

const HEAD = "text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80";

/** Requests, tokens, cost and prompt-cache effect per model in the selected window. */
export function UsageByModelTable({ models }: { models: ModelUsage[] }) {
  const { t } = useTranslation();
  return (
    <section className="min-w-0 rounded-xl border bg-card" aria-label={t("dashboard.models.title")}>
      <div className="px-5 pt-5 pb-3">
        <h3 className="text-sm font-semibold">{t("dashboard.models.title")}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("dashboard.models.subtitle")}</p>
      </div>
      {models.length === 0 ? (
        <p className="px-5 pb-5 text-xs text-muted-foreground">{t("dashboard.models.empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table className="min-w-[560px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={`${HEAD} pl-5`}>{t("dashboard.models.model")}</TableHead>
                <TableHead className={`${HEAD} text-right`}>{t("dashboard.models.requests")}</TableHead>
                <TableHead className={`${HEAD} text-right`}>{t("dashboard.models.tokens")}</TableHead>
                <TableHead className={`${HEAD} text-right`}>{t("dashboard.models.cacheHit")}</TableHead>
                <TableHead className={`${HEAD} text-right`}>{t("dashboard.models.saved")}</TableHead>
                <TableHead className={`${HEAD} pr-5 text-right`}>{t("dashboard.models.cost")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((row) => (
                <TableRow key={row.model ?? "__unknown__"}>
                  <TableCell className="pl-5 font-mono text-xs">{row.model ?? t("dashboard.models.unknown")}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {formatCompactNumber(row.requests)}
                    {row.errors > 0 ? (
                      <div className="text-[11px] text-red-600 dark:text-red-400">
                        {t("dashboard.models.errors", { count: row.errors })}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell
                    className="text-right text-xs tabular-nums"
                    title={t("dashboard.models.tokensTitle", {
                      input: formatCompactNumber(row.inputTokens),
                      output: formatCompactNumber(row.outputTokens),
                      cacheRead: formatCompactNumber(row.cacheReadInputTokens),
                      cacheWrite: formatCompactNumber(row.cacheCreationInputTokens),
                    })}
                  >
                    {formatCompactNumber(row.totalTokens)}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{formatRatio(row.cacheHitRate)}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums text-emerald-600 dark:text-emerald-400">
                    {formatUsd(row.cacheSavingsUsd)}
                  </TableCell>
                  <TableCell className="pr-5 text-right text-xs font-medium tabular-nums">
                    {formatUsd(row.costUsd)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
