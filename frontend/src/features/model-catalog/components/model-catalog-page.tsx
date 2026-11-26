import { useQueryClient } from "@tanstack/react-query";
import { Boxes, CheckCircle2, ChevronDown, RefreshCw, Stethoscope, XCircle } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { AlertMessage } from "@/components/alert-message";
import { EmptyState } from "@/components/empty-state";
import { SearchInput } from "@/components/search-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SpinnerBlock } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAccountMutations } from "@/features/accounts/hooks/use-accounts";
import { formatAbsolute, formatAgo, formatUntil, useNow } from "@/features/accounts/lib/time";
import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { formatRate } from "@/features/model-catalog/format";
import { CATALOG_QUERY_KEY, useModelCatalog } from "@/features/model-catalog/hooks/use-model-catalog";
import type { Catalog, CatalogModel, ModelPrice, ProbeResult, SyncResult } from "@/features/model-catalog/schemas";
import { cn } from "@/lib/utils";
import { formatCompactNumber } from "@/utils/formatters";

const HEAD = "text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80";
const SECTION_TITLE = "text-[13px] font-medium uppercase tracking-wider text-muted-foreground";

function PriceCell({ price }: { price: ModelPrice | null }) {
  const { t } = useTranslation();
  if (!price) return <span className="text-xs text-muted-foreground">{t("models.table.unpriced")}</span>;
  return (
    <div className="font-mono text-xs leading-tight tabular-nums">
      <div>
        {formatRate(price.input)} / {formatRate(price.output)}
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">
        {t("models.table.cacheRates", { read: formatRate(price.cacheRead), write: formatRate(price.cacheWrite5m) })}
      </div>
      {price.longContext && price.longContextThreshold ? (
        <div className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-400">
          {t("models.table.longContext", {
            threshold: formatCompactNumber(price.longContextThreshold),
            input: formatRate(price.longContext.input),
            output: formatRate(price.longContext.output),
          })}
        </div>
      ) : null}
    </div>
  );
}

