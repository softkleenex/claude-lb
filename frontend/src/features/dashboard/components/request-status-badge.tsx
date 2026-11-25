import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STATUS_CLASSES: Record<string, string> = {
  ok: "border-emerald-500/20 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  aborted: "border-sky-500/20 bg-sky-500/15 text-sky-700 dark:text-sky-400",
  rate_limited: "border-orange-500/20 bg-orange-500/15 text-orange-700 dark:text-orange-400",
  overloaded: "border-amber-500/20 bg-amber-500/15 text-amber-700 dark:text-amber-400",
  auth_error: "border-red-500/20 bg-red-500/15 text-red-700 dark:text-red-400",
  client_error: "border-zinc-500/20 bg-zinc-500/15 text-zinc-700 dark:text-zinc-300",
  server_error: "border-red-500/20 bg-red-500/15 text-red-700 dark:text-red-400",
};

/** A request's outcome category, with the HTTP status for anything that was not a plain 200. */
export function RequestStatusBadge({ status, statusCode }: { status: string; statusCode?: number }) {
  const { t } = useTranslation();
  const label = t(`dashboard.requestStatus.${status}`, { defaultValue: status });
  const showCode = statusCode !== undefined && statusCode !== 200 && statusCode > 0;
  return (
    <Badge variant="outline" className={cn("gap-1 font-normal", STATUS_CLASSES[status] ?? STATUS_CLASSES.client_error)}>
      {label}
      {showCode ? <span className="font-mono text-[10px] opacity-80">{statusCode}</span> : null}
    </Badge>
  );
}
