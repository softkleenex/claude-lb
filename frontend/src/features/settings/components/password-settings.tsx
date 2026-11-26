import { KeyRound, LogOut } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { revokeAllSessions } from "@/features/auth/api";
import { PasswordSetupDialog } from "@/features/auth/components/password-setup-dialog";
import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { PasswordChangeDialog } from "@/features/settings/components/password-change-dialog";
import { SettingsCard, SettingsRow } from "@/features/settings/components/settings-card";
import { getErrorMessage } from "@/utils/errors";

type ActiveDialog = "setup" | "change" | "revoke" | null;

export type PasswordSettingsProps = {
  disabled?: boolean;
};

export function PasswordSettings({ disabled = false }: PasswordSettingsProps) {
  const { t } = useTranslation();
  const passwordRequired = useAuthStore((s) => s.passwordRequired);
  const authEnabled = useAuthStore((s) => s.authEnabled);
  const refreshSession = useAuthStore((s) => s.refreshSession);
  const [activeDialog, setActiveDialog] = useState<ActiveDialog>(null);
  const [revoking, setRevoking] = useState(false);

  const closeIfMatches = (dialog: ActiveDialog) => (open: boolean) => {
    if (!open && activeDialog === dialog) {
      setActiveDialog(null);
    }
  };

  const revokeAll = async () => {
    setRevoking(true);
    try {
      await revokeAllSessions();
      toast.success(t("settings.sessions.toasts.revoked"));
      // This browser's session is gone too; the gate takes over from here.
      await refreshSession();
    } catch (caught) {
      toast.error(getErrorMessage(caught));
    } finally {
      setRevoking(false);
      setActiveDialog(null);
    }
  };

  const statusMessage = !authEnabled
    ? t("settings.password.status.authDisabled")
    : passwordRequired
      ? t("settings.password.status.configured")
      : t("settings.password.status.notSet");

  return (
    <SettingsCard
      id="password"
      icon={KeyRound}
      title={t("settings.password.title")}
      description={statusMessage}
      actions={
        !authEnabled ? null : passwordRequired ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            disabled={disabled}
            onClick={() => setActiveDialog("change")}
          >
            {t("settings.password.actions.change")}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            className="h-8 text-xs"
            disabled={disabled}
            onClick={() => setActiveDialog("setup")}
          >
            {t("settings.password.actions.set")}
          </Button>
        )
      }
    >
      {passwordRequired ? (
        <div className="rounded-lg border">
          <SettingsRow label={t("settings.sessions.revokeAll.label")} description={t("settings.sessions.revokeAll.description")}>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs text-destructive hover:text-destructive"
              disabled={disabled || revoking}
              onClick={() => setActiveDialog("revoke")}
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
              {t("settings.sessions.revokeAll.action")}
            </Button>
          </SettingsRow>
        </div>
      ) : null}

      <PasswordSetupDialog open={activeDialog === "setup"} onOpenChange={closeIfMatches("setup")} />
      <PasswordChangeDialog open={activeDialog === "change"} onOpenChange={closeIfMatches("change")} />
      <AlertDialog open={activeDialog === "revoke"} onOpenChange={closeIfMatches("revoke")}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.sessions.revokeAll.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("settings.sessions.revokeAll.confirmDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={revoking}
              onClick={(event) => {
                event.preventDefault();
                void revokeAll();
              }}
            >
              {t("settings.sessions.revokeAll.action")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  );
}
