import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, Lock } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { AlertMessage } from "@/components/alert-message";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { TotpCodeInput } from "@/features/auth/components/totp-code-input";
import { LoginRequestSchema, TotpCodeSchema } from "@/features/auth/schemas";
import { useAuthStore } from "@/features/auth/hooks/use-auth";

type Step = "password" | "totp";

/**
 * Two-step sign-in. claude-lb checks password and TOTP in one request
 * (`POST /api/auth/login {password, totp_code}`) and deliberately does not say
 * which factor failed, so the TOTP step only collects the code; the request is
 * sent once both are known.
 */
export function LoginForm() {
  const { t } = useTranslation();
  const login = useAuthStore((state) => state.login);
  const loading = useAuthStore((state) => state.loading);
  const rawError = useAuthStore((state) => state.error);
  // Store errors are either server messages or i18n keys; `t` passes unknown text through.
  const error = rawError ? t(rawError) : null;
  const clearError = useAuthStore((state) => state.clearError);
  const totpEnabled = useAuthStore((state) => state.totpEnabled);
  const [step, setStep] = useState<Step>("password");
  const [password, setPassword] = useState("");

  const passwordForm = useForm({
    resolver: zodResolver(LoginRequestSchema),
    defaultValues: { password: "" },
  });
  const totpForm = useForm({
    resolver: zodResolver(TotpCodeSchema),
    defaultValues: { code: "" },
  });

  const submitPassword = async (values: { password: string }) => {
    clearError();
    if (totpEnabled) {
      setPassword(values.password);
      setStep("totp");
      return;
    }
    await login(values.password).catch(() => undefined);
  };

  const submitTotp = async (values: { code: string }) => {
    clearError();
    try {
      await login(password, values.code);
    } catch {
      totpForm.reset();
    }
  };

  const backToPassword = () => {
    clearError();
    totpForm.reset();
    setPassword("");
    setStep("password");
  };

  return (
    <div className="rounded-2xl border bg-card p-6 shadow-[var(--shadow-md)]">
      {step === "password" ? (
        <Form {...passwordForm}>
          <form onSubmit={passwordForm.handleSubmit(submitPassword)}>
            <div className="space-y-1.5">
              <h2 className="text-base font-semibold tracking-tight">{t("auth.login.heading")}</h2>
              <p className="text-sm text-muted-foreground">{t("auth.login.subheading")}</p>
            </div>

            <div className="mt-5">
              <FormField
                control={passwordForm.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs font-medium">{t("auth.login.passwordLabel")}</FormLabel>
                    <div className="relative">
                      <Lock
                        className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground/60"
                        aria-hidden="true"
                      />
                      <FormControl>
                        <Input
                          {...field}
                          type="password"
                          autoComplete="current-password"
                          autoFocus
                          placeholder={t("auth.login.passwordPlaceholder")}
                          disabled={loading}
                          className="pl-9"
                        />
                      </FormControl>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {error ? (
              <AlertMessage variant="error" className="mt-4">
                {error}
              </AlertMessage>
            ) : null}

            <Button type="submit" className="press-scale mt-5 w-full" disabled={loading}>
              {loading ? <Spinner size="sm" className="mr-2" /> : null}
              {totpEnabled ? t("auth.login.next") : t("auth.login.submit")}
            </Button>
          </form>
        </Form>
      ) : (
        <Form {...totpForm}>
          <form onSubmit={totpForm.handleSubmit(submitTotp)} className="space-y-5">
            <div className="space-y-1.5">
              <h2 className="text-base font-semibold tracking-tight">{t("auth.totp.title")}</h2>
              <p className="text-sm text-muted-foreground">{t("auth.totp.description")}</p>
            </div>
            <FormField
              control={totpForm.control}
              name="code"
              render={({ field }) => (
                <FormItem className="flex flex-col items-center gap-2">
                  <FormLabel className="sr-only">{t("auth.totp.codeLabel")}</FormLabel>
                  <FormControl>
                    <TotpCodeInput
                      autoFocus
                      value={field.value}
                      onChange={field.onChange}
                      disabled={loading}
                      onComplete={() => void totpForm.handleSubmit(submitTotp)()}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {error ? <AlertMessage variant="error">{error}</AlertMessage> : null}

            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={backToPassword} disabled={loading}>
                <ArrowLeft className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                {t("common.back")}
              </Button>
              <Button type="submit" className="press-scale flex-1" disabled={loading}>
                {loading ? <Spinner size="sm" className="mr-2" /> : null}
                {t("auth.totp.submit")}
              </Button>
            </div>
          </form>
        </Form>
      )}
    </div>
  );
}
