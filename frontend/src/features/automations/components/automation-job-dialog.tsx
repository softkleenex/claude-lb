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
import { useModels } from "@/features/api-keys/hooks/use-models";
import { browserTimezone, sortDays, timezoneOptions, windowResetTime } from "@/features/automations/schedule";
import { type AutomationJob, type JobInput, WEEKDAYS, type Weekday } from "@/features/automations/schemas";
import { cn } from "@/lib/utils";

export const DEFAULT_MAX_TOKENS = 16;
const DEFAULT_MODEL = "claude-haiku-4-5";

type Limits = { maxTokensCap: number; maxSpreadMinutes: number };

type Draft = {
  name: string;
  enabled: boolean;
  days: Weekday[];
  time: string;
  timezone: string;
  spreadMinutes: string;
  model: string;
  prompt: string;
  maxTokens: string;
  accountIds: string[];
  includePausedAccounts: boolean;
};

function draftFrom(job: AutomationJob | null): Draft {
  if (!job) {
    return {
      name: "",
      enabled: true,
      days: ["mon", "tue", "wed", "thu", "fri"],
      time: "07:00",
      timezone: browserTimezone(),
      spreadMinutes: "0",
      model: DEFAULT_MODEL,
      prompt: "Reply with OK.",
      maxTokens: String(DEFAULT_MAX_TOKENS),
      accountIds: [],
      includePausedAccounts: false,
    };
  }
  return {
    name: job.name,
    enabled: job.enabled,
    days: job.schedule.days,
    time: job.schedule.time,
    timezone: job.schedule.timezone,
    spreadMinutes: String(job.schedule.spreadMinutes),
    model: job.model,
    prompt: job.prompt,
    maxTokens: String(job.maxTokens),
    accountIds: job.accountIds,
    includePausedAccounts: job.includePausedAccounts,
  };
}

function toInput(draft: Draft): JobInput {
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    schedule: {
      days: sortDays(draft.days),
      time: draft.time,
      timezone: draft.timezone.trim(),
      spreadMinutes: Number.parseInt(draft.spreadMinutes, 10) || 0,
    },
    model: draft.model.trim(),
    prompt: draft.prompt,
    maxTokens: Number.parseInt(draft.maxTokens, 10),
    accountIds: draft.accountIds,
    includePausedAccounts: draft.includePausedAccounts,
  };
}

/** Only the fields that differ from the saved job (PATCH semantics). */
function changesFor(job: AutomationJob, input: JobInput): Partial<JobInput> {
  const changes: Partial<JobInput> = {};
  if (input.name !== job.name) changes.name = input.name;
  if (input.enabled !== job.enabled) changes.enabled = input.enabled;
  const scheduleChanged =
    input.schedule.days.join(",") !== job.schedule.days.join(",") ||
    input.schedule.time !== job.schedule.time ||
    input.schedule.timezone !== job.schedule.timezone ||
    input.schedule.spreadMinutes !== job.schedule.spreadMinutes;
  if (scheduleChanged) changes.schedule = input.schedule;
  if (input.model !== job.model) changes.model = input.model;
  if (input.prompt !== job.prompt) changes.prompt = input.prompt;
  if (input.maxTokens !== job.maxTokens) changes.maxTokens = input.maxTokens;
  if (input.accountIds.join(",") !== job.accountIds.join(",")) changes.accountIds = input.accountIds;
  if (input.includePausedAccounts !== job.includePausedAccounts) {
    changes.includePausedAccounts = input.includePausedAccounts;
  }
  return changes;
}

type Problems = Partial<Record<"name" | "days" | "time" | "timezone" | "spread" | "model" | "prompt" | "maxTokens", string>>;

function validate(draft: Draft, limits: Limits): Problems {
  const problems: Problems = {};
  if (!draft.name.trim()) problems.name = "automations.validation.name";
  if (draft.days.length === 0) problems.days = "automations.validation.days";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) problems.time = "automations.validation.time";
  if (!draft.timezone.trim()) problems.timezone = "automations.validation.timezone";
  const spread = Number(draft.spreadMinutes);
  if (!/^\d+$/.test(draft.spreadMinutes) || spread > limits.maxSpreadMinutes) problems.spread = "automations.validation.spread";
  if (!draft.model.trim()) problems.model = "automations.validation.model";
  if (!draft.prompt.trim()) problems.prompt = "automations.validation.prompt";
  const maxTokens = Number(draft.maxTokens);
  if (!/^\d+$/.test(draft.maxTokens) || maxTokens < 1 || maxTokens > limits.maxTokensCap) {
    problems.maxTokens = "automations.validation.maxTokens";
  }
  return problems;
}

