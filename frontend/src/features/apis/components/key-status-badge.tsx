import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import type { ApiKey } from "@/features/api-keys/schemas";
import { cn } from "@/lib/utils";

const TONE: Record<ApiKey["status"], string> = {
  active: "bg-emerald-500 text-white",
  disabled: "bg-zinc-500 text-white",
  expired: "bg-red-500/90 text-white",
};

export function KeyStatusBadge({ status }: { status: ApiKey["status"] }) {
  const { t } = useTranslation();
  return (
    <Badge className={cn("shrink-0", TONE[status])} data-testid="key-status-badge">
      {t(`apiKeys.status.${status}`)}
    </Badge>
  );
}
