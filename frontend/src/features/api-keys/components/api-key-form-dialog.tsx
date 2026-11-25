import { useId, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { AccountMultiSelect } from "@/features/api-keys/components/account-multi-select";
import { ExpiryPicker } from "@/features/api-keys/components/expiry-picker";
import { LimitRulesEditor } from "@/features/api-keys/components/limit-rules-editor";
import { ModelMultiSelect } from "@/features/api-keys/components/model-multi-select";
import { useModels } from "@/features/api-keys/hooks/use-models";
import { limitToInput, normalizeRules, ruleProblem, rulesChanged, sameIds } from "@/features/api-keys/lib";
import type {
  ApiKey,
  ApiKeyCreateRequest,
  ApiKeyUpdateRequest,
  LimitRuleInput,
} from "@/features/api-keys/schemas";
import { parseServerDate } from "@/utils/server-date";

type Draft = {
  name: string;
  enabled: boolean;
  expiresAt: Date | null;
  allowedModels: string[];
  enforcedModel: string;
  accountIds: string[];
  rules: LimitRuleInput[];
};

function draftFrom(apiKey: ApiKey | null): Draft {
  if (!apiKey) {
    return { name: "", enabled: true, expiresAt: null, allowedModels: [], enforcedModel: "", accountIds: [], rules: [] };
  }
  return {
    name: apiKey.name,
    enabled: apiKey.enabled,
    expiresAt: parseServerDate(apiKey.expiresAt),
    allowedModels: apiKey.allowedModels ?? [],
    enforcedModel: apiKey.enforcedModel ?? "",
    // A key pinned to one account (CLI / older API) shows as assigned to it.
    accountIds: apiKey.assignedAccountIds ?? (apiKey.pinnedAccountId ? [apiKey.pinnedAccountId] : []),
    rules: apiKey.limits.map(limitToInput),
  };
}

function buildCreate(draft: Draft): ApiKeyCreateRequest {
  const rules = normalizeRules(draft.rules);
  return {
    name: draft.name.trim(),
    expiresAt: draft.expiresAt?.toISOString() ?? null,
    allowedModels: draft.allowedModels.length > 0 ? draft.allowedModels : null,
    enforcedModel: draft.enforcedModel.trim() || null,
    assignedAccountIds: draft.accountIds.length > 0 ? draft.accountIds : null,
    ...(rules.length > 0 ? { limits: rules } : {}),
  };
}

/** Only what changed, so an edit never rewrites fields the operator did not touch. */
function buildUpdate(apiKey: ApiKey, draft: Draft): ApiKeyUpdateRequest {
  const initial = draftFrom(apiKey);
  const payload: ApiKeyUpdateRequest = {};
  if (draft.name.trim() !== apiKey.name) payload.name = draft.name.trim();
  if (draft.enabled !== apiKey.enabled) payload.enabled = draft.enabled;
  if ((draft.expiresAt?.getTime() ?? null) !== (initial.expiresAt?.getTime() ?? null)) {
    payload.expiresAt = draft.expiresAt?.toISOString() ?? null;
  }
  if (!sameIds(draft.allowedModels, initial.allowedModels)) {
    payload.allowedModels = draft.allowedModels.length > 0 ? draft.allowedModels : null;
  }
  if (draft.enforcedModel.trim() !== initial.enforcedModel) payload.enforcedModel = draft.enforcedModel.trim() || null;
  if (!sameIds(draft.accountIds, initial.accountIds)) {
    payload.assignedAccountIds = draft.accountIds.length > 0 ? draft.accountIds : null;
    if (apiKey.pinnedAccountId) payload.pinnedAccountId = null;
  }
  // `limits` replaces every rule, including a legacy budget shown as rules.
  if (rulesChanged(initial.rules, draft.rules)) payload.limits = normalizeRules(draft.rules);
  return payload;
}

export type ApiKeyFormDialogProps = {
  open: boolean;
  busy: boolean;
  /** Null to create a key. */
  apiKey: ApiKey | null;
  onOpenChange: (open: boolean) => void;
  onCreate: (payload: ApiKeyCreateRequest) => Promise<void>;
  onUpdate: (apiKey: ApiKey, payload: ApiKeyUpdateRequest) => Promise<void>;
};

export function ApiKeyFormDialog({ open, busy, apiKey, onOpenChange, onCreate, onUpdate }: ApiKeyFormDialogProps) {
  const { t } = useTranslation();
  const editing = apiKey !== null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{editing ? t("apiKeys.form.editTitle") : t("apiKeys.form.createTitle")}</DialogTitle>
          <DialogDescription>
            {editing ? t("apiKeys.form.editDescription") : t("apiKeys.form.createDescription")}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <ApiKeyForm
            key={apiKey?.id ?? "new"}
            apiKey={apiKey}
            busy={busy}
            onSubmit={async (draft) => {
              if (apiKey) {
                const payload = buildUpdate(apiKey, draft);
                if (Object.keys(payload).length > 0) await onUpdate(apiKey, payload);
              } else {
                await onCreate(buildCreate(draft));
              }
              onOpenChange(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ApiKeyForm({
  apiKey,
  busy,
  onSubmit,
}: {
  apiKey: ApiKey | null;
  busy: boolean;
  onSubmit: (draft: Draft) => Promise<void>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const { data: models = [] } = useModels();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(apiKey));
  const [submitted, setSubmitted] = useState(false);
  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  const nameMissing = draft.name.trim().length === 0;
  const badRule = draft.rules.some((rule) => ruleProblem(rule) === "window");
  const enforcedOutsideAllowlist = useMemo(() => {
    const enforced = draft.enforcedModel.trim();
    if (!enforced || draft.allowedModels.length === 0) return false;
    return !draft.allowedModels.some((entry) => enforced === entry || enforced.startsWith(`${entry}-`));
  }, [draft.allowedModels, draft.enforcedModel]);
  const hasLegacy = apiKey?.limits.some((limit) => limit.source === "legacy") ?? false;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (nameMissing || badRule) return;
    try {
      await onSubmit(draft);
    } catch {
      // The mutation already toasted the error; keep the dialog open for a retry.
    }
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
        <div className="space-y-4">
          <section className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t("apiKeys.form.general")}
            </h4>
            <div className="space-y-1">
              <label htmlFor={`${id}-name`} className="text-sm font-medium">
                {t("apiKeys.form.name")}
              </label>
              <Input
                id={`${id}-name`}
                name="name"
                value={draft.name}
                autoComplete="off"
                maxLength={128}
                aria-invalid={submitted && nameMissing}
                onChange={(event) => update({ name: event.target.value })}
              />
              {submitted && nameMissing ? (
                <p className="text-xs text-destructive">{t("apiKeys.validation.nameRequired")}</p>
              ) : null}
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">{t("apiKeys.form.expiry")}</p>
              <ExpiryPicker value={draft.expiresAt} onChange={(expiresAt) => update({ expiresAt })} />
            </div>
            {apiKey ? (
              <div className="flex items-center justify-between rounded-md border px-3 py-2">
                <label htmlFor={`${id}-enabled`} className="text-sm">
                  {t("apiKeys.form.enabled")}
                </label>
                <Switch
                  id={`${id}-enabled`}
                  checked={draft.enabled}
                  onCheckedChange={(enabled) => update({ enabled })}
                />
              </div>
            ) : null}
          </section>

          <section className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t("apiKeys.form.access")}
            </h4>
            <div className="space-y-1">
              <label htmlFor={`${id}-models`} className="text-sm font-medium">
                {t("apiKeys.form.allowedModels")}
              </label>
              <ModelMultiSelect
                triggerId={`${id}-models`}
                value={draft.allowedModels}
                onChange={(allowedModels) => update({ allowedModels })}
              />
              <p className="text-xs text-muted-foreground">{t("apiKeys.form.allowedModelsHint")}</p>
            </div>
            <div className="space-y-1">
              <label htmlFor={`${id}-enforced`} className="text-sm font-medium">
                {t("apiKeys.form.enforcedModel")}
              </label>
              <Input
                id={`${id}-enforced`}
                name="enforced-model"
                list={`${id}-enforced-options`}
                value={draft.enforcedModel}
                placeholder={t("apiKeys.form.enforcedModelPlaceholder")}
                autoComplete="off"
                className="font-mono text-xs"
                onChange={(event) => update({ enforcedModel: event.target.value })}
              />
              <datalist id={`${id}-enforced-options`}>
                {models.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
              <p className="text-xs text-muted-foreground">{t("apiKeys.form.enforcedModelHint")}</p>
              {enforcedOutsideAllowlist ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">{t("apiKeys.form.enforcedNotAllowed")}</p>
              ) : null}
            </div>
            <div className="space-y-1">
              <label htmlFor={`${id}-accounts`} className="text-sm font-medium">
                {t("apiKeys.form.assignedAccounts")}
              </label>
              <AccountMultiSelect
                triggerId={`${id}-accounts`}
                value={draft.accountIds}
                onChange={(accountIds) => update({ accountIds })}
                allowPausedAccounts
              />
              <p className="text-xs text-muted-foreground">{t("apiKeys.form.assignedAccountsHint")}</p>
            </div>
          </section>
        </div>

        <section className="space-y-3 max-md:border-t max-md:pt-4">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("apiKeys.form.limits")}
          </h4>
          {hasLegacy ? (
            <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              {t("apiKeys.form.legacyNote")}
            </p>
          ) : null}
          <LimitRulesEditor rules={draft.rules} onChange={(rules) => update({ rules })} />
        </section>
      </div>

      <DialogFooter className="mt-6">
        <Button type="submit" disabled={busy}>
          {apiKey ? t("common.actions.save") : t("common.actions.create")}
        </Button>
      </DialogFooter>
    </form>
  );
}
