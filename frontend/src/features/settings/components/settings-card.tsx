import { useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export type SettingsCardProps = {
  id?: string;
  icon: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
};

/** The bordered card every settings section uses: icon, title, description, rows. */
export function SettingsCard({ id, icon: Icon, title, description, actions, children, className }: SettingsCardProps) {
  return (
    <section id={id} className={cn("rounded-xl border bg-card p-5", className)}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
            </div>
            <div>
              <h3 className="text-sm font-semibold">{title}</h3>
              {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
            </div>
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
        {children}
      </div>
    </section>
  );
}

export type SettingsRowProps = {
  label: ReactNode;
  description?: ReactNode;
  children: ReactNode;
};

export function SettingsRow({ label, description, children }: SettingsRowProps) {
  return (
    <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

export type SwitchSettingRowProps = {
  label: string;
  description?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
};

export function SwitchSettingRow({ label, description, checked, disabled, onCheckedChange }: SwitchSettingRowProps) {
  return (
    <SettingsRow label={label} description={description}>
      <Switch aria-label={label} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </SettingsRow>
  );
}

export type NumberSettingRowProps = {
  label: string;
  description?: ReactNode;
  value: number;
  min: number;
  max: number;
  unit?: string;
  /** Extra hint rendered under the input for the *draft* value, e.g. "= 15 min". */
  hint?: (value: number) => ReactNode;
  disabled?: boolean;
  onSave: (value: number) => void;
};

/**
 * Integer input with its own Save button. The parent remounts it (via `key`) when the
 * stored value changes, so the draft always starts from the server's value.
 */
export function NumberSettingRow({
  label,
  description,
  value,
  min,
  max,
  unit,
  hint,
  disabled,
  onSave,
}: NumberSettingRowProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(String(value));
  const trimmed = draft.trim();
  const parsed = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN;
  const valid = Number.isInteger(parsed) && parsed >= min && parsed <= max;
  const changed = valid && parsed !== value;

  const save = () => {
    if (changed && !disabled) {
      onSave(parsed);
    }
  };

  return (
    <div className="space-y-1.5 p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Input
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            step={1}
            value={draft}
            disabled={disabled}
            aria-label={label}
            aria-invalid={!valid}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                save();
              }
            }}
            className="h-8 w-24 text-xs"
          />
          {unit ? <span className="text-xs text-muted-foreground">{unit}</span> : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            disabled={disabled || !changed}
            onClick={save}
          >
            {t("common.actions.save")}
          </Button>
        </div>
      </div>
      {!valid ? (
        <p className="text-right text-xs text-destructive">{t("settings.validation.range", { min, max })}</p>
      ) : hint ? (
        <p className="text-right text-xs text-muted-foreground">{hint(parsed)}</p>
      ) : null}
    </div>
  );
}

