import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PasswordSetupForm } from "@/features/auth/components/password-setup-form";

export type PasswordSetupDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** First-time password from inside the app (loopback, where no bootstrap token is needed). */
export function PasswordSetupDialog({ open, onOpenChange }: PasswordSetupDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("settings.password.setupDialog.title")}</DialogTitle>
          <DialogDescription>{t("settings.password.setupDialog.description")}</DialogDescription>
        </DialogHeader>
        {open ? (
          <PasswordSetupForm
            onCancel={() => onOpenChange(false)}
            onDone={() => {
              toast.success(t("settings.password.toasts.configured"));
              onOpenChange(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
