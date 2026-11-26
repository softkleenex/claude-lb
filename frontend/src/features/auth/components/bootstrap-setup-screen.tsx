import { useTranslation } from "react-i18next";

import { AuthScreenLayout } from "@/features/auth/components/auth-screen-layout";
import { PasswordSetupForm } from "@/features/auth/components/password-setup-form";

/**
 * Shown to a remote browser before any password exists. The server only lets a
 * non-loopback client set the first password when it presents the one-time
 * bootstrap token printed in the server log at startup.
 */
export function BootstrapSetupScreen() {
  const { t } = useTranslation();

  return (
    <AuthScreenLayout title={t("auth.bootstrap.title")} subtitle={t("auth.bootstrap.subtitle")} className="max-w-md">
      <div className="space-y-4 rounded-2xl border bg-card p-6 shadow-[var(--shadow-md)]">
        <p className="text-sm text-muted-foreground">{t("auth.bootstrap.body")}</p>
        <PasswordSetupForm requireBootstrapToken />
      </div>
    </AuthScreenLayout>
  );
}
