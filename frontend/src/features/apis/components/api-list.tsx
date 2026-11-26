import { Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiListItem } from "@/features/apis/components/api-list-item";
import type { ApiKey } from "@/features/api-keys/schemas";
import { useNow } from "@/features/accounts/lib/time";

const STATUS_FILTER_OPTIONS = ["all", "active", "disabled", "expired"] as const;

export type ApiListProps = {
  apiKeys: ApiKey[];
  selectedKeyId: string | null;
  onSelect: (keyId: string) => void;
  onOpenCreate: () => void;
};


export function ApiList({ apiKeys, selectedKeyId, onSelect, onOpenCreate }: ApiListProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const now = useNow();

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return apiKeys.filter((apiKey) => {
      if (statusFilter !== "all" && apiKey.status !== statusFilter) return false;
      if (!needle) return true;
      return (
        apiKey.name.toLowerCase().includes(needle) ||
        apiKey.keyHint.toLowerCase().includes(needle) ||
        (apiKey.allowedModels ?? []).some((model) => model.toLowerCase().includes(needle))
      );
    });
  }, [apiKeys, search, statusFilter]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" aria-hidden />
          <Input
            name="api-key-search"
            aria-label={t("apis.list.searchPlaceholder")}
            placeholder={t("apis.list.searchPlaceholder")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="h-8 pl-8"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger size="sm" className="w-32 shrink-0" aria-label={t("apis.list.statusFilter")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTER_OPTIONS.map((option) => (
              <SelectItem key={option} value={option}>
                {option === "all" ? t("apis.list.allStatuses") : t(`apiKeys.status.${option}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Button type="button" size="sm" onClick={onOpenCreate} className="h-8 w-full gap-1.5 text-xs">
        <Plus className="h-3.5 w-3.5" />
        {t("apis.list.createKey")}
      </Button>

      <div className="max-h-[calc(100vh-16rem)] space-y-1 overflow-y-auto p-1">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center">
            <p className="text-sm font-medium text-muted-foreground">
              {apiKeys.length === 0 ? t("apis.list.emptyTitle") : t("apis.list.noMatches")}
            </p>
            <p className="text-xs text-muted-foreground/70">
              {apiKeys.length === 0 ? t("apis.list.emptyDescription") : t("apis.list.adjustFilters")}
            </p>
          </div>
        ) : (
          filtered.map((apiKey) => (
            <ApiListItem
              key={apiKey.id}
              apiKey={apiKey}
              selected={apiKey.id === selectedKeyId}
              now={now}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
    </div>
  );
}
