import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { Account } from "@/features/accounts/schemas";
import { formatUntil } from "@/features/accounts/lib/time";
import { isSubscription, rateLimitRemainingPercent, usageTone } from "@/features/accounts/status";

const FILL: Record<ReturnType<typeof usageTone>, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  high: "bg-red-500",
};

/** A thin bar for a *used* percentage: green while low, red near the limit. */
export function UsageBar({
  usedPercent,
  label,
  className,
}: {
  usedPercent: number | null;
  label: string;
  className?: string;
}) {
  const clamped = usedPercent === null ? 0 : Math.max(0, Math.min(100, usedPercent));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={usedPercent === null ? undefined : Math.round(clamped)}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      {usedPercent !== null ? (
        <div className={cn("h-full rounded-full transition-all", FILL[usageTone(clamped)])} style={{ width: `${clamped}%` }} />
      ) : null}
    </div>
  );
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`;
}

function MiniRow({
  label,
  usedPercent,
  resetAt,
  now,
  meterLabel,
}: {
  label: string;
  usedPercent: number | null;
  resetAt: string | null;
  now: number;
  meterLabel: string;
}) {
  const { t } = useTranslation();
  const until = formatUntil(resetAt, now);
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums font-medium">{formatPercent(usedPercent)}</span>
      </div>
      <UsageBar usedPercent={usedPercent} label={meterLabel} />
      <div className="truncate text-[10px] text-muted-foreground">
        {until ? t("accounts.quota.resetsIn", { label: until }) : t("accounts.quota.noReset")}
      </div>
    </div>
  );
}

/**
 * Compact 5h / 7d utilization (subscriptions) or rate-limit headroom (API keys).
 * Shared by the Accounts list and the Dashboard's account cards.
 */
export function AccountQuotaBars({ account, now }: { account: Account; now: number }) {
  const { t } = useTranslation();
  const subscription = isSubscription(account);
  const hasWindows = account.primaryUsedPercent !== null || account.secondaryUsedPercent !== null;

  if (subscription || hasWindows) {
    return (
      <div className="grid grid-cols-2 gap-3">
        <MiniRow
          label={t("accounts.quota.fiveHour")}
          usedPercent={account.primaryUsedPercent}
          resetAt={account.primaryResetAt}
          now={now}
          meterLabel={t("accounts.quota.usedAria", { label: t("accounts.quota.fiveHour") })}
        />
        <MiniRow
          label={t("accounts.quota.sevenDay")}
          usedPercent={account.secondaryUsedPercent}
          resetAt={account.secondaryResetAt}
          now={now}
          meterLabel={t("accounts.quota.usedAria", { label: t("accounts.quota.sevenDay") })}
        />
      </div>
    );
  }

  const remaining = rateLimitRemainingPercent(account);
  const used = remaining === null ? null : 100 - remaining;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-muted-foreground">{t("accounts.quota.rateLimit")}</span>
        <span className="tabular-nums font-medium">
          {remaining === null ? t("accounts.quota.notObserved") : t("accounts.quota.left", { percent: Math.round(remaining) })}
        </span>
      </div>
      <UsageBar usedPercent={used} label={t("accounts.quota.usedAria", { label: t("accounts.quota.rateLimit") })} />
    </div>
  );
}
