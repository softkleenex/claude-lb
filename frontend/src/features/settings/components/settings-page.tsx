import { Settings } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AlertMessage } from "@/components/alert-message";
import { LoadingOverlay } from "@/components/layout/loading-overlay";
import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { AppearanceSettings } from "@/features/settings/components/appearance-settings";
import { BackgroundJobSettings, DataRetentionSettings } from "@/features/settings/components/maintenance-settings";
import { PasswordSettings } from "@/features/settings/components/password-settings";
import { ResetSettings } from "@/features/settings/components/reset-settings";
import { RoutingSettings } from "@/features/settings/components/routing-settings";
import { SettingsSkeleton } from "@/features/settings/components/settings-skeleton";
import { TotpSettings } from "@/features/settings/components/totp-settings";
import { useSettings } from "@/features/settings/hooks/use-settings";
import type { SettingsPatch } from "@/features/settings/schemas";
import { getErrorMessageOrNull } from "@/utils/errors";

// Not rendered until their backends exist (Step G): firewall, sticky-session browser,
// guest access. codex-only cards (warm-up, reset credits, transport, quota planner,
// upstream proxy, telemetry, session TTL) were removed for good.

export function SettingsPage() {
  const { t } = useTranslation();
  const { settingsQuery, updateSettingsMutation, resetSettingsMutation } = useSettings();
  const canWrite = useAuthStore((state) => state.canWrite);
  const passwordRequired = useAuthStore((state) => state.passwordRequired);
  const authEnabled = useAuthStore((state) => state.authEnabled);

  const envelope = settingsQuery.data;
  const busy = updateSettingsMutation.isPending || resetSettingsMutation.isPending;
  const controlsDisabled = busy || !canWrite;
  const loadError = getErrorMessageOrNull(settingsQuery.error);

  const save = (changes: SettingsPatch) => {
    updateSettingsMutation.mutate(changes);
  };

  return (
    <div className="animate-fade-in-up space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Settings className="h-5 w-5 text-primary" />
          {t("settings.page.title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("settings.page.subtitle")}</p>
      </div>

      {!canWrite ? (
        <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs font-medium text-foreground">
          {t("settings.page.readOnlyNotice")}
        </div>
      ) : null}

      <div className="space-y-4">
        <AppearanceSettings />

        {loadError && !envelope ? <AlertMessage variant="error">{loadError}</AlertMessage> : null}
        {!envelope ? (
          loadError ? null : <SettingsSkeleton />
        ) : (
          <>
            <RoutingSettings
              settings={envelope.settings}
              availableStrategies={envelope.availableStrategies}
              disabled={controlsDisabled}
              onSave={save}
            />
            <BackgroundJobSettings settings={envelope.settings} disabled={controlsDisabled} onSave={save} />
            <DataRetentionSettings settings={envelope.settings} disabled={controlsDisabled} onSave={save} />
          </>
        )}

        {canWrite ? <PasswordSettings disabled={busy} /> : null}
        {canWrite && authEnabled && passwordRequired ? <TotpSettings disabled={busy} /> : null}

        {envelope && canWrite ? (
          <ResetSettings disabled={controlsDisabled} onReset={() => resetSettingsMutation.mutate()} />
        ) : null}
      </div>

      <LoadingOverlay visible={!!envelope && busy} label={t("settings.page.savingLabel")} />
    </div>
  );
}
