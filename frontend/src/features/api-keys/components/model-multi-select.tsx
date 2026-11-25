import { useCallback, useMemo, useState } from "react";
import { ChevronsUpDown, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useModels } from "@/features/api-keys/hooks/use-models";

export type ModelMultiSelectProps = {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  triggerId?: string;
};

/**
 * Pick models from the synced catalog, or type any id / family prefix
 * (`claude-sonnet-4-5` also covers `claude-sonnet-4-5-20250929`).
 */
export function ModelMultiSelect({ value, onChange, placeholder, triggerId }: ModelMultiSelectProps) {
  const { t } = useTranslation();
  const placeholderLabel = placeholder ?? t("apiKeys.modelSelect.all");
  const { data: catalog = [], isLoading } = useModels();
  const [search, setSearch] = useState("");

  const options = useMemo(() => {
    // Keep selected free-text entries visible in the list too.
    const all = [...catalog, ...value.filter((id) => !catalog.includes(id))];
    const query = search.trim().toLowerCase();
    return query ? all.filter((id) => id.toLowerCase().includes(query)) : all;
  }, [catalog, value, search]);

  const selected = useMemo(() => new Set(value), [value]);
  const typed = search.trim();
  const canAdd = typed.length > 0 && !selected.has(typed) && !catalog.includes(typed);

  const toggle = useCallback(
    (id: string) => onChange(selected.has(id) ? value.filter((v) => v !== id) : [...value, id]),
    [onChange, selected, value],
  );

  const addTyped = () => {
    if (!canAdd) return;
    onChange([...value, typed]);
    setSearch("");
  };

  const label = value.length === 0 ? placeholderLabel : t("apiKeys.modelSelect.selected", { count: value.length });

  return (
    <div className="space-y-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button id={triggerId} type="button" variant="outline" className="w-full justify-between font-normal">
            <span className="truncate text-left">{isLoading ? t("apiKeys.modelSelect.loading") : label}</span>
            <ChevronsUpDown className="ml-1 size-4 shrink-0 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 w-[var(--radix-dropdown-menu-trigger-width)]">
          <div className="px-2 py-1.5">
            <Input
              name="model-search"
              aria-label={t("apiKeys.modelSelect.search")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("apiKeys.modelSelect.search")}
              className="h-7 text-xs"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  addTyped();
                }
              }}
            />
          </div>
          {canAdd ? (
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                addTyped();
              }}
            >
              <Plus className="size-3.5" />
              <span className="truncate">{t("apiKeys.modelSelect.add", { model: typed })}</span>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={value.length === 0}
            onCheckedChange={() => onChange([])}
            onSelect={(event) => event.preventDefault()}
          >
            {t("apiKeys.modelSelect.all")}
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          {options.map((id) => (
            <DropdownMenuCheckboxItem
              key={id}
              checked={selected.has(id)}
              onCheckedChange={() => toggle(id)}
              onSelect={(event) => event.preventDefault()}
            >
              <span className="truncate font-mono text-xs">{id}</span>
            </DropdownMenuCheckboxItem>
          ))}
          {options.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              {catalog.length === 0 ? t("apiKeys.modelSelect.noCatalog") : t("apiKeys.modelSelect.empty")}
            </div>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {value.map((id) => (
            <Badge key={id} variant="secondary" className="max-w-full gap-1 font-mono text-xs">
              <span className="truncate">{id}</span>
              <button
                type="button"
                className="ml-0.5 hover:text-foreground"
                aria-label={t("apiKeys.modelSelect.remove", { model: id })}
                onClick={() => onChange(value.filter((v) => v !== id))}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}