function SyncResultCard({ result, onDismiss }: { result: SyncResult; onDismiss: () => void }) {
  const { t } = useTranslation();
  const entries = Object.entries(result);
  return (
    <div className="space-y-2 rounded-xl border bg-card p-4" role="status" data-testid="sync-result">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {entries.length === 0 ? t("models.sync.noneSynced") : t("models.sync.result", { count: entries.length })}
        </p>
        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={onDismiss}>
          {t("common.actions.close")}
        </Button>
      </div>
      {entries.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {entries.map(([name, count]) => (
            <li key={name}>
              <Badge variant="secondary">{t("models.sync.accountModels", { name, count })}</Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{t("models.sync.noneSyncedHint")}</p>
      )}
    </div>
  );
}

function ProbeResultCard({ result, onDismiss }: { result: ProbeResult; onDismiss: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 rounded-xl border bg-card p-4" role="status" data-testid="probe-result">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {result.length === 0 ? t("models.probe.nothingToProbe") : t("models.probe.result", { count: result.length })}
        </p>
        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={onDismiss}>
          {t("common.actions.close")}
        </Button>
      </div>
      {result.length > 0 ? (
        <ul className="space-y-1">
          {result.map((item) => (
            <li key={item.accountId} className="flex items-start gap-2 text-sm">
              {item.ok ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
              ) : (
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
              )}
              <span className="min-w-0">
                <span className="font-medium">{item.accountName}</span>{" "}
                <span className="text-muted-foreground">
                  {item.ok
                    ? t("models.probe.passed", { count: item.models })
                    : t("models.probe.failed", { status: item.statusCode ?? "—", detail: item.detail })}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{t("models.probe.nothingToProbeHint")}</p>
      )}
    </div>
  );
}

function ReroutesSection({ catalog, canWrite }: { catalog: Catalog; canWrite: boolean }) {
  const { t } = useTranslation();
  const now = useNow();
  const queryClient = useQueryClient();
  const { clearBlocks } = useAccountMutations();

  const retry = async (accountId: string, model: string) => {
    try {
      await clearBlocks.mutateAsync({ accountId, model });
    } catch {
      // the mutation already reported the failure as a toast
    }
    void queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEY });
  };

  return (
    <section className="space-y-3" aria-labelledby="models-reroutes-title">
      <div className="flex items-center gap-3">
        <h2 id="models-reroutes-title" className={SECTION_TITLE}>
          {t("models.reroutes.title")}
        </h2>
        <div className="h-px min-w-8 flex-1 bg-border" />
      </div>
      <p className="text-xs text-muted-foreground">{t("models.reroutes.description")}</p>
      {catalog.blocks.length === 0 ? (
        <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">{t("models.reroutes.empty")}</p>
      ) : (
        <ul className="divide-y rounded-xl border bg-card" data-testid="model-reroutes">
          {catalog.blocks.map((block) => (
            <li
              key={`${block.accountId}:${block.model}`}
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
            >
              <div className="min-w-0 text-sm">
                <p>
                  {t("models.reroutes.item", { account: block.accountName })}{" "}
                  <span className="font-mono text-xs" translate="no">
                    {block.model}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("models.reroutes.until", {
                    time: formatAbsolute(block.until),
                    left: formatUntil(block.until, now) ?? t("models.reroutes.soon"),
                  })}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={!canWrite || clearBlocks.isPending}
                onClick={() => void retry(block.accountId, block.model)}
              >
                {t("models.reroutes.retry")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ModelsTable({ models }: { models: CatalogModel[] }) {
  const { t } = useTranslation();
  const now = useNow();
  return (
    <div className="rounded-xl border bg-card">
      <div className="relative overflow-x-auto">
        <Table className="min-w-[900px]" data-testid="models-table">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={cn("pl-4", HEAD)}>{t("models.table.model")}</TableHead>
              <TableHead className={HEAD}>{t("models.table.accounts")}</TableHead>
              <TableHead className={cn("text-right", HEAD)}>{t("models.table.context")}</TableHead>
              <TableHead className={cn("text-right", HEAD)}>{t("models.table.maxOutput")}</TableHead>
              <TableHead className={HEAD}>{t("models.table.price")}</TableHead>
              <TableHead className={cn("pr-4", HEAD)}>{t("models.table.synced")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {models.map((model) => (
              <TableRow key={model.modelId} className="align-top">
                <TableCell className="pl-4 align-top">
                  <div className="leading-tight">
                    <div className="text-sm font-medium">{model.displayName || model.modelId}</div>
                    <div className="font-mono text-[11px] text-muted-foreground" translate="no">
                      {model.modelId}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="align-top">
                  <div className="flex max-w-[16rem] flex-wrap gap-1">
                    {model.accounts.map((account) => (
                      <Badge key={account.id} variant="secondary" className="font-normal">
                        {account.name}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-right align-top font-mono text-xs tabular-nums">
                  {model.maxInputTokens ? formatCompactNumber(model.maxInputTokens) : "—"}
                </TableCell>
                <TableCell className="text-right align-top font-mono text-xs tabular-nums">
                  {model.maxOutputTokens ? formatCompactNumber(model.maxOutputTokens) : "—"}
                </TableCell>
                <TableCell className="align-top">
                  <PriceCell price={model.price} />
                </TableCell>
                <TableCell className="pr-4 align-top text-xs text-muted-foreground">
                  {formatAgo(model.syncedAt, now) ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function PriceTable({ catalog }: { catalog: Catalog }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <h2 className={SECTION_TITLE}>{t("models.prices.title")}</h2>
          <div className="h-px min-w-8 flex-1 bg-border" />
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" aria-expanded={open}>
              {open ? t("models.prices.hide") : t("models.prices.show", { count: catalog.prices.length })}
              <ChevronDown className={cn("ml-1 h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
            </Button>
          </CollapsibleTrigger>
        </div>
        <p className="text-xs text-muted-foreground">{t("models.prices.description")}</p>
        <CollapsibleContent>
          <div className="rounded-xl border bg-card">
            <div className="relative overflow-x-auto">
              <Table className="min-w-[720px]" data-testid="price-table">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className={cn("pl-4", HEAD)}>{t("models.prices.model")}</TableHead>
                    <TableHead className={cn("text-right", HEAD)}>{t("models.prices.input")}</TableHead>
                    <TableHead className={cn("text-right", HEAD)}>{t("models.prices.output")}</TableHead>
                    <TableHead className={cn("text-right", HEAD)}>{t("models.prices.cacheRead")}</TableHead>
                    <TableHead className={cn("text-right", HEAD)}>{t("models.prices.cacheWrite5m")}</TableHead>
                    <TableHead className={cn("pr-4 text-right", HEAD)}>{t("models.prices.cacheWrite1h")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {catalog.prices.map(({ model, price }) => (
                    <TableRow key={model}>
                      <TableCell className="pl-4 font-mono text-xs" translate="no">
                        {model}
                        {price.longContext && price.longContextThreshold ? (
                          <div className="font-sans text-[11px] text-amber-700 dark:text-amber-400">
                            {t("models.table.longContext", {
                              threshold: formatCompactNumber(price.longContextThreshold),
                              input: formatRate(price.longContext.input),
                              output: formatRate(price.longContext.output),
                            })}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">
                        {formatRate(price.input)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">
                        {formatRate(price.output)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">
                        {formatRate(price.cacheRead)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">
                        {formatRate(price.cacheWrite5m)}
                      </TableCell>
                      <TableCell className="pr-4 text-right font-mono text-xs tabular-nums">
                        {formatRate(price.cacheWrite1h)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

export function ModelCatalogPage() {
  const { t } = useTranslation();
  const now = useNow();
  const canWrite = useAuthStore((state) => state.canWrite);
  const { catalogQuery, sync, probe } = useModelCatalog();
  const [search, setSearch] = useState("");
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const catalog = catalogQuery.data;

  const models = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = catalog?.models ?? [];
    if (!term) return list;
    return list.filter((model) =>
      [model.modelId, model.displayName, ...model.accounts.map((a) => a.name)].some((value) =>
        value.toLowerCase().includes(term),
      ),
    );
  }, [catalog, search]);
  const onSearch = useCallback((value: string) => setSearch(value), []);

  const runSync = () => {
    setProbeResult(null);
    sync.mutate(undefined, { onSuccess: setSyncResult });
  };
  const runProbe = () => {
    setSyncResult(null);
    probe.mutate(undefined, { onSuccess: setProbeResult });
  };
  const actionError = sync.error?.message ?? probe.error?.message ?? null;

  return (
    <div className="animate-fade-in-up min-w-0 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Boxes className="h-5 w-5 text-primary" aria-hidden="true" />
            {t("models.page.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("models.page.subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={runSync} disabled={!canWrite || sync.isPending}>
            <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", sync.isPending && "animate-spin")} aria-hidden="true" />
            {sync.isPending ? t("models.sync.running") : t("models.sync.button")}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={runProbe} disabled={!canWrite || probe.isPending}>
            <Stethoscope className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {probe.isPending ? t("models.probe.running") : t("models.probe.button")}
          </Button>
        </div>
      </div>

      {actionError ? <AlertMessage variant="error">{actionError}</AlertMessage> : null}
      {syncResult ? <SyncResultCard result={syncResult} onDismiss={() => setSyncResult(null)} /> : null}
      {probeResult ? <ProbeResultCard result={probeResult} onDismiss={() => setProbeResult(null)} /> : null}

      {catalogQuery.error && !catalog ? (
        <AlertMessage variant="error">{catalogQuery.error.message}</AlertMessage>
      ) : !catalog ? (
        <SpinnerBlock />
      ) : (
        <>
          <div className="space-y-2 rounded-xl border bg-card p-4">
            <p className="text-sm">
              {t("models.summary.line", { count: catalog.models.length })}{" "}
              <span className="text-muted-foreground">
                {catalog.lastSyncedAt
                  ? t("models.summary.lastSynced", { ago: formatAgo(catalog.lastSyncedAt, now) })
                  : t("models.summary.neverSynced")}
              </span>
            </p>
            {catalog.accounts.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5" aria-label={t("models.summary.accounts")}>
                {catalog.accounts.map((account) => (
                  <li key={account.id}>
                    <Badge
                      variant="outline"
                      className={cn("font-normal", (!account.enabled || account.paused) && "opacity-60")}
                      title={
                        account.modelsSyncedAt
                          ? t("models.summary.accountSynced", { time: formatAbsolute(account.modelsSyncedAt) })
                          : t("models.summary.accountNeverSynced")
                      }
                    >
                      {account.modelsSyncedAt
                        ? t("models.summary.accountModels", { name: account.name, count: account.models })
                        : t("models.summary.accountNotSynced", { name: account.name })}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="text-xs text-muted-foreground">{t("models.summary.hint")}</p>
          </div>

          <ReroutesSection catalog={catalog} canWrite={canWrite} />

          <section className="space-y-3" aria-labelledby="models-list-title">
            <div className="flex flex-wrap items-center gap-3">
              <h2 id="models-list-title" className={SECTION_TITLE}>
                {t("models.table.title")}
              </h2>
              <div className="h-px min-w-8 flex-1 bg-border" />
              <SearchInput
                className="w-full sm:w-64"
                name="model-search"
                value={search}
                onChange={onSearch}
                placeholder={t("models.table.searchPlaceholder")}
                ariaLabel={t("models.table.search")}
              />
            </div>
            {catalog.models.length === 0 ? (
              <EmptyState icon={Boxes} title={t("models.empty.title")} description={t("models.empty.description")} />
            ) : models.length === 0 ? (
              <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">{t("models.table.noMatch")}</p>
            ) : (
              <ModelsTable models={models} />
            )}
          </section>

          <PriceTable catalog={catalog} />
        </>
      )}
    </div>
  );
}
