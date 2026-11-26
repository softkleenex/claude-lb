import { useEffect } from "react";
import type { PropsWithChildren } from "react";
import { useTranslation } from "react-i18next";

import { AlertMessage } from "@/components/alert-message";
import { Button } from "@/components/ui/button";
import { SpinnerBlock } from "@/components/ui/spinner";
import { AuthScreenLayout } from "@/features/auth/components/auth-screen-layout";
import { BootstrapSetupScreen } from "@/features/auth/components/bootstrap-setup-screen";
import { GuestLogin } from "@/features/auth/components/guest-login";
import { LoginForm } from "@/features/auth/components/login-form";
import { useAuthStore } from "@/features/auth/hooks/use-auth";

/**
 * Renders the app only once `/api/auth/status` says this browser may use the
 * management plane. States:
 *
 * - remote visitor, no password yet → first-time setup (needs the bootstrap token)
 * - password set, not signed in → sign-in (password, then a TOTP step when enabled),
 *   plus "continue as guest" (read-only) when guest access is on
 * - signed in, or loopback with no password (the app shows an insecure-mode banner)
 */
export function AuthGate({ children }: PropsWithChildren) {
  const { t } = useTranslation();
  const refreshSession = useAuthStore((state) => state.refreshSession);
  const initialized = useAuthStore((state) => state.initialized);
  const loading = useAuthStore((state) => state.loading);
  const authenticated = useAuthStore((state) => state.authenticated);
  const passwordRequired = useAuthStore((state) => state.passwordRequired);
  const bootstrapRequired = useAuthStore((state) => state.bootstrapRequired);
  const guestAccessEnabled = useAuthStore((state) => state.guestAccessEnabled);
  const error = useAuthStore((state) => state.error);

  useEffect(() => {
    void refreshSession().catch(() => undefined);
  }, [refreshSession]);

  if (!initialized) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <SpinnerBlock />
      </div>
    );
  }

  if (authenticated) {
    return <>{children}</>;
  }

  if (bootstrapRequired) {
    return <BootstrapSetupScreen />;
  }

  if (passwordRequired) {
    return (
      <AuthScreenLayout title={t("auth.appTitle")} subtitle={t("auth.appSubtitle")}>
        <LoginForm />
        {guestAccessEnabled ? <GuestLogin /> : null}
      </AuthScreenLayout>
    );
  }

  // The status request itself failed (server down, network error).
  return (
    <AuthScreenLayout title={t("auth.appTitle")} subtitle={t("auth.unavailable.subtitle")}>
      <div className="space-y-4 rounded-2xl border bg-card p-6 shadow-[var(--shadow-md)]">
        <AlertMessage variant="error">{error ?? t("auth.unavailable.body")}</AlertMessage>
        <Button
          type="button"
          className="w-full"
          disabled={loading}
          onClick={() => void refreshSession().catch(() => undefined)}
        >
          {t("auth.unavailable.retry")}
        </Button>
      </div>
    </AuthScreenLayout>
  );
}
