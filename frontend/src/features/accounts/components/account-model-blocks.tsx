import { Ban, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import type { Account } from "@/features/accounts/schemas";
import { formatAbsolute, formatUntil } from "@/features/accounts/lib/time";

export type AccountModelBlocksProps = {
  account: Account;
  now: number;
  disabled?: boolean;
  onClear: (model?: string) => void;
};

/**
 * Models this subscription refused when called through claude-lb. Those requests are
 * routed to other accounts until the block lifts (12 h) or it is cleared here.
 */
export function AccountModelBlocks({ account, now, disabled = false, onClear }: AccountModelBlocksProps) {
  const { t } = useTranslation();
  if (account.modelBlocks.length === 0) return null;

  return (
    <section className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
            <Ban className="h-3.5 w-3.5" aria-hidden="true" />
            {t("accounts.blocks.title")}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">{t("accounts.blocks.description")}</p>
        </div>
        {account.modelBlocks.length > 1 ? (
          <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onClear()}>
            {t("accounts.blocks.clearAll")}
          </Button>
        ) : null}
      </div>
      <ul className="space-y-1.5">
        {account.modelBlocks.map((block) => {
          const until = formatUntil(block.until, now);
          return (
            <li
              key={block.model}
              className="flex items-center justify-between gap-3 rounded-md border bg-background/60 px-3 py-2 text-xs"
            >
              <span className="min-w-0">
                {t("accounts.blocks.item", {
                  name: account.name,
                  model: block.model,
                  time: formatAbsolute(block.until),
                })}
                {until ? <span className="text-muted-foreground"> ({t("accounts.blocks.remaining", { label: until })})</span> : null}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 shrink-0 gap-1 px-2"
                disabled={disabled}
                aria-label={t("accounts.blocks.clearOneAria", { model: block.model })}
                onClick={() => onClear(block.model)}
              >
                <X className="h-3 w-3" aria-hidden="true" />
                {t("accounts.blocks.clear")}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
