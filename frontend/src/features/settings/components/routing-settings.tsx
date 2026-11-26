import { Route } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { NumberSettingRow, SettingsCard, SettingsRow, SwitchSettingRow } from "@/features/settings/components/settings-card";
import { formatDurationSeconds } from "@/features/settings/duration";
import { routingStrategyLabelKey, routingStrategyGuideKey } from "@/features/settings/routing-labels";
import { SETTINGS_LIMITS, type RuntimeSettings, type SettingsPatch } from "@/features/settings/schemas";
import { cn } from "@/lib/utils";

export type RoutingSettingsProps = {
  settings: RuntimeSettings;
  availableStrategies: string[];
  disabled: boolean;
  onSave: (changes: SettingsPatch) => void;
};

export function RoutingSettings({ settings, availableStrategies, disabled, onSave }: RoutingSettingsProps) {
  const { t } = useTranslation();
  const strategies = availableStrategies.includes(settings.routingStrategy)
    ? availableStrategies
    : [settings.routingStrategy, ...availableStrategies];
  const strategyLabel = (strategy: string) => {
    const key = routingStrategyLabelKey(strategy);
    return key ? t(key) : strategy;
  };

  return (
    <SettingsCard
      id="routing"
      icon={Route}
      title={t("settings.routing.title")}
      description={t("settings.routing.description")}
    >
      <div className="divide-y rounded-lg border">
        <SettingsRow label={t("settings.routing.strategy.label")} description={t("settings.routing.strategy.description")}>
          <Select
            value={settings.routingStrategy}
            disabled={disabled}
            onValueChange={(value) => {
              if (value !== settings.routingStrategy) onSave({ routingStrategy: value });
            }}
          >
            <SelectTrigger aria-label={t("settings.routing.strategy.label")} className="h-8 w-56 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {strategies.map((strategy) => (
                <SelectItem key={strategy} value={strategy} className="text-xs">
                  {strategyLabel(strategy)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>

        <div className="space-y-2 p-3">
          <p className="text-xs font-medium text-muted-foreground">{t("settings.routing.strategy.guideTitle")}</p>
          <ul className="space-y-1.5" aria-label={t("settings.routing.strategy.guideTitle")}>
            {strategies.map((strategy) => {
              const guideKey = routingStrategyGuideKey(strategy);
              const active = strategy === settings.routingStrategy;
              return (
                <li
                  key={strategy}
                  data-active={active}
                  className={cn(
                    "rounded-md border px-3 py-2 text-xs",
                    active ? "border-primary/40 bg-primary/5" : "border-transparent bg-muted/30",
                  )}
                >
                  <span className="font-medium">{strategyLabel(strategy)}</span>
                  {active ? (
                    <span className="ml-2 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      {t("settings.routing.strategy.current")}
                    </span>
                  ) : null}
                  {guideKey ? <span className="mt-0.5 block text-muted-foreground">{t(guideKey)}</span> : null}
                </li>
              );
            })}
          </ul>
        </div>

        <NumberSettingRow
          key={`attempts:${settings.maxAttempts}`}
          label={t("settings.routing.maxAttempts.label")}
          description={t("settings.routing.maxAttempts.description")}
          value={settings.maxAttempts}
          {...SETTINGS_LIMITS.maxAttempts}
          unit={t("settings.routing.maxAttempts.unit")}
          disabled={disabled}
          onSave={(maxAttempts) => onSave({ maxAttempts })}
        />

        <SwitchSettingRow
          label={t("settings.routing.sticky.label")}
          description={t("settings.routing.sticky.description")}
          checked={settings.stickySessionsEnabled}
          disabled={disabled}
          onCheckedChange={(stickySessionsEnabled) => onSave({ stickySessionsEnabled })}
        />

        <NumberSettingRow
          key={`sticky-ttl:${settings.stickyTtlSeconds}`}
          label={t("settings.routing.stickyTtl.label")}
          description={t("settings.routing.stickyTtl.description")}
          value={settings.stickyTtlSeconds}
          {...SETTINGS_LIMITS.stickyTtlSeconds}
          unit={t("settings.duration.secondsUnit")}
          hint={(seconds) => formatDurationSeconds(seconds, t)}
          disabled={disabled || !settings.stickySessionsEnabled}
          onSave={(stickyTtlSeconds) => onSave({ stickyTtlSeconds })}
        />
      </div>
    </SettingsCard>
  );
}
