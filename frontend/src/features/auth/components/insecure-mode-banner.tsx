import { ShieldAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { PasswordSetupDialog } from "@/features/auth/components/password-setup-dialog";
import { useAuthStore } from "@/features/auth/hooks/use-auth";

/**
 * Warns that the management plane is reachable without a password: either nobody has
 * set one yet (loopback is trusted until then) or auth is switched off by config.
 */
export function InsecureModeBanner() {
  const { t } = useTranslation();
  const insecure = useAuthStore((state) => state.insecure);
  const authEnabled = useAuthStore((state) => state.authEnabled);
  const [setupOpen, setSetupOpen] = useState(false);

  if (!insecure) {
    return null;
  }

  return (
    <div
      role="alert"
      className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-800 dark:text-amber-200"
    >
      <div className="mx-auto flex w-full max-w-[1500px] flex-wrap items-center gap-x-3 gap-y-2">
        <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
        <p className="min-w-0 flex-1 font-medium">
          {authEnabled ? t("auth.insecure.noPassword") : t("auth.insecure.authDisabled")}
        </p>
        {authEnabled ? (
          <Button type="button" size="sm" className="h-7 text-xs" onClick={() => setSetupOpen(true)}>
            {t("settings.password.actions.set")}
          </Button>
        ) : null}
      </div>
      {authEnabled ? <PasswordSetupDialog open={setupOpen} onOpenChange={setSetupOpen} /> : null}
    </div>
  );
}
