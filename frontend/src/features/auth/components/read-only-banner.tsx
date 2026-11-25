import { Eye } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useAuthStore } from "@/features/auth/hooks/use-auth";

/** Shown on every page of a guest (read-only) session. */
export function ReadOnlyBanner() {
  const { t } = useTranslation();
  const role = useAuthStore((state) => state.role);
  const authenticated = useAuthStore((state) => state.authenticated);

  if (!authenticated || role !== "guest") {
    return null;
  }

  return (
    <div
      role="status"
      className="border-b border-sky-500/30 bg-sky-500/10 px-4 py-2 text-xs text-sky-900 dark:text-sky-100"
    >
      <div className="mx-auto flex w-full max-w-[1500px] items-center gap-3">
        <Eye className="h-4 w-4 shrink-0" aria-hidden="true" />
        <p className="min-w-0 flex-1 font-medium">{t("auth.guest.banner")}</p>
      </div>
    </div>
  );
}
