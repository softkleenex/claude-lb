import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { formatAgo } from "@/features/accounts/lib/time";
import { metricLabel, tightestLimit, usageTone } from "@/features/api-keys/lib";
import type { ApiKey } from "@/features/api-keys/schemas";
import { KeyStatusBadge } from "@/features/apis/components/key-status-badge";

export type ApiListItemProps = {
  apiKey: ApiKey;
  selected: boolean;
  now: number;
  onSelect: (keyId: string) => void;
};

export function ApiListItem({ apiKey, selected, now, onSelect }: ApiListItemProps) {
  const { t } = useTranslation();
  const tightest = tightestLimit(apiKey);
  const lastUsed = formatAgo(apiKey.lastUsedAt, now);

  return (
    <button
      type="button"
      onClick={() => onSelect(apiKey.id)}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "w-full rounded-lg px-3 py-2.5 text-left transition-colors",
        selected ? "bg-primary/8 ring-1 ring-primary/25" : "hover:bg-muted/50",
      )}
    >
      <div className="flex items-center gap-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{apiKey.name}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            <span className="font-mono">…{apiKey.keyHint}</span>
            <span className="mx-1">·</span>
            {lastUsed ? t("apis.list.lastUsed", { ago: lastUsed }) : t("apis.list.neverUsed")}
          </p>
        </div>
        <KeyStatusBadge status={apiKey.status} />
      </div>
      {tightest ? (
        <div className="mt-2 space-y-1" data-testid="list-limit-usage">
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="truncate text-muted-foreground">
              {apiKey.limits.length > 1
                ? t("apis.list.tightestLimit", { metric: metricLabel(t, tightest.metric), count: apiKey.limits.length })
                : metricLabel(t, tightest.metric)}
            </span>
            <span className="tabular-nums font-medium">{Math.round(tightest.usedPercent)}%</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full", usageTone(tightest.usedPercent))}
              style={{ width: `${Math.min(100, tightest.usedPercent)}%` }}
            />
          </div>
        </div>
      ) : null}
    </button>
  );
}
