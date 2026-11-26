import { useState } from "react";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { LimitRuleCard } from "@/features/api-keys/components/limit-rule-card";
import type { LimitRuleInput } from "@/features/api-keys/schemas";

export type LimitRulesEditorProps = {
  rules: LimitRuleInput[];
  onChange: (rules: LimitRuleInput[]) => void;
};

const MAX_RULES = 20;

function newRule(): LimitRuleInput {
  return { metric: "cost_usd", window: "daily", maxValue: 0, windowSeconds: null, modelFilter: null };
}

export function LimitRulesEditor({ rules, onChange }: LimitRulesEditorProps) {
  const { t } = useTranslation();
  // Stable React keys, so removing a card does not hand its text state to the next one.
  const [keys, setKeys] = useState(() => rules.map((_, index) => index));
  const [nextKey, setNextKey] = useState(rules.length);

  const add = () => {
    setKeys([...keys, nextKey]);
    setNextKey(nextKey + 1);
    onChange([...rules, newRule()]);
  };

  const remove = (index: number) => {
    setKeys(keys.filter((_, i) => i !== index));
    onChange(rules.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-2">
      {rules.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
          {t("apiKeys.limitRules.none")}
        </p>
      ) : (
        rules.map((rule, index) => (
          <LimitRuleCard
            key={keys[index] ?? `rule-${index}`}
            rule={rule}
            index={index}
            onChange={(updated) => onChange(rules.map((current, i) => (i === index ? updated : current)))}
            onRemove={() => remove(index)}
          />
        ))
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        onClick={add}
        disabled={rules.length >= MAX_RULES}
      >
        <Plus className="mr-1 size-3.5" />
        {t("apiKeys.limitRules.add")}
      </Button>
      <p className="text-xs text-muted-foreground">{t("apiKeys.limitRules.hint")}</p>
    </div>
  );
}
