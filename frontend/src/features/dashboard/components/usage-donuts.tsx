import { lazy, Suspense, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { DonutChartProps } from "@/components/donut-chart";
import { RiskBadge } from "@/features/accounts/components/account-badges";
import { formatAbsolute, formatUntil, useNow } from "@/features/accounts/lib/time";
import type { WindowCapacity } from "@/features/dashboard/schemas";
import { formatCompactNumber } from "@/utils/formatters";

const DonutChart = lazy(() =>
  import("@/components/donut-chart").then((module) => ({
    default: (props: DonutChartProps) => <module.DonutChart {...props} />,
  })),
);

export type CapacityDonutsProps = {
  primary: WindowCapacity | null;
  secondary: WindowCapacity | null;
};

function CapacityFooter({ window, now }: { window: WindowCapacity; now: number }) {
  const { t } = useTranslation();
  const reset = formatUntil(window.nextResetAt, now);
  const exhaustion = formatUntil(window.projectedExhaustionAt, now);
  const unobserved = window.accounts.filter((account) => account.usedPercent === null).length;
  return (
    <>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
      <dt className="text-muted-foreground">{t("dashboard.capacity.remaining")}</dt>
      <dd className="text-right tabular-nums">{Math.round(window.remainingPercent)}%</dd>
      {window.safeUsedPercent !== null ? (
        <>
          <dt className="text-muted-foreground">{t("dashboard.capacity.safeLine")}</dt>
          <dd className="text-right tabular-nums">
            {t("dashboard.capacity.safeLineValue", { percent: Math.round(window.safeUsedPercent) })}
          </dd>
        </>
      ) : null}
      <dt className="text-muted-foreground">{t("dashboard.capacity.nextReset")}</dt>
      <dd className="text-right tabular-nums" title={formatAbsolute(window.nextResetAt)}>
        {reset ? t("dashboard.capacity.inDuration", { duration: reset }) : "—"}
      </dd>
      <dt className="text-muted-foreground">{t("dashboard.capacity.burnRate")}</dt>
      <dd className="text-right tabular-nums">
        {window.burnRateCreditsPerHour > 0
          ? t("dashboard.capacity.burnRateValue", { credits: formatCompactNumber(window.burnRateCreditsPerHour) })
          : t("dashboard.capacity.idle")}
      </dd>
      {exhaustion ? (
        <>
          <dt className="text-muted-foreground">{t("dashboard.capacity.runsOut")}</dt>
          <dd className="text-right tabular-nums">{t("dashboard.capacity.inDuration", { duration: exhaustion })}</dd>
        </>
      ) : null}
    </dl>
    {unobserved > 0 ? (
      <p className="mt-2 text-[11px] text-muted-foreground">
        {t("dashboard.capacity.unobserved", { count: unobserved })}
      </p>
    ) : null}
    </>
  );
}

function CapacityDonut({ title, window, now }: { title: string; window: WindowCapacity; now: number }) {
  const { t } = useTranslation();
  const items = useMemo(
    () =>
      window.accounts.map((account) => ({
        id: account.accountId,
        label: account.accountName,
        labelSuffix: ` · ${t(`accounts.plans.${account.planType}`, { defaultValue: account.planType })}`,
        value: account.remainingCredits,
      })),
    [window.accounts, t],
  );
  return (
    <DonutChart
      title={title}
      subtitle={t("dashboard.capacity.subtitle", { count: window.accounts.length })}
      items={items}
      total={window.capacityCredits}
      centerValue={window.remainingCredits}
      centerLayout="credits"
      safeLine={
        window.safeUsedPercent !== null
          ? { safePercent: window.safeUsedPercent, riskLevel: window.riskLevel }
          : null
      }
      headerAction={<RiskBadge level={window.riskLevel} risk={window.risk} />}
      footer={<CapacityFooter window={window} now={now} />}
    />
  );
}

/** 5h and 7d capacity across the subscription pool, one donut segment per account. */
export function CapacityDonuts({ primary, secondary }: CapacityDonutsProps) {
  const { t } = useTranslation();
  const now = useNow();
  if (!primary && !secondary) return null;
  return (
    <Suspense fallback={<div className="grid gap-4 lg:grid-cols-2" />}>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        {primary ? <CapacityDonut title={t("dashboard.capacity.fiveHour")} window={primary} now={now} /> : null}
        {secondary ? <CapacityDonut title={t("dashboard.capacity.sevenDay")} window={secondary} now={now} /> : null}
      </div>
    </Suspense>
  );
}
