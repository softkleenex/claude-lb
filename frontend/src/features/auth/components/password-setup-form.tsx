import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { AlertMessage } from "@/components/alert-message";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { PasswordSetupFormSchema, type PasswordSetupForm as PasswordSetupValues } from "@/features/auth/schemas";
import { getErrorMessage } from "@/utils/errors";

export type PasswordSetupFormProps = {
  /** Remote first-time setup: ask for the one-time token printed in the server log. */
  requireBootstrapToken?: boolean;
  onDone?: () => void;
  onCancel?: () => void;
};

/** First-time password form (`POST /api/auth/password` without `current_password`). */
export function PasswordSetupForm({ requireBootstrapToken = false, onDone, onCancel }: PasswordSetupFormProps) {
  const { t } = useTranslation();
  const setupPassword = useAuthStore((state) => state.setupPassword);

  const form = useForm<PasswordSetupValues>({
    resolver: zodResolver(PasswordSetupFormSchema),
    defaultValues: { password: "", confirmPassword: "", bootstrapToken: "" },
  });
  const busy = form.formState.isSubmitting;

  const handleSubmit = async (values: PasswordSetupValues) => {
    form.clearErrors("root");
    const token = values.bootstrapToken?.trim();
    if (requireBootstrapToken && !token) {
      form.setError("bootstrapToken", { message: "auth.bootstrap.tokenRequired" });
      return;
    }
    try {
      await setupPassword(values.password, token || undefined);
      onDone?.();
    } catch (caught) {
      form.setError("root", { message: getErrorMessage(caught) });
    }
  };

  const rootError = form.formState.errors.root?.message;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("settings.password.setupDialog.passwordLabel")}</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  type="password"
                  autoComplete="new-password"
                  autoFocus
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
        {requireBootstrapToken ? (
          <FormField
            control={form.control}
            name="bootstrapToken"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("settings.password.setupDialog.bootstrapTokenLabel")}</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t("settings.password.setupDialog.bootstrapTokenPlaceholder")}
                  />
                </FormControl>
                <FormDescription>{t("settings.password.setupDialog.bootstrapTokenHelp")}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        ) : null}

        {rootError ? <AlertMessage variant="error">{rootError}</AlertMessage> : null}

        <div className="flex justify-end gap-2">
          {onCancel ? (
            <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
              {t("common.cancel")}
            </Button>
          ) : null}
          <Button type="submit" className={onCancel ? "" : "w-full"} disabled={busy}>
            {busy ? <Spinner size="sm" className="mr-2" /> : null}
            {t("settings.password.setupDialog.submit")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
