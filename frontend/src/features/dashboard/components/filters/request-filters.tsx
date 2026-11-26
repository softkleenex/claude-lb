import { RotateCcw, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MultiSelectFilter, type MultiSelectOption } from "@/features/dashboard/components/filters/multi-select-filter";
import { TimeframeSelect } from "@/features/dashboard/components/filters/timeframe-select";
import type { FilterState } from "@/features/dashboard/schemas";

export const SEARCH_DEBOUNCE_MS = 300;

export type RequestFiltersProps = {
  filters: FilterState;
  filtersApplied: boolean;
  accountOptions: MultiSelectOption[];
  apiKeyOptions: MultiSelectOption[];
  modelOptions: MultiSelectOption[];
  statusOptions: MultiSelectOption[];
  onChange: (patch: Partial<FilterState>) => void;
  onReset: () => void;
};

/** Search (debounced), timeframe and multi-select facets for the request log. */
export function RequestFilters({
  filters,
  filtersApplied,
  accountOptions,
  apiKeyOptions,
  modelOptions,
  statusOptions,
  onChange,
  onReset,
}: RequestFiltersProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState(filters.search);
  const lastSent = useRef(filters.search);

  // Follow outside changes (reset, back/forward) without clobbering what is being typed.
  useEffect(() => {
    if (filters.search !== lastSent.current) {
      lastSent.current = filters.search;
      setSearch(filters.search);
    }
  }, [filters.search]);

  useEffect(() => {
    if (search === lastSent.current) return;
    const timer = setTimeout(() => {
      lastSent.current = search;
      onChange({ search, offset: 0 });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search, onChange]);

  return (
    <div className="space-y-2 rounded-xl border bg-card p-3 sm:p-4">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground/60"
            aria-hidden="true"
          />
          <Input
            name="request-log-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="h-8 pl-9"
            placeholder={t("dashboard.filters.searchPlaceholder")}
            aria-label={t("dashboard.filters.search")}
          />
        </div>
        <TimeframeSelect value={filters.timeframe} onChange={(timeframe) => onChange({ timeframe, offset: 0 })} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <MultiSelectFilter
          label={t("dashboard.filters.accounts")}
          values={filters.accountIds}
          options={accountOptions}
          onChange={(accountIds) => onChange({ accountIds, offset: 0 })}
        />
        <MultiSelectFilter
          label={t("dashboard.filters.apiKeys")}
          values={filters.apiKeyIds}
          options={apiKeyOptions}
          onChange={(apiKeyIds) => onChange({ apiKeyIds, offset: 0 })}
        />
        <MultiSelectFilter
          label={t("dashboard.filters.models")}
          values={filters.models}
          options={modelOptions}
          onChange={(models) => onChange({ models, offset: 0 })}
        />
        <MultiSelectFilter
          label={t("dashboard.filters.statuses")}
          values={filters.statuses}
          options={statusOptions}
          onChange={(statuses) => onChange({ statuses, offset: 0 })}
        />

        {filters.sessionKey ? (
          <Badge variant="outline" className="h-8 gap-1.5 px-3 text-xs font-normal">
            <span className="max-w-[200px] truncate" title={filters.sessionKey}>
              {t("dashboard.filters.conversationBadge", { id: filters.sessionKey.slice(0, 12) })}
            </span>
            <button
              type="button"
              className="ml-0.5 rounded-full p-0.5 hover:bg-muted-foreground/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => onChange({ sessionKey: null, offset: 0 })}
              aria-label={t("dashboard.filters.conversationDismiss")}
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </Badge>
        ) : null}

        {filtersApplied ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              lastSent.current = "";
              setSearch("");
              onReset();
            }}
            className="h-8 gap-1.5 text-xs text-muted-foreground"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            {t("common.actions.reset")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
