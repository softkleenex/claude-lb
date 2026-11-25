import { Flame, KeyRound, Shield, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Account } from "@/features/accounts/schemas";
import { accountStatus, isSubscription, type AccountStatus } from "@/features/accounts/status";

const STATUS_CLASSES: Record<AccountStatus, string> = {
  available: "border-emerald-500/20 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  cooling_down: "border-amber-500/20 bg-amber-500/15 text-amber-700 dark:text-amber-400",
  rate_limited: "border-orange-500/20 bg-orange-500/15 text-orange-700 dark:text-orange-400",
  quota_exceeded: "border-red-500/20 bg-red-500/15 text-red-700 dark:text-red-400",
  spend_cap: "border-violet-500/20 bg-violet-500/15 text-violet-700 dark:text-violet-300",
  paused: "border-zinc-500/20 bg-zinc-500/15 text-zinc-600 dark:text-zinc-300",
  disabled: "border-red-500/20 bg-red-500/15 text-red-700 dark:text-red-400",
};

export function AccountStatusBadge({ account, status }: { account?: Account; status?: AccountStatus }) {
  const { t } = useTranslation();
  const resolved = status ?? (account ? accountStatus(account) : "available");
  return (
    <Badge
      variant="outline"
      className={cn("shrink-0 gap-1.5", STATUS_CLASSES[resolved])}
      title={account?.disabledReason ?? undefined}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
      {t(`accounts.status.${resolved}`)}
    </Badge>
  );
}

export function PlanBadge({ planType }: { planType: string }) {
  const { t } = useTranslation();
  return (
    <Badge variant="outline" className="shrink-0 px-1.5 text-[11px] font-medium">
      {t(`accounts.plans.${planType}`, { defaultValue: planType })}
    </Badge>
  );
}

export function RoutingPolicyBadge({ policy, hideNormal = false }: { policy: string; hideNormal?: boolean }) {
  const { t } = useTranslation();
  if (policy === "burn_first") {
    return (
      <Badge
        variant="outline"
        className="shrink-0 gap-1 border-amber-300 bg-amber-50 px-1.5 text-[11px] text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
      >
        <Flame className="h-3 w-3" aria-hidden="true" />
        {t("accounts.policies.burn_first")}
      </Badge>
    );
  }
  if (policy === "preserve") {
    return (
      <Badge
        variant="outline"
        className="shrink-0 gap-1 border-sky-300 bg-sky-50 px-1.5 text-[11px] text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300"
      >
        <Shield className="h-3 w-3" aria-hidden="true" />
        {t("accounts.policies.preserve")}
      </Badge>
    );
  }
  if (hideNormal) return null;
  return (
    <Badge variant="outline" className="shrink-0 px-1.5 text-[11px] text-muted-foreground">
      {t("accounts.policies.normal")}
    </Badge>
  );
}

/** Key icon for Console API keys, person icon for Claude subscriptions. */
export function ProviderIcon({
  account,
  className,
}: {
  account: Pick<Account, "planType" | "authScheme" | "provider">;
  className?: string;
}) {
  const { t } = useTranslation();
  const subscription = isSubscription(account);
  const Icon = subscription ? UserRound : KeyRound;
  const label = subscription ? t("accounts.provider.subscription") : t("accounts.provider.apiKey");
  return (
    <span
      className={cn(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
        subscription ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
        className,
      )}
      title={label}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

const RISK_CLASSES: Record<string, string> = {
  safe: "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  warning: "border-amber-500/20 bg-amber-500/15 text-amber-700 dark:text-amber-400",
  danger: "border-orange-500/20 bg-orange-500/15 text-orange-700 dark:text-orange-400",
  critical: "border-red-500/20 bg-red-500/15 text-red-700 dark:text-red-400",
};

export function RiskBadge({ level, risk }: { level: string; risk?: number }) {
  const { t } = useTranslation();
  return (
    <Badge
      variant="outline"
      className={cn("shrink-0 px-1.5 text-[11px]", RISK_CLASSES[level] ?? RISK_CLASSES.safe)}
      title={risk !== undefined ? t("accounts.risk.title", { percent: Math.round(risk * 100) }) : undefined}
    >
      {t(`accounts.risk.${level}`, { defaultValue: level })}
    </Badge>
  );
}
