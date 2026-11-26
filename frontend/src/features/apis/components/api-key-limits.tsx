import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { formatAbsolute, formatUntil } from "@/features/accounts/lib/time";
import { CALENDAR_WINDOWS, formatLimitValue, metricLabel, usageTone, windowLabel } from "@/features/api-keys/lib";
import type { LimitUsage } from "@/features/api-keys/schemas";
import { cn } from "@/lib/utils";

function LimitRow({ limit, now }: { limit: LimitUsage; now: number }) {
  const { t } = useTranslation();
  const percent = Math.min(100, limit.usedPercent);
  const until = formatUntil(limit.resetsAt, now);
  const calendar = CALENDAR_WINDOWS.has(limit.window);
  const reset = limit.resetsAt
    ? t(calendar ? "apis.limits.resetsIn" : "apis.limits.freesIn", {
        duration: until ?? t("apis.limits.momentarily"),
        at: formatAbsolute(limit.resetsAt),
      })
    : t("apis.limits.nothingCounted");

  return (
    <li className="space-y-1.5" data-testid="limit-usage-row">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="font-medium">{metricLabel(t, limit.metric)}</span>
          <span className="text-muted-foreground">· {windowLabel(t, limit.window, limit.windowSeconds)}</span>
          {limit.modelFilter ? (
            <span className="truncate font-mono text-[11px] text-muted-foreground">· {limit.modelFilter}</span>
          ) : null}
          {limit.source === "legacy" ? (
            <Badge variant="outline" className="h-4 px-1 text-[10px]">
              {t("apis.limits.legacy")}
            </Badge>
          ) : null}
        </span>
        <span className="tabular-nums font-medium">
          {formatLimitValue(limit.metric, limit.currentValue)} / {formatLimitValue(limit.metric, limit.maxValue)}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        aria-label={metricLabel(t, limit.metric)}
      >
        <div className={cn("h-full rounded-full transition-all", usageTone(percent))} style={{ width: `${percent}%` }} />
      </div>
      <p className="text-[11px] text-muted-foreground">
        {percent >= 100 ? <span className="font-medium text-red-600 dark:text-red-400">{t("apis.limits.reached")} </span> : null}
        {reset}
      </p>
    </li>
  );
}

export function ApiKeyLimits({ limits, now }: { limits: LimitUsage[]; now: number }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3 rounded-lg border p-4" data-testid="api-key-limits">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("apis.limits.title")}</h3>
        {limits.length > 1 ? <span className="text-[11px] text-muted-foreground">{t("apis.limits.allApply")}</span> : null}
      </div>
      {limits.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("apis.limits.none")}</p>
      ) : (
        <ul className="space-y-4">
          {limits.map((limit) => (
            <LimitRow key={limit.id} limit={limit} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
}
