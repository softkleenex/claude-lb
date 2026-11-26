import { zodResolver } from "@hookform/resolvers/zod";
import { Shield } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { AlertMessage } from "@/components/alert-message";
import { QrCode } from "@/components/qr-code";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { SpinnerBlock } from "@/components/ui/spinner";
import { confirmTotp, disableTotp, enrollTotp } from "@/features/auth/api";
import { TotpCodeInput } from "@/features/auth/components/totp-code-input";
import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { TotpCodeSchema, type TotpEnrollment } from "@/features/auth/schemas";
import { SettingsCard } from "@/features/settings/components/settings-card";
import { getErrorMessage } from "@/utils/errors";

type ActiveDialog = "setup" | "disable" | null;

export type TotpSettingsProps = {
  disabled?: boolean;
};

/**
 * TOTP second factor: `POST /api/auth/totp/enroll` returns a secret and an
 * `otpauth://` URI (rendered as a QR code here), `POST /api/auth/totp/confirm`
 * switches it on once a code matches, `DELETE /api/auth/totp` switches it off.
 */
export function TotpSettings({ disabled = false }: TotpSettingsProps) {
  const { t } = useTranslation();
  const totpEnabled = useAuthStore((state) => state.totpEnabled);
  const refreshSession = useAuthStore((state) => state.refreshSession);

  const [activeDialog, setActiveDialog] = useState<ActiveDialog>(null);
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmForm = useForm({
    resolver: zodResolver(TotpCodeSchema),
    defaultValues: { code: "" },
  });

  const closeDialog = () => {
    setActiveDialog(null);
    setError(null);
    setEnrollment(null);
    confirmForm.reset();
  };

  const openSetup = async () => {
    setActiveDialog("setup");
    setEnrolling(true);
    setError(null);
    try {
      setEnrollment(await enrollTotp());
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setEnrolling(false);
    }
  };

  const confirmSetup = async (values: { code: string }) => {
    setError(null);
    try {
      await confirmTotp(values.code);
      await refreshSession();
      toast.success(t("settings.totp.toasts.configured"));
      closeDialog();
    } catch (caught) {
      confirmForm.reset();
      setError(getErrorMessage(caught));
    }
  };

  const disable = async () => {
    setDisabling(true);
    try {
      await disableTotp();
      await refreshSession();
      toast.success(t("settings.totp.toasts.disabled"));
    } catch (caught) {
      toast.error(getErrorMessage(caught));
    } finally {
      setDisabling(false);
      setActiveDialog(null);
    }
  };

  return (
    <SettingsCard
      id="totp"
      icon={Shield}
      title={t("settings.totp.title")}
      description={totpEnabled ? t("settings.totp.status.configured") : t("settings.totp.status.notConfigured")}
      actions={
        totpEnabled ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 text-xs text-destructive hover:text-destructive"
            disabled={disabled || disabling}
            onClick={() => setActiveDialog("disable")}
          >
            {t("settings.totp.actions.disable")}
          </Button>
        ) : (
          <Button type="button" size="sm" className="h-8 text-xs" disabled={disabled} onClick={() => void openSetup()}>
            {t("settings.totp.actions.enable")}
          </Button>
        )
      }
    >
      <Dialog open={activeDialog === "setup"} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("settings.totp.setupDialog.title")}</DialogTitle>
            <DialogDescription>{t("settings.totp.setupDialog.description")}</DialogDescription>
          </DialogHeader>

          {enrolling ? <SpinnerBlock /> : null}
          {error ? <AlertMessage variant="error">{error}</AlertMessage> : null}

          {enrollment ? (
            <>
              <div className="flex justify-center">
                <QrCode
                  value={enrollment.provisioningUri}
                  label={t("settings.totp.setupDialog.qrAlt")}
                  className="rounded-lg border bg-white p-2"
                />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">{t("settings.totp.setupDialog.secretLabel")}</p>
                <p className="rounded-lg border bg-muted/30 px-3 py-2 font-mono text-xs break-all select-all">
                  {enrollment.secret}
                </p>
              </div>
              <Form {...confirmForm}>
                <form onSubmit={confirmForm.handleSubmit(confirmSetup)} className="space-y-4">
                  <FormField
                    control={confirmForm.control}
                    name="code"
                    render={({ field }) => (
                      <FormItem className="flex flex-col items-center gap-2">
                        <FormLabel>{t("settings.totp.setupDialog.codeLabel")}</FormLabel>
                        <FormControl>
                          <TotpCodeInput value={field.value} onChange={field.onChange} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={closeDialog}>
                      {t("common.cancel")}
                    </Button>
                    <Button type="submit" disabled={confirmForm.formState.isSubmitting}>
                      {t("settings.totp.setupDialog.submit")}
                    </Button>
                  </DialogFooter>
                </form>
              </Form>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog open={activeDialog === "disable"} onOpenChange={(open) => !open && setActiveDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.totp.disableDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("settings.totp.disableDialog.description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disabling}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={disabling}
              onClick={(event) => {
                event.preventDefault();
                void disable();
              }}
            >
              {t("settings.totp.disableDialog.submit")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  );
}
