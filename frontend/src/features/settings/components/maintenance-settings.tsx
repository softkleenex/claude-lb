import { Activity, Database } from "lucide-react";
import { useTranslation } from "react-i18next";

import { NumberSettingRow, SettingsCard, SwitchSettingRow } from "@/features/settings/components/settings-card";
import { formatDurationSeconds } from "@/features/settings/duration";
import { SETTINGS_LIMITS, type RuntimeSettings, type SettingsPatch } from "@/features/settings/schemas";

export type MaintenanceSettingsProps = {
  settings: RuntimeSettings;
  disabled: boolean;
  onSave: (changes: SettingsPatch) => void;
};

/** Background jobs: account health probes and model-catalog sync. */
export function BackgroundJobSettings({ settings, disabled, onSave }: MaintenanceSettingsProps) {
  const { t } = useTranslation();
  const duration = (seconds: number) => formatDurationSeconds(seconds, t);

  return (
    <SettingsCard
      id="background-jobs"
      icon={Activity}
      title={t("settings.jobs.title")}
      description={t("settings.jobs.description")}
    >
      <div className="divide-y rounded-lg border">
        <SwitchSettingRow
          label={t("settings.jobs.healthProbe.label")}
          description={t("settings.jobs.healthProbe.description")}
          checked={settings.healthProbeEnabled}
          disabled={disabled}
          onCheckedChange={(healthProbeEnabled) => onSave({ healthProbeEnabled })}
        />
        <NumberSettingRow
          key={`probe:${settings.healthProbeIntervalSeconds}`}
          label={t("settings.jobs.healthProbeInterval.label")}
          value={settings.healthProbeIntervalSeconds}
          {...SETTINGS_LIMITS.healthProbeIntervalSeconds}
          unit={t("settings.duration.secondsUnit")}
          hint={duration}
          disabled={disabled || !settings.healthProbeEnabled}
          onSave={(healthProbeIntervalSeconds) => onSave({ healthProbeIntervalSeconds })}
        />
        <SwitchSettingRow
          label={t("settings.jobs.modelSync.label")}
          description={t("settings.jobs.modelSync.description")}
          checked={settings.modelSyncEnabled}
          disabled={disabled}
          onCheckedChange={(modelSyncEnabled) => onSave({ modelSyncEnabled })}
        />
        <NumberSettingRow
          key={`sync:${settings.modelSyncIntervalSeconds}`}
          label={t("settings.jobs.modelSyncInterval.label")}
          value={settings.modelSyncIntervalSeconds}
          {...SETTINGS_LIMITS.modelSyncIntervalSeconds}
          unit={t("settings.duration.secondsUnit")}
          hint={duration}
          disabled={disabled || !settings.modelSyncEnabled}
          onSave={(modelSyncIntervalSeconds) => onSave({ modelSyncIntervalSeconds })}
        />
      </div>
    </SettingsCard>
  );
}

export function DataRetentionSettings({ settings, disabled, onSave }: MaintenanceSettingsProps) {
  const { t } = useTranslation();

  return (
    <SettingsCard
      id="retention"
      icon={Database}
      title={t("settings.retention.title")}
      description={t("settings.retention.description")}
    >
      <div className="rounded-lg border">
        <NumberSettingRow
          key={`retention:${settings.requestLogRetentionDays}`}
          label={t("settings.retention.requestLogs.label")}
          description={t("settings.retention.requestLogs.description")}
          value={settings.requestLogRetentionDays}
          {...SETTINGS_LIMITS.requestLogRetentionDays}
          unit={t("settings.retention.daysUnit")}
          disabled={disabled}
          onSave={(requestLogRetentionDays) => onSave({ requestLogRetentionDays })}
        />
      </div>
    </SettingsCard>
  );
}
