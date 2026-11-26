import { Ban } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { Account } from "@/features/accounts/schemas";
import {
  AccountStatusBadge,
  PlanBadge,
  ProviderIcon,
  RiskBadge,
  RoutingPolicyBadge,
} from "@/features/accounts/components/account-badges";
import { AccountQuotaBars } from "@/features/accounts/components/account-quota-bars";

export type AccountListItemProps = {
  account: Account;
  now: number;
  selected?: boolean;
  riskLevel?: string | null;
  onSelect?: (accountId: string) => void;
};

/**
 * One account as a selectable card: name, plan/policy/status badges and the 5h/7d bars.
 * Renders as a plain block when `onSelect` is omitted (e.g. read-only Dashboard cards).
 */
export function AccountListItem({ account, now, selected = false, riskLevel, onSelect }: AccountListItemProps) {
  const { t } = useTranslation();
  const body = (
    <>
      <div className="flex items-start gap-2.5">
        <ProviderIcon account={account} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{account.name}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <PlanBadge planType={account.planType} />
            <RoutingPolicyBadge policy={account.routingPolicy} hideNormal />
            {riskLevel && riskLevel !== "safe" ? <RiskBadge level={riskLevel} /> : null}
            {account.blockedModels.length > 0 ? (
              <span
                className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground"
                title={account.blockedModels.join(", ")}
              >
                <Ban className="h-3 w-3" aria-hidden="true" />
                {t("accounts.list.blockedCount", { count: account.blockedModels.length })}
              </span>
            ) : null}
          </div>
        </div>
        <AccountStatusBadge account={account} />
      </div>
      <div className="mt-2.5">
        <AccountQuotaBars account={account} now={now} />
      </div>
    </>
  );

  const className = cn(
    "relative block min-w-0 w-full rounded-lg px-3 py-2.5 text-left transition-colors",
    selected ? "bg-primary/8 ring-1 ring-primary/25" : onSelect ? "hover:bg-muted/50" : "border bg-card",
  );

  if (!onSelect) {
    return <div className={className}>{body}</div>;
  }
  return (
    <button
      type="button"
      aria-pressed={selected}
      data-testid={`account-item-${account.id}`}
      onClick={() => onSelect(account.id)}
      className={className}
    >
      {body}
    </button>
  );
}
