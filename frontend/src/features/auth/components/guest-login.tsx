import { Eye } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useAuthStore } from "@/features/auth/hooks/use-auth";

/**
 * "Continue as guest" under the sign-in form, shown when guest access is on. A guest
 * session can read every page but change nothing (the backend refuses writes with 403).
 */
export function GuestLogin() {
  const { t } = useTranslation();
  const loginAsGuest = useAuthStore((state) => state.loginAsGuest);
  const loading = useAuthStore((state) => state.loading);
  const passwordRequired = useAuthStore((state) => state.guestPasswordRequired);
  const clearError = useAuthStore((state) => state.clearError);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");

  const submit = () => {
    clearError();
    void loginAsGuest(passwordRequired ? password : undefined).catch(() => setPassword(""));
  };

  return (
    <div className="mt-4 rounded-2xl border border-dashed bg-card/60 p-4">
      <div className="flex items-start gap-3">
        <Eye className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <p className="text-sm font-medium">{t("auth.guest.heading")}</p>
            <p className="text-xs text-muted-foreground">{t("auth.guest.description")}</p>
          </div>
          {passwordRequired && open ? (
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <Input
                id="guest-password"
                name="guest-password"
                type="password"
                autoComplete="off"
                autoFocus
                aria-label={t("auth.guest.passwordLabel")}
                placeholder={t("auth.guest.passwordLabel")}
                value={password}
                disabled={loading}
                onChange={(event) => setPassword(event.target.value)}
              />
              <Button type="submit" variant="secondary" disabled={loading || !password}>
                {loading ? <Spinner size="sm" className="mr-2" /> : null}
                {t("auth.guest.submit")}
              </Button>
            </form>
          ) : (
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              disabled={loading}
              onClick={() => (passwordRequired ? setOpen(true) : submit())}
            >
              {t("auth.guest.continue")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