export type AutomationJobDialogProps = {
  open: boolean;
  job: AutomationJob | null;
  limits: Limits;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: JobInput) => Promise<unknown>;
  onUpdate: (job: AutomationJob, changes: Partial<JobInput>) => Promise<unknown>;
};

export function AutomationJobDialog({ open, job, limits, busy, onOpenChange, onCreate, onUpdate }: AutomationJobDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{job ? t("automations.dialog.editTitle") : t("automations.dialog.createTitle")}</DialogTitle>
          <DialogDescription>{t("automations.dialog.description")}</DialogDescription>
        </DialogHeader>
        {open ? (
          <JobForm
            key={job?.id ?? "new"}
            job={job}
            limits={limits}
            busy={busy}
            onSubmit={async (input) => {
              if (job) {
                const changes = changesFor(job, input);
                if (Object.keys(changes).length > 0) await onUpdate(job, changes);
              } else {
                await onCreate(input);
              }
              onOpenChange(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function FieldError({ problem }: { problem?: string }) {
  const { t } = useTranslation();
  return problem ? <p className="text-xs text-destructive">{t(problem)}</p> : null;
}

function JobForm({
  job,
  limits,
  busy,
  onSubmit,
}: {
  job: AutomationJob | null;
  limits: Limits;
  busy: boolean;
  onSubmit: (input: JobInput) => Promise<void>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const { data: models = [] } = useModels();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(job));
  const [submitted, setSubmitted] = useState(false);
  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const problems = validate(draft, limits);
  const shown = submitted ? problems : {};
  const zones = useMemo(() => timezoneOptions(draft.timezone), [draft.timezone]);
  const resetAt = windowResetTime(draft.time);

  const toggleDay = (day: Weekday) =>
    update({ days: draft.days.includes(day) ? draft.days.filter((d) => d !== day) : [...draft.days, day] });

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (Object.keys(problems).length > 0) return;
    try {
      await onSubmit(toInput(draft));
    } catch {
      // The mutation toasted the error; keep the dialog open for a retry.
    }
  };

  const sectionTitle = "text-xs font-semibold uppercase tracking-wider text-muted-foreground";

  return (
    <form onSubmit={handleSubmit} noValidate>
      <div className="grid gap-x-6 gap-y-5 md:grid-cols-2">
        <div className="space-y-4">
          <section className="space-y-3">
            <h4 className={sectionTitle}>{t("automations.dialog.basics")}</h4>
            <div className="space-y-1">
              <label htmlFor={`${id}-name`} className="text-sm font-medium">
                {t("automations.dialog.name")}
              </label>
              <Input
                id={`${id}-name`}
                name="name"
                value={draft.name}
                maxLength={128}
                autoComplete="off"
                placeholder={t("automations.dialog.namePlaceholder")}
                aria-invalid={!!shown.name}
                onChange={(event) => update({ name: event.target.value })}
              />
              <FieldError problem={shown.name} />
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <label htmlFor={`${id}-enabled`} className="text-sm">
                {t("automations.dialog.enabled")}
              </label>
              <Switch id={`${id}-enabled`} checked={draft.enabled} onCheckedChange={(enabled) => update({ enabled })} />
            </div>
          </section>

          <section className="space-y-3">
            <h4 className={sectionTitle}>{t("automations.dialog.schedule")}</h4>
            <div className="space-y-1.5">
              <p className="text-sm font-medium">{t("automations.dialog.days")}</p>
              <div className="flex flex-wrap gap-1" role="group" aria-label={t("automations.dialog.days")}>
                {WEEKDAYS.map((day) => (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={draft.days.includes(day)}
                    onClick={() => toggleDay(day)}
                    className={cn(
                      "h-8 min-w-10 rounded-md border px-2 text-xs font-medium transition-colors",
                      draft.days.includes(day)
                        ? "border-primary bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t(`automations.days.${day}`)}
                  </button>
                ))}
              </div>
              <div className="flex gap-2 text-xs">
                <button type="button" className="text-primary hover:underline" onClick={() => update({ days: ["mon", "tue", "wed", "thu", "fri"] })}>
                  {t("automations.schedule.weekdays")}
                </button>
                <button type="button" className="text-primary hover:underline" onClick={() => update({ days: [...WEEKDAYS] })}>
                  {t("automations.schedule.everyDay")}
                </button>
              </div>
              <FieldError problem={shown.days} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label htmlFor={`${id}-time`} className="text-sm font-medium">
                  {t("automations.dialog.time")}
                </label>
                <Input
                  id={`${id}-time`}
                  name="time"
                  type="time"
                  step={60}
                  value={draft.time}
                  aria-invalid={!!shown.time}
                  onChange={(event) => update({ time: event.target.value.slice(0, 5) })}
                />
                <FieldError problem={shown.time} />
              </div>
              <div className="space-y-1">
                <label htmlFor={`${id}-spread`} className="text-sm font-medium">
                  {t("automations.dialog.spread")}
                </label>
                <Input
                  id={`${id}-spread`}
                  name="spread"
                  inputMode="numeric"
                  value={draft.spreadMinutes}
                  aria-invalid={!!shown.spread}
                  onChange={(event) => update({ spreadMinutes: event.target.value.trim() })}
                />
                <FieldError problem={shown.spread} />
              </div>
            </div>
            <div className="space-y-1">
              <label htmlFor={`${id}-tz`} className="text-sm font-medium">
                {t("automations.dialog.timezone")}
              </label>
              <Input
                id={`${id}-tz`}
                name="timezone"
                list={`${id}-tz-list`}
                value={draft.timezone}
                autoComplete="off"
                aria-invalid={!!shown.timezone}
                onChange={(event) => update({ timezone: event.target.value })}
              />
              <datalist id={`${id}-tz-list`}>
                {zones.map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
              <FieldError problem={shown.timezone} />
            </div>
            <p className="text-xs text-muted-foreground">
              {t("automations.dialog.spreadHelp", { max: limits.maxSpreadMinutes })}
              {resetAt ? ` ${t("automations.dialog.windowHint", { time: draft.time, reset: resetAt })}` : ""}
            </p>
          </section>
        </div>

        <div className="space-y-4">
          <section className="space-y-3">
            <h4 className={sectionTitle}>{t("automations.dialog.request")}</h4>
            <div className="space-y-1">
              <label htmlFor={`${id}-model`} className="text-sm font-medium">
                {t("automations.dialog.model")}
              </label>
              <Input
                id={`${id}-model`}
                name="model"
                list={`${id}-models`}
                value={draft.model}
                autoComplete="off"
                aria-invalid={!!shown.model}
                onChange={(event) => update({ model: event.target.value })}
              />
              <datalist id={`${id}-models`}>
                {models.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
              <FieldError problem={shown.model} />
            </div>
            <div className="space-y-1">
              <label htmlFor={`${id}-prompt`} className="text-sm font-medium">
                {t("automations.dialog.prompt")}
              </label>
              <textarea
                id={`${id}-prompt`}
                name="prompt"
                rows={3}
                maxLength={2000}
                value={draft.prompt}
                aria-invalid={!!shown.prompt}
                onChange={(event) => update({ prompt: event.target.value })}
                className="w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
              <FieldError problem={shown.prompt} />
            </div>
            <div className="space-y-1">
              <label htmlFor={`${id}-max-tokens`} className="text-sm font-medium">
                {t("automations.dialog.maxTokens")}
              </label>
              <Input
                id={`${id}-max-tokens`}
                name="maxTokens"
                inputMode="numeric"
                value={draft.maxTokens}
                aria-invalid={!!shown.maxTokens}
                onChange={(event) => update({ maxTokens: event.target.value.trim() })}
                className="w-32"
              />
              <p className="text-xs text-muted-foreground">
                {t("automations.dialog.maxTokensHelp", { max: limits.maxTokensCap })}
              </p>
              <FieldError problem={shown.maxTokens} />
            </div>
          </section>

          <section className="space-y-3">
            <h4 className={sectionTitle}>{t("automations.dialog.accounts")}</h4>
            <AccountMultiSelect
              value={draft.accountIds}
              onChange={(accountIds) => update({ accountIds })}
              placeholder={t("automations.dialog.allAccounts")}
              allowPausedAccounts={draft.includePausedAccounts}
            />
            <p className="text-xs text-muted-foreground">{t("automations.dialog.accountsHelp")}</p>
            <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
              <div>
                <label htmlFor={`${id}-paused`} className="text-sm">
                  {t("automations.dialog.includePaused")}
                </label>
                <p className="text-xs text-muted-foreground">{t("automations.dialog.includePausedHelp")}</p>
              </div>
              <Switch
                id={`${id}-paused`}
                checked={draft.includePausedAccounts}
                onCheckedChange={(includePausedAccounts) => update({ includePausedAccounts })}
              />
            </div>
            <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              {t("automations.dialog.costNote")}
            </p>
          </section>
        </div>
      </div>
      <DialogFooter className="mt-6">
        <Button type="submit" disabled={busy}>
          {job ? t("automations.dialog.save") : t("automations.dialog.create")}
        </Button>
      </DialogFooter>
    </form>
  );
}
