import { Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useModels } from "@/features/api-keys/hooks/use-models";
import { metricLabel, ruleProblem, windowLabel, WINDOW_PRESET_SECONDS } from "@/features/api-keys/lib";
import {
  LIMIT_METRICS,
  LIMIT_WINDOWS,
  type LimitMetric,
  type LimitRuleInput,
  type LimitWindow,
} from "@/features/api-keys/schemas";

export type LimitRuleCardProps = {
  rule: LimitRuleInput;
  index: number;
  onChange: (rule: LimitRuleInput) => void;
  onRemove: () => void;
};

function toNumber(raw: string): number {
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : 0;
}

export function LimitRuleCard({ rule, index, onChange, onRemove }: LimitRuleCardProps) {
  const { t } = useTranslation();
  const id = useId();
  const { data: models = [] } = useModels();
  const isCost = rule.metric === "cost_usd";
  // Text state so "0." or an empty box can be typed without being normalised away.
  const [amountText, setAmountText] = useState(() => (rule.maxValue > 0 ? String(rule.maxValue) : ""));
  const [hoursText, setHoursText] = useState(() =>
    rule.windowSeconds ? String(Math.round((rule.windowSeconds / 3600) * 100) / 100) : "",
  );
  const problem = ruleProblem(rule);

  return (
    <fieldset className="space-y-2 rounded-lg border p-3" data-testid="limit-rule-card">
      <div className="flex items-center justify-between">
        <legend className="text-xs font-medium text-muted-foreground">
          {t("apiKeys.limitRule.title", { index: index + 1 })}
        </legend>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onRemove}
          aria-label={t("apiKeys.limitRule.remove", { index: index + 1 })}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label htmlFor={`${id}-metric`} className="text-xs text-muted-foreground">
            {t("apiKeys.limitRule.metric")}
          </label>
          <Select value={rule.metric} onValueChange={(metric) => onChange({ ...rule, metric: metric as LimitMetric })}>
            <SelectTrigger id={`${id}-metric`} size="sm" className="w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LIMIT_METRICS.map((metric) => (
                <SelectItem key={metric} value={metric}>
                  {metricLabel(t, metric)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-window`} className="text-xs text-muted-foreground">
            {t("apiKeys.limitRule.window")}
          </label>
          <Select
            value={rule.window}
            onValueChange={(value) => {
              const window = value as LimitWindow;
              const windowSeconds =
                window === "custom" ? (rule.windowSeconds ?? 3600) : WINDOW_PRESET_SECONDS[window];
              if (window === "custom") setHoursText(String(Math.round((windowSeconds / 3600) * 100) / 100));
              onChange({ ...rule, window, windowSeconds: window === "custom" ? windowSeconds : null });
            }}
          >
            <SelectTrigger id={`${id}-window`} size="sm" className="w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LIMIT_WINDOWS.map((window) => (
                <SelectItem key={window} value={window}>
                  {window === "custom"
                    ? t("apiKeys.windows.custom")
                    : windowLabel(t, window, WINDOW_PRESET_SECONDS[window])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label htmlFor={`${id}-amount`} className="text-xs text-muted-foreground">
            {isCost ? t("apiKeys.limitRule.amountUsd") : t("apiKeys.limitRule.amount")}
          </label>
          <Input
            id={`${id}-amount`}
            name={`limit-${index}-amount`}
            type="number"
            inputMode="decimal"
            min={isCost ? 0.01 : 1}
            step={isCost ? 0.01 : 1}
            value={amountText}
            aria-invalid={problem === "amount" && amountText !== ""}
            onChange={(event) => {
              setAmountText(event.target.value);
              onChange({ ...rule, maxValue: toNumber(event.target.value) });
            }}
            className="h-8 text-xs"
          />
        </div>
        {rule.window === "custom" ? (
          <div className="space-y-1">
            <label htmlFor={`${id}-hours`} className="text-xs text-muted-foreground">
              {t("apiKeys.limitRule.customHours")}
            </label>
            <Input
              id={`${id}-hours`}
              name={`limit-${index}-hours`}
              type="number"
              inputMode="decimal"
              min={0.02}
              step={0.5}
              value={hoursText}
              aria-invalid={problem === "window"}
              onChange={(event) => {
                setHoursText(event.target.value);
                onChange({ ...rule, windowSeconds: Math.round(toNumber(event.target.value) * 3600) });
              }}
              className="h-8 text-xs"
            />
          </div>
        ) : null}
      </div>

      <div className="space-y-1">
        <label htmlFor={`${id}-model`} className="text-xs text-muted-foreground">
          {t("apiKeys.limitRule.modelFilter")}
        </label>
        <ModelFilterInput
          id={`${id}-model`}
          name={`limit-${index}-model`}
          value={rule.modelFilter ?? ""}
          models={models}
          onChange={(modelFilter) => onChange({ ...rule, modelFilter: modelFilter || null })}
        />
      </div>

      {problem === "window" ? (
        <p className="text-xs text-destructive">{t("apiKeys.limitRule.windowProblem")}</p>
      ) : null}
    </fieldset>
  );
}

function ModelFilterInput({
  id,
  name,
  value,
  models,
  onChange,
}: {
  id: string;
  name: string;
  value: string;
  models: string[];
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Input
        id={id}
        name={name}
        list={`${id}-options`}
        value={value}
        placeholder={t("apiKeys.limitRule.allModels")}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        className="h-8 font-mono text-xs"
      />
      <datalist id={`${id}-options`}>
        {models.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
    </>
  );
}
