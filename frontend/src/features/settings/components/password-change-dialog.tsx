import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { AlertMessage } from "@/components/alert-message";
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
import { Input } from "@/components/ui/input";
import { setPassword } from "@/features/auth/api";
import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { PasswordChangeFormSchema, type PasswordChangeForm } from "@/features/auth/schemas";
import { getErrorMessage } from "@/utils/errors";

export type PasswordChangeDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Rotation: `POST /api/auth/password {password, current_password}`. The server ends
 * every other session and hands this browser a fresh cookie.
 */
export function PasswordChangeDialog({ open, onOpenChange }: PasswordChangeDialogProps) {
  const { t } = useTranslation();
  const refreshSession = useAuthStore((s) => s.refreshSession);

  const form = useForm<PasswordChangeForm>({
    resolver: zodResolver(PasswordChangeFormSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });
  const busy = form.formState.isSubmitting;

  useEffect(() => {
    if (!open) {
      form.reset();
    }
  }, [open, form]);

  const handleSubmit = async (values: PasswordChangeForm) => {
    form.clearErrors("root");
    try {
      await setPassword({ password: values.newPassword, currentPassword: values.currentPassword });
      await refreshSession();
      toast.success(t("settings.password.toasts.changed"));
      onOpenChange(false);
    } catch (caught) {
      form.setError("root", { message: getErrorMessage(caught) });
    }
  };

  const rootError = form.formState.errors.root?.message;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("settings.password.changeDialog.title")}</DialogTitle>
          <DialogDescription>{t("settings.password.changeDialog.description")}</DialogDescription>
        </DialogHeader>
        {rootError ? <AlertMessage variant="error">{rootError}</AlertMessage> : null}
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="currentPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("settings.password.changeDialog.currentLabel")}</FormLabel>
                  <FormControl>
                    <Input {...field} type="password" autoComplete="current-password" autoFocus />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="newPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("settings.password.changeDialog.newLabel")}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="password"
                      autoComplete="new-password"
                      placeholder={t("settings.password.setupDialog.passwordPlaceholder")}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="confirmPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("settings.password.setupDialog.confirmLabel")}</FormLabel>
                  <FormControl>
                    <Input {...field} type="password" autoComplete="new-password" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {t("settings.password.changeDialog.submit")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
