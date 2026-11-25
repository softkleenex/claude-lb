import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { AlertMessage } from "@/components/alert-message";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { getGuestConfig, updateGuestConfig } from "@/features/auth/api";
import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { MIN_DASHBOARD_PASSWORD_LENGTH, type GuestConfigPatch } from "@/features/auth/schemas";
import { SettingsCard, SettingsRow } from "@/features/settings/components/settings-card";

const GUEST_QUERY_KEY = ["auth", "guest"] as const;

type Confirm = { kind: "enable" } | { kind: "disable" } | { kind: "clear" } | { kind: "password"; password: string };

/**
 * Read-only guest sign-in: anyone with the dashboard URL (and the guest password, if
 * one is set) can view every page but change nothing. Needs a dashboard password.
 */
export function GuestAccessSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const passwordRequired = useAuthStore((state) => state.passwordRequired);
  const refreshSession = useAuthStore((state) => state.refreshSession);
  const [draft, setDraft] = useState("");
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const configQuery = useQuery({ queryKey: GUEST_QUERY_KEY, queryFn: getGuestConfig });
  const mutation = useMutation({
    mutationFn: (changes: GuestConfigPatch) => updateGuestConfig(changes),
    onSuccess: (config, changes) => {
      queryClient.setQueryData(GUEST_QUERY_KEY, config);
      toast.success(
        changes.enabled === true
          ? t("settings.guest.toast.enabled")
          : changes.enabled === false
            ? t("settings.guest.toast.disabled")
            : changes.clearPassword
              ? t("settings.guest.toast.passwordCleared")
              : t("settings.guest.toast.passwordSet"),
      );
      setDraft("");
      void refreshSession().catch(() => undefined);
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const config = configQuery.data;
  const busy = mutation.isPending;
  const draftValid = draft.length >= MIN_DASHBOARD_PASSWORD_LENGTH;

  const onConfirm = () => {
    if (!confirm) return;
    const current = confirm;
    setConfirm(null);
    if (current.kind === "enable") mutation.mutate({ enabled: true });
    else if (current.kind === "disable") mutation.mutate({ enabled: false });
    else if (current.kind === "clear") mutation.mutate({ clearPassword: true });
    else mutation.mutate({ password: current.password });
  };

  const dialog: Record<Confirm["kind"], { title: string; body: string; label: string }> = {
    enable: {
      title: t("settings.guest.confirm.enableTitle"),
      body: config?.passwordSet ? t("settings.guest.confirm.enableBodyPassword") : t("settings.guest.confirm.enableBodyOpen"),
      label: t("settings.guest.confirm.enable"),
    },
    disable: {
      title: t("settings.guest.confirm.disableTitle"),
      body: t("settings.guest.confirm.disableBody"),
      label: t("settings.guest.confirm.disable"),
    },
    clear: {
      title: t("settings.guest.confirm.clearTitle"),
      body: config?.enabled ? t("settings.guest.confirm.clearBodyEnabled") : t("settings.guest.confirm.clearBody"),
      label: t("settings.guest.confirm.clear"),
    },
    password: {
      title: t("settings.guest.confirm.passwordTitle"),
      body: t("settings.guest.confirm.passwordBody"),
      label: t("settings.guest.confirm.password"),
    },
  };

  return (
    <SettingsCard id="guest-access" icon={Eye} title={t("settings.guest.title")} description={t("settings.guest.description")}>
      {!passwordRequired ? (
        <AlertMessage variant="warning">{t("settings.guest.needsPassword")}</AlertMessage>
      ) : null}
      <div className="divide-y rounded-lg border">
        <SettingsRow label={t("settings.guest.enabledLabel")} description={t("settings.guest.enabledHelp")}>
          <Switch
            aria-label={t("settings.guest.enabledLabel")}
            checked={config?.enabled ?? false}
            disabled={busy || !config || (!passwordRequired && !config.enabled)}
            onCheckedChange={(checked) => setConfirm({ kind: checked ? "enable" : "disable" })}
          />
        </SettingsRow>
        <div className="space-y-2 p-3">
          <div>
            <p className="text-sm font-medium">{t("settings.guest.passwordLabel")}</p>
            <p className="text-xs text-muted-foreground">
              {config?.passwordSet ? t("settings.guest.passwordSet") : t("settings.guest.passwordNone")}
            </p>
          </div>
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (draftValid) setConfirm({ kind: "password", password: draft });
            }}
          >
            <Input
              id="guest-password-setting"
              name="guest-password-setting"
              type="password"
              autoComplete="new-password"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t("settings.guest.passwordPlaceholder", { min: MIN_DASHBOARD_PASSWORD_LENGTH })}
              aria-label={t("settings.guest.passwordLabel")}
              className="h-8 text-xs sm:max-w-xs"
              disabled={busy || !passwordRequired}
            />
            <Button type="submit" size="sm" className="h-8 text-xs" disabled={busy || !draftValid}>
              {config?.passwordSet ? t("settings.guest.changePassword") : t("settings.guest.setPassword")}
            </Button>
            {config?.passwordSet ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                disabled={busy}
                onClick={() => setConfirm({ kind: "clear" })}
              >
                {t("settings.guest.clearPassword")}
              </Button>
            ) : null}
          </form>
          {draft && !draftValid ? (
            <p className="text-xs text-destructive">
              {t("settings.guest.passwordTooShort", { min: MIN_DASHBOARD_PASSWORD_LENGTH })}
            </p>
          ) : null}
        </div>
      </div>
      <ConfirmDialog
        open={confirm !== null}
        title={confirm ? dialog[confirm.kind].title : ""}
        description={confirm ? dialog[confirm.kind].body : ""}
        confirmLabel={confirm ? dialog[confirm.kind].label : undefined}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        onConfirm={onConfirm}
      />
    </SettingsCard>
  );
}
