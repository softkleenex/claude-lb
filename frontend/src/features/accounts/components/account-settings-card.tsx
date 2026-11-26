import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  PLAN_TYPES,
  ROUTING_POLICIES,
  type Account,
  type AccountUpdateRequest,
  type RoutingPolicy,
} from "@/features/accounts/schemas";
import { UsageBar } from "@/features/accounts/components/account-quota-bars";
import { formatCurrency } from "@/utils/formatters";

export type AccountSettingsCardProps = {
  account: Account;
  disabled?: boolean;
  onUpdate: (patch: AccountUpdateRequest) => Promise<unknown>;
};

function parseNumber(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Plan, routing policy, weight, priority and spend cap for one account. */
export function AccountSettingsCard({ account, disabled = false, onUpdate }: AccountSettingsCardProps) {
  const { t } = useTranslation();
  // Remount the drafts whenever the server values change underneath them.
  const draftKey = `${account.id}:${account.weight}:${account.priority}:${account.spendCapUsd ?? ""}`;

  return (
    <section className="space-y-4 rounded-lg border bg-muted/30 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {t("accounts.settings.title")}
      </h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="account-plan">{t("accounts.settings.plan")}</Label>
          <Select
            value={account.planType}
            disabled={disabled}
            onValueChange={(planType) => void onUpdate({ planType }).catch(() => null)}
          >
            <SelectTrigger id="account-plan" size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLAN_TYPES.map((plan) => (
                <SelectItem key={plan} value={plan}>
                  {t(`accounts.plans.${plan}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            {t("accounts.settings.capacity", { credits: Math.round(account.effectiveCapacity) })}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="account-policy">{t("accounts.settings.policy")}</Label>
          <Select
            value={account.routingPolicy}
            disabled={disabled}
            onValueChange={(routingPolicy) =>
              void onUpdate({ routingPolicy: routingPolicy as RoutingPolicy }).catch(() => null)
            }
          >
            <SelectTrigger id="account-policy" size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROUTING_POLICIES.map((policy) => (
                <SelectItem key={policy} value={policy}>
                  {t(`accounts.policies.${policy}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            {t(`accounts.policyHelp.${account.routingPolicy}`, { defaultValue: "" })}
          </p>
        </div>
      </div>
      <NumbersForm key={draftKey} account={account} disabled={disabled} onUpdate={onUpdate} />
    </section>
  );
}

function NumbersForm({ account, disabled, onUpdate }: AccountSettingsCardProps) {
  const { t } = useTranslation();
  const [weight, setWeight] = useState(String(account.weight));
  const [priority, setPriority] = useState(String(account.priority));
  const [spendCap, setSpendCap] = useState(account.spendCapUsd === null ? "" : String(account.spendCapUsd));

  const weightValue = parseNumber(weight);
  const priorityValue = parseNumber(priority);
  const capValue = parseNumber(spendCap);
  const weightInvalid = weightValue === null || weightValue < 0;
  const priorityInvalid = priorityValue === null || !Number.isInteger(priorityValue);
  const capInvalid = spendCap.trim() !== "" && (capValue === null || capValue < 0);

  const patch: AccountUpdateRequest = {};
  if (!weightInvalid && weightValue !== account.weight) patch.weight = weightValue;
  if (!priorityInvalid && priorityValue !== account.priority) patch.priority = priorityValue;
  if (!capInvalid && capValue !== account.spendCapUsd) patch.spendCapUsd = capValue;
  const dirty = Object.keys(patch).length > 0;
  const invalid = weightInvalid || priorityInvalid || capInvalid;

  const spent = account.totalCostUsd;
  const cap = account.spendCapUsd;
  const capUsed = cap !== null && cap > 0 ? Math.min(100, (spent / cap) * 100) : cap === 0 ? 100 : null;

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty && !invalid) void onUpdate(patch).catch(() => null);
      }}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="account-weight">{t("accounts.settings.weight")}</Label>
          <Input
            id="account-weight"
            type="number"
            step="0.1"
            min="0"
            className={cn("h-8", weightInvalid && "border-destructive")}
            value={weight}
            disabled={disabled}
            onChange={(event) => setWeight(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="account-priority">{t("accounts.settings.priority")}</Label>
          <Input
            id="account-priority"
            type="number"
            step="1"
            className={cn("h-8", priorityInvalid && "border-destructive")}
            value={priority}
            disabled={disabled}
            onChange={(event) => setPriority(event.target.value)}
          />
        </div>
        <div className="col-span-2 space-y-1.5 sm:col-span-1">
          <Label htmlFor="account-spend-cap">{t("accounts.settings.spendCap")}</Label>
          <Input
            id="account-spend-cap"
            type="number"
            step="0.01"
            min="0"
            placeholder={t("accounts.settings.noCap")}
            className={cn("h-8", capInvalid && "border-destructive")}
            value={spendCap}
            disabled={disabled}
            onChange={(event) => setSpendCap(event.target.value)}
          />
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">{t("accounts.settings.weightPriorityHelp")}</p>

      <div className="space-y-1.5 rounded-md border bg-background/60 px-3 py-2">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="font-medium">{t("accounts.settings.spendTitle")}</span>
          <span className="tabular-nums" data-testid="spend-summary">
            {cap === null
              ? t("accounts.settings.spentNoCap", { spent: formatCurrency(spent) })
              : t("accounts.settings.spentOfCap", { spent: formatCurrency(spent), cap: formatCurrency(cap) })}
          </span>
        </div>
        {capUsed !== null ? <UsageBar usedPercent={capUsed} label={t("accounts.settings.spendTitle")} /> : null}
        <p className="text-[11px] text-muted-foreground">
          {account.spendCapReached ? t("accounts.settings.capReached") : t("accounts.settings.spendCapHelp")}
        </p>
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        {account.spendCapUsd !== null ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => void onUpdate({ spendCapUsd: null }).catch(() => null)}
          >
            {t("accounts.settings.removeCap")}
          </Button>
        ) : null}
        <Button type="submit" size="sm" disabled={disabled || !dirty || invalid}>
          {t("common.actions.save")}
        </Button>
      </div>
    </form>
  );
}
