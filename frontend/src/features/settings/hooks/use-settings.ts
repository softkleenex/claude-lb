import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { getSettings, resetSettings, updateSettings } from "@/features/settings/api";
import type { SettingsEnvelope, SettingsPatch } from "@/features/settings/schemas";

export const SETTINGS_QUERY_KEY = ["settings", "detail"] as const;

export function useSettingsQuery() {
  return useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: getSettings,
  });
}

export function useSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const settingsQuery = useSettingsQuery();

  const storeResult = (envelope: SettingsEnvelope) => {
    queryClient.setQueryData(SETTINGS_QUERY_KEY, envelope);
  };

  const updateSettingsMutation = useMutation({
    mutationFn: (changes: SettingsPatch) => updateSettings(changes),
    onSuccess: (envelope) => {
      storeResult(envelope);
      toast.success(t("settings.toasts.saved"));
    },
    onError: (error: Error) => {
      toast.error(error.message || t("settings.toasts.saveFailed"));
      void queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
    },
  });

  const resetSettingsMutation = useMutation({
    mutationFn: resetSettings,
    onSuccess: (envelope) => {
      storeResult(envelope);
      toast.success(t("settings.reset.toasts.done"));
    },
    onError: (error: Error) => {
      toast.error(error.message || t("settings.toasts.saveFailed"));
    },
  });

  return {
    settingsQuery,
    updateSettingsMutation,
    resetSettingsMutation,
  };
}
