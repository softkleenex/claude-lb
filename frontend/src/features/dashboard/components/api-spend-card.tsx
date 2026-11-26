import { KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";

import { UsageBar } from "@/features/accounts/components/account-quota-bars";
import type { ApiAccountSpend } from "@/features/dashboard/schemas";
import { formatUsd } from "@/features/dashboard/utils";

/** API-key accounts have no 5h/7d windows; their limit is the operator's spend cap. */
export function ApiSpendCard({ accounts }: { accounts: ApiAccountSpend[] }) {
  const { t } = useTranslation();
  if (accounts.length === 0) return null;
  const capped = accounts.filter((account) => account.spendCapUsd !== null);
  const totalSpend = accounts.reduce((sum, account) => sum + account.spendUsd, 0);

  return (
    <section className="min-w-0 rounded-xl border bg-card p-5" aria-label={t("dashboard.apiSpend.title")}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{t("dashboard.apiSpend.title")}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("dashboard.apiSpend.subtitle", { count: accounts.length, total: formatUsd(totalSpend) })}
          </p>
        </div>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
          <KeyRound className="h-4 w-4" aria-hidden="true" />
        </div>
      </div>
      <ul className="space-y-3">
        {accounts.map((account) => (
          <li key={account.accountId} className="space-y-1.5" data-testid={`api-spend-${account.accountId}`}>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="truncate font-medium">{account.accountName}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {account.spendCapUsd !== null
                  ? t("dashboard.apiSpend.ofCap", {
                      spent: formatUsd(account.spendUsd),
                      cap: formatUsd(account.spendCapUsd),
                    })
                  : t("dashboard.apiSpend.noCap", { spent: formatUsd(account.spendUsd) })}
              </span>
            </div>
            {account.capUsedPercent !== null ? (
              <UsageBar usedPercent={account.capUsedPercent} label={t("dashboard.apiSpend.capUsed")} />
            ) : null}
          </li>
        ))}
      </ul>
      {capped.length === 0 ? (
        <p className="mt-3 text-[11px] text-muted-foreground">{t("dashboard.apiSpend.hint")}</p>
      ) : null}
    </section>
  );
}
