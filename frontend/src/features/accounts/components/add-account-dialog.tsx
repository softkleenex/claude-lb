import { FileJson, KeyRound, UserRound } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { AlertMessage } from "@/components/alert-message";
import { CopyButton } from "@/components/copy-button";
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
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  ROUTING_POLICIES,
  SUBSCRIPTION_PLAN_TYPES,
  type AccountCreateRequest,
  type AccountImportRequest,
  type RoutingPolicy,
} from "@/features/accounts/schemas";
import {
  ADD_ACCOUNT_TABS,
  buildAddSubscriptionCommand,
  SUBSCRIPTION_TOKEN_PREFIX,
  type AddAccountTab,
} from "@/features/accounts/lib/subscription-command";
import { getErrorMessageOrNull } from "@/utils/errors";

export type AddAccountDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (payload: AccountCreateRequest) => Promise<unknown>;
  onImport: (payload: AccountImportRequest) => Promise<unknown>;
  initialTab?: AddAccountTab;
};

function Field({ id, label, hint, children }: { id: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function PolicySelect({ id, value, onChange }: { id: string; value: RoutingPolicy; onChange: (value: RoutingPolicy) => void }) {
  const { t } = useTranslation();
  return (
    <Select value={value} onValueChange={(next) => onChange(next as RoutingPolicy)}>
      <SelectTrigger id={id} size="sm" className="w-full">
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
  );
}

function PlanSelect({
  id,
  value,
  onChange,
  allowDetect = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  allowDetect?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} size="sm" className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {allowDetect ? <SelectItem value="detect">{t("accounts.add.detectPlan")}</SelectItem> : null}
        {SUBSCRIPTION_PLAN_TYPES.map((plan) => (
          <SelectItem key={plan} value={plan}>
            {t(`accounts.plans.${plan}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function parseOptionalNumber(raw: string): number | null | "invalid" {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : "invalid";
}

function ApiKeyForm({ onCreate, onDone }: { onCreate: AddAccountDialogProps["onCreate"]; onDone: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [policy, setPolicy] = useState<RoutingPolicy>("normal");
  const [weight, setWeight] = useState("1");
  const [priority, setPriority] = useState("0");
  const [spendCap, setSpendCap] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const weightValue = parseOptionalNumber(weight);
  const capValue = parseOptionalNumber(spendCap);
  const priorityValue = Number(priority);
  const invalid =
    !name.trim() ||
    apiKey.trim().length < 8 ||
    weightValue === "invalid" ||
    weightValue === null ||
    capValue === "invalid" ||
    !Number.isInteger(priorityValue);

  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (invalid) return;
        setSubmitting(true);
        setError(null);
        try {
          await onCreate({
            name: name.trim(),
            apiKey: apiKey.trim(),
            planType: "api",
            routingPolicy: policy,
            weight: weightValue as number,
            priority: priorityValue,
            spendCapUsd: capValue as number | null,
          });
          onDone();
        } catch (caught) {
          setError(getErrorMessageOrNull(caught));
        } finally {
          setSubmitting(false);
        }
      }}
    >
      <p className="text-xs text-muted-foreground">{t("accounts.add.apiKey.intro")}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id={`${id}-name`} label={t("accounts.add.name")}>
          <Input id={`${id}-name`} className="h-8" value={name} maxLength={128} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field id={`${id}-policy`} label={t("accounts.settings.policy")}>
          <PolicySelect id={`${id}-policy`} value={policy} onChange={setPolicy} />
        </Field>
      </div>
      <Field id={`${id}-key`} label={t("accounts.add.apiKey.key")} hint={t("accounts.add.apiKey.keyHint")}>
        <Input
          id={`${id}-key`}
          className="h-8 font-mono"
          type="password"
          autoComplete="off"
          placeholder="sk-ant-api03-…"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field id={`${id}-weight`} label={t("accounts.settings.weight")}>
          <Input id={`${id}-weight`} className="h-8" type="number" step="0.1" min="0" value={weight} onChange={(e) => setWeight(e.target.value)} />
        </Field>
        <Field id={`${id}-priority`} label={t("accounts.settings.priority")}>
          <Input id={`${id}-priority`} className="h-8" type="number" step="1" value={priority} onChange={(e) => setPriority(e.target.value)} />
        </Field>
        <Field id={`${id}-cap`} label={t("accounts.settings.spendCap")}>
          <Input
            id={`${id}-cap`}
            className="h-8"
            type="number"
            step="0.01"
            min="0"
            placeholder={t("accounts.settings.noCap")}
            value={spendCap}
            onChange={(e) => setSpendCap(e.target.value)}
          />
        </Field>
      </div>
      <p className="text-[11px] text-muted-foreground">{t("accounts.add.apiKey.capHint")}</p>
      {error ? <AlertMessage variant="error">{error}</AlertMessage> : null}
      <DialogFooter>
        <Button type="submit" size="sm" disabled={invalid || submitting}>
          {t("accounts.add.apiKey.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}

function SubscriptionForm({ onCreate, onDone }: { onCreate: AddAccountDialogProps["onCreate"]; onDone: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState("");
  const [plan, setPlan] = useState<string>("pro");
  const [policy, setPolicy] = useState<RoutingPolicy>("normal");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const command = buildAddSubscriptionCommand(name, plan, policy);
  const trimmedToken = token.trim();
  const tokenLooksWrong = trimmedToken.length > 0 && !trimmedToken.startsWith(SUBSCRIPTION_TOKEN_PREFIX);
  const canPaste = !!name.trim() && trimmedToken.startsWith(SUBSCRIPTION_TOKEN_PREFIX) && trimmedToken.length > 20;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field id={`${id}-name`} label={t("accounts.add.name")}>
          <Input
            id={`${id}-name`}
            className="h-8"
            value={name}
            maxLength={128}
            placeholder={t("accounts.add.subscription.namePlaceholder")}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field id={`${id}-plan`} label={t("accounts.settings.plan")}>
          <PlanSelect id={`${id}-plan`} value={plan} onChange={setPlan} />
        </Field>
        <Field id={`${id}-policy`} label={t("accounts.settings.policy")}>
          <PolicySelect id={`${id}-policy`} value={policy} onChange={setPolicy} />
        </Field>
      </div>

      <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
        <p className="text-xs font-medium">{t("accounts.add.subscription.cliTitle")}</p>
        <p className="text-[11px] text-muted-foreground">{t("accounts.add.subscription.cliIntro")}</p>
        <div className="flex items-start gap-2">
          <code
            className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 font-mono text-[11px] break-all"
            data-testid="add-subscription-command"
          >
            {command}
          </code>
          <CopyButton value={command} iconOnly label={t("accounts.add.subscription.copyCommand")} />
        </div>
        <ol className="list-decimal space-y-0.5 pl-4 text-[11px] text-muted-foreground">
          <li>{t("accounts.add.subscription.step1")}</li>
          <li>{t("accounts.add.subscription.step2")}</li>
          <li>{t("accounts.add.subscription.step3")}</li>
        </ol>
        <p className="text-[11px] text-muted-foreground">{t("accounts.add.subscription.cliNote")}</p>
      </div>

      <form
        className="space-y-2 rounded-lg border p-3"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!canPaste) return;
          setSubmitting(true);
          setError(null);
          try {
            await onCreate({
              name: name.trim(),
              apiKey: trimmedToken,
              provider: "oauth",
              authScheme: "bearer",
              planType: plan,
              routingPolicy: policy,
            });
            onDone();
          } catch (caught) {
            setError(getErrorMessageOrNull(caught));
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <p className="text-xs font-medium">{t("accounts.add.subscription.pasteTitle")}</p>
        <p className="text-[11px] text-muted-foreground">{t("accounts.add.subscription.pasteIntro")}</p>
        <Label htmlFor={`${id}-token`} className="sr-only">
          {t("accounts.add.subscription.tokenLabel")}
        </Label>
        <Input
          id={`${id}-token`}
          className="h-8 font-mono"
          type="password"
          autoComplete="off"
          placeholder={`${SUBSCRIPTION_TOKEN_PREFIX}01-…`}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        {tokenLooksWrong ? (
          <p className="text-[11px] text-destructive">{t("accounts.add.subscription.tokenPrefix")}</p>
        ) : null}
        <p className="text-[11px] text-muted-foreground">{t("accounts.add.subscription.modelNote")}</p>
        {error ? <AlertMessage variant="error">{error}</AlertMessage> : null}
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={!canPaste || submitting}>
            {t("accounts.add.subscription.pasteSubmit")}
          </Button>
        </div>
      </form>
    </div>
  );
}

function ImportForm({ onImport, onDone }: { onImport: AddAccountDialogProps["onImport"]; onDone: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState("");
  const [plan, setPlan] = useState<string>("detect");
  const [policy, setPolicy] = useState<RoutingPolicy>("normal");
  const [credentials, setCredentials] = useState<Record<string, unknown> | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!credentials || !name.trim()) return;
        setSubmitting(true);
        setError(null);
        try {
          await onImport({
            name: name.trim(),
            credentials,
            planType: plan === "detect" ? undefined : plan,
            routingPolicy: policy,
          });
          onDone();
        } catch (caught) {
          setError(getErrorMessageOrNull(caught));
        } finally {
          setSubmitting(false);
        }
      }}
    >
      <p className="text-xs text-muted-foreground">{t("accounts.add.import.intro")}</p>
      <Field id={`${id}-file`} label={t("accounts.add.import.file")} hint={t("accounts.add.import.fileHint")}>
        <Input
          id={`${id}-file`}
          type="file"
          accept="application/json,.json"
          className="h-9"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            setCredentials(null);
            setFileName(file?.name ?? null);
            setError(null);
            if (!file) return;
            try {
              const parsed: unknown = JSON.parse(await file.text());
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("not an object");
              }
              setCredentials(parsed as Record<string, unknown>);
            } catch {
              setError(t("accounts.add.import.invalidJson"));
            }
          }}
        />
      </Field>
      {credentials && fileName ? (
        <p className="text-[11px] text-emerald-700 dark:text-emerald-400">
          {t("accounts.add.import.loaded", { file: fileName })}
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field id={`${id}-name`} label={t("accounts.add.name")}>
          <Input id={`${id}-name`} className="h-8" value={name} maxLength={128} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field id={`${id}-plan`} label={t("accounts.settings.plan")}>
          <PlanSelect id={`${id}-plan`} value={plan} onChange={setPlan} allowDetect />
        </Field>
        <Field id={`${id}-policy`} label={t("accounts.settings.policy")}>
          <PolicySelect id={`${id}-policy`} value={policy} onChange={setPolicy} />
        </Field>
      </div>
      <p className="text-[11px] text-muted-foreground">{t("accounts.add.import.privacy")}</p>
      {error ? <AlertMessage variant="error">{error}</AlertMessage> : null}
      <DialogFooter>
        <Button type="submit" size="sm" disabled={!credentials || !name.trim() || submitting}>
          {t("accounts.add.import.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}

const TAB_ICONS: Record<AddAccountTab, typeof KeyRound> = {
  apiKey: KeyRound,
  subscription: UserRound,
  import: FileJson,
};

export function AddAccountDialog({ open, onOpenChange, onCreate, onImport, initialTab = "apiKey" }: AddAccountDialogProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<AddAccountTab>(initialTab);
  const close = () => onOpenChange(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setTab(initialTab);
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("accounts.add.title")}</DialogTitle>
          <DialogDescription>{t("accounts.add.description")}</DialogDescription>
        </DialogHeader>
        <div role="tablist" aria-label={t("accounts.add.title")} className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
          {ADD_ACCOUNT_TABS.map((value) => {
            const Icon = TAB_ICONS[value];
            const selected = tab === value;
            return (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={selected}
                className={cn(
                  "flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                  selected ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setTab(value)}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                {t(`accounts.add.tabs.${value}`)}
              </button>
            );
          })}
        </div>
        <div role="tabpanel">
          {/* Each form remounts on tab switch so drafts never leak between kinds. */}
          {tab === "apiKey" ? <ApiKeyForm onCreate={onCreate} onDone={close} /> : null}
          {tab === "subscription" ? <SubscriptionForm onCreate={onCreate} onDone={close} /> : null}
          {tab === "import" ? <ImportForm onImport={onImport} onDone={close} /> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
