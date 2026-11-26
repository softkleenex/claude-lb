import { Check, Pencil, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type AccountNameFieldProps = {
  name: string;
  disabled?: boolean;
  onRename: (name: string) => Promise<unknown>;
};

/** Account name as a heading with an inline rename editor. */
export function AccountNameField({ name, disabled = false, onRename }: AccountNameFieldProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);

  const trimmed = draft.trim();
  const cancel = () => {
    setDraft(name);
    setError(null);
    setEditing(false);
  };
  const save = async () => {
    if (!trimmed || trimmed === name) {
      cancel();
      return;
    }
    try {
      await onRename(trimmed);
      setError(null);
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  if (editing) {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1.5">
          <Input
            aria-label={t("accounts.detail.nameLabel")}
            className="h-8 text-sm"
            maxLength={128}
            value={draft}
            autoFocus
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void save();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancel();
              }
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("accounts.detail.saveName")}
            disabled={disabled || !trimmed}
            onClick={() => void save()}
          >
            <Check className="size-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("common.cancel")} onClick={cancel}>
            <X className="size-4" />
          </Button>
        </div>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <h2 className="min-w-0 truncate text-base font-semibold">{name}</h2>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t("accounts.detail.rename")}
        disabled={disabled}
        onClick={() => {
          setDraft(name);
          setEditing(true);
        }}
      >
        <Pencil className="size-3.5" />
      </Button>
    </div>
  );
}
