import { Activity, CheckCircle2, Pause, Play, RotateCcw, Trash2, User, XCircle } from "lucide-react";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Account, AccountTrends, AccountUpdateRequest, ProbeResult } from "@/features/accounts/schemas";
import {
  AccountStatusBadge,
  PlanBadge,
  ProviderIcon,
  RiskBadge,
  RoutingPolicyBadge,
} from "@/features/accounts/components/account-badges";
import { AccountModelBlocks } from "@/features/accounts/components/account-model-blocks";
import { AccountNameField } from "@/features/accounts/components/account-name-field";
import { AccountSettingsCard } from "@/features/accounts/components/account-settings-card";
import { AccountUsagePanel } from "@/features/accounts/components/account-usage-panel";
import type { AccountTrendChartProps } from "@/features/accounts/components/account-trend-chart";
import { formatAbsolute, formatAgo, formatUntil } from "@/features/accounts/lib/time";
import { accountStatus, isSubscription, statusLiftsAt } from "@/features/accounts/status";

const AccountTrendChart = lazy(() =>
  import("@/features/accounts/components/account-trend-chart").then((module) => ({
    default: (props: AccountTrendChartProps) => <module.AccountTrendChart {...props} />,
  })),
);

export type AccountDetailProps = {
  account: Account | null;
  now: number;
  trends?: AccountTrends | null;
  risk?: { level: string; value: number } | null;
  /** Result of the latest "Probe now" on this account, if any. */
  probeResult?: ProbeResult | null;
  busy?: boolean;
  probing?: boolean;
  readOnly?: boolean;
  onUpdate: (accountId: string, patch: AccountUpdateRequest) => Promise<unknown>;
  onProbe: (accountId: string) => void;
  onResetQuota: (accountId: string) => void;
  onClearBlocks: (accountId: string, model?: string) => void;
  onDelete: (accountId: string) => void;
};

function StatusSummary({ account, now }: { account: Account; now: number }) {
  const { t } = useTranslation();
  const status = accountStatus(account);
  const liftsAt = statusLiftsAt(account);
  const until = liftsAt ? formatUntil(liftsAt, now) : null;
  const reason =
    status === "disabled"
      ? account.disabledReason
      : status === "cooling_down" && account.disabledReason
        ? account.disabledReason
        : null;

  return (
    <div className="space-y-1 text-xs">
      <p className="text-foreground">{t(`accounts.statusHelp.${status}`)}</p>
      {reason ? <p className="text-muted-foreground">{t("accounts.detail.reason", { reason })}</p> : null}
      {until && liftsAt ? (
        <p className="text-muted-foreground" data-testid="status-countdown">
          {t("accounts.detail.liftsAt", { time: formatAbsolute(liftsAt), label: until })}
        </p>
      ) : null}
    </div>
  );
}

function ProbeLine({ account, result, now }: { account: Account; result: ProbeResult | null; now: number }) {
  const { t } = useTranslation();
  if (result) {
    return (
      <p
        className={cn(
          "flex items-center gap-1.5 text-xs",
          result.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400",
        )}
        data-testid="probe-result"
      >
        {result.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
        {result.ok
          ? result.models > 0
            ? t("accounts.probe.ok", { count: result.models })
            : t("accounts.probe.okNoModels")
          : t("accounts.probe.failed", { detail: result.detail })}
      </p>
    );
  }
  if (account.lastProbeAt === null) {
    return <p className="text-xs text-muted-foreground">{t("accounts.probe.never")}</p>;
  }
  const ago = formatAgo(account.lastProbeAt, now) ?? "";
  return (
    <p className="text-xs text-muted-foreground">
      {account.lastProbeOk
        ? t("accounts.probe.lastOk", { label: ago })
        : t("accounts.probe.lastFailed", { label: ago, detail: account.lastProbeDetail })}
    </p>
  );
}

export function AccountDetail({
  account,
  now,
  trends = null,
  risk = null,
  probeResult = null,
  busy = false,
  probing = false,
  readOnly = false,
  onUpdate,
  onProbe,
  onResetQuota,
  onClearBlocks,
  onDelete,
}: AccountDetailProps) {
  const { t } = useTranslation();

  if (!account) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed p-12">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted">
          <User className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="mt-3 text-sm font-medium text-muted-foreground">{t("accounts.detail.emptyTitle")}</p>
        <p className="mt-1 text-xs text-muted-foreground/70">{t("accounts.detail.emptyDescription")}</p>
      </div>
    );
  }

  const disabled = busy || readOnly;
  const update = (patch: AccountUpdateRequest) => onUpdate(account.id, patch);
  const subscription = isSubscription(account);

  return (
    <div key={account.id} className="animate-fade-in-up min-w-0 space-y-4 rounded-xl border bg-card p-4 sm:p-5">
      <header className="flex items-start gap-3">
        <ProviderIcon account={account} className="h-9 w-9" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <AccountNameField name={account.name} disabled={disabled} onRename={(name) => update({ name })} />
          <div className="flex flex-wrap items-center gap-1.5">
            <AccountStatusBadge account={account} />
            <PlanBadge planType={account.planType} />
            <RoutingPolicyBadge policy={account.routingPolicy} />
            {risk ? <RiskBadge level={risk.level} risk={risk.value} /> : null}
          </div>
        </div>
      </header>

      <section className="space-y-3 rounded-lg border bg-muted/30 p-4">
        <StatusSummary account={account} now={now} />
        <ProbeLine account={account} result={probeResult} now={now} />
        <div className="flex flex-wrap gap-2">
          {account.enabled ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={disabled}
              onClick={() => void update({ enabled: false }).catch(() => null)}
            >
              <Pause className="h-3.5 w-3.5" />
              {t("accounts.actions.pause")}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              className="gap-1.5"
              disabled={disabled}
              onClick={() => void update({ enabled: true }).catch(() => null)}
            >
              <Play className="h-3.5 w-3.5" />
              {t("accounts.actions.resume")}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={disabled}
            onClick={() => onProbe(account.id)}
          >
            <Activity className={cn("h-3.5 w-3.5", probing && "animate-pulse")} />
            {probing ? t("accounts.actions.probing") : t("accounts.actions.probe")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={disabled}
            onClick={() => onResetQuota(account.id)}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t("accounts.actions.resetQuota")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1.5 text-destructive hover:text-destructive"
            disabled={disabled}
            onClick={() => onDelete(account.id)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("common.actions.delete")}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {account.enabled ? t("accounts.actions.pauseHelp") : t("accounts.actions.resumeHelp")}
        </p>
      </section>

      <AccountModelBlocks
        account={account}
        now={now}
        disabled={disabled}
        onClear={(model) => onClearBlocks(account.id, model)}
      />

      <AccountUsagePanel account={account} now={now} trends={trends} />

      {trends ? (
        <Suspense fallback={<div className="h-[220px]" />}>
          <AccountTrendChart trends={trends} showQuota={subscription} />
        </Suspense>
      ) : null}

      <AccountSettingsCard account={account} disabled={disabled} onUpdate={update} />
    </div>
  );
}
