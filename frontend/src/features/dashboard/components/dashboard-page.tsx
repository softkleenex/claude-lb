import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Columns3, RefreshCw, RotateCcw } from "lucide-react";

import { AlertMessage } from "@/components/alert-message";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SpinnerBlock } from "@/components/ui/spinner";
import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { useAccountMutations, useAccounts, usePoolQuota } from "@/features/accounts/hooks/use-accounts";
import type { Account } from "@/features/accounts/schemas";
import {
  AccountCards,
  AccountList,
  AccountSummaryLine,
  type AccountActions,
} from "@/features/dashboard/components/account-section";
import { AccountViewModeToggle } from "@/features/dashboard/components/account-view-mode-toggle";
import { ApiSpendCard } from "@/features/dashboard/components/api-spend-card";
import { ConversationsView } from "@/features/dashboard/components/conversations-view";
import { CostTrendChart } from "@/features/dashboard/components/cost-trend-chart";
import { DashboardSkeleton } from "@/features/dashboard/components/dashboard-skeleton";
import { OverviewTimeframeSelect } from "@/features/dashboard/components/filters/overview-timeframe-select";
import { RequestFilters } from "@/features/dashboard/components/filters/request-filters";
import { RecentRequestsTable } from "@/features/dashboard/components/recent-requests-table";
import { RequestDetailsDialog } from "@/features/dashboard/components/request-details-dialog";
import { StatsGrid } from "@/features/dashboard/components/stats-grid";
import { UsageByModelTable } from "@/features/dashboard/components/usage-by-model-table";
import { CapacityDonuts } from "@/features/dashboard/components/usage-donuts";
import { WeeklyCreditsPaceCard } from "@/features/dashboard/components/weekly-credits-pace-card";
import { useCostTrend, useDashboardOverview, useDashboardProjections } from "@/features/dashboard/hooks/use-dashboard";
import { useRequestLogTablePreferences } from "@/features/dashboard/hooks/use-request-log-table-preferences";
import { parseFilterState, useRequestLogs, writeFilterState } from "@/features/dashboard/hooks/use-request-logs";
import { useRequestLogView } from "@/features/dashboard/hooks/use-conversations";
import { REQUEST_LOG_COLUMN_OPTIONS } from "@/features/dashboard/request-log-columns";
import {
  DEFAULT_OVERVIEW_TIMEFRAME,
  REQUEST_LOG_VIEWS,
  parseOverviewTimeframe,
  type RequestLogView,
  type DashboardOverview,
  type OverviewTimeframe,
} from "@/features/dashboard/schemas";
import { buildStats } from "@/features/dashboard/utils";
import { routingStrategyLabelKey } from "@/features/settings/routing-labels";
import { useChartColors } from "@/hooks/use-chart-colors";
import { useDashboardPreferencesStore } from "@/hooks/use-dashboard-preferences";
import { cn } from "@/lib/utils";

const SECTION_TITLE = "text-[13px] font-medium uppercase tracking-wider text-muted-foreground";

function ViewSwitch({ value, onChange }: { value: RequestLogView; onChange: (view: RequestLogView) => void }) {
  const { t } = useTranslation();
  return (
    <div
      role="tablist"
      aria-label={t("dashboard.requests.viewLabel")}
      className="inline-flex items-center rounded-lg border border-border/50 bg-muted/40 p-0.5"
    >
      {REQUEST_LOG_VIEWS.map((view) => (
        <button
          key={view}
          type="button"
          role="tab"
          aria-selected={value === view}
          onClick={() => onChange(view)}
          className={cn(
            "inline-flex h-7 items-center rounded-md px-3 text-xs font-medium transition-colors",
            value === view
              ? "bg-background text-foreground shadow-[var(--shadow-xs)]"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t(`dashboard.requests.views.${view}`)}
        </button>
      ))}
    </div>
  );
}

function MetaLine({ overview }: { overview: DashboardOverview }) {
  const { t } = useTranslation();
  const { meta } = overview;
  const strategyKey = routingStrategyLabelKey(meta.routingStrategy);
  const strategy = strategyKey ? t(strategyKey) : meta.routingStrategy;
  return (
    <p className="mt-1 text-sm text-muted-foreground" data-testid="dashboard-meta">
      {t("dashboard.page.meta", {
        version: meta.version,
        available: meta.accountsAvailable,
        total: meta.accountsTotal,
        pool: Math.round(meta.poolRemainingPercent),
        strategy: meta.stickySessionsEnabled ? t("dashboard.page.withSticky", { strategy }) : strategy,
      })}
    </p>
  );
}

export function DashboardPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const colors = useChartColors();
  const canWrite = useAuthStore((state) => state.canWrite);

  const timeframe = parseOverviewTimeframe(searchParams.get("window"));
  const overviewQuery = useDashboardOverview(timeframe);
  const projectionsQuery = useDashboardProjections();
  const costTrendQuery = useCostTrend(28);
  const accountsQuery = useAccounts();
  const poolQuotaQuery = usePoolQuota();
  const { filters, filtersApplied, logsQuery, optionsQuery, updateFilters, resetFilters } = useRequestLogs();
  const { view: logView, setView: setLogView } = useRequestLogView();
  const { visibleColumns, columnWidths, toggleColumn, setColumnWidth, restoreDefaultLayout } =
    useRequestLogTablePreferences();
  const accountViewMode = useDashboardPreferencesStore((s) => s.accountViewMode);
  const setAccountViewMode = useDashboardPreferencesStore((s) => s.setAccountViewMode);
  const accountListSort = useDashboardPreferencesStore((s) => s.accountListSort);
  const setAccountListSort = useDashboardPreferencesStore((s) => s.setAccountListSort);
  const showRisk = useDashboardPreferencesStore((s) => s.accountBurnrateEnabled);
  const { update, probe } = useAccountMutations();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);

  const overview = overviewQuery.data;
  const projections = projectionsQuery.data;
  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);

  const stats = useMemo(
    () =>
      overview
        ? buildStats(overview, t, {
            primary: colors[0],
            info: colors[1],
            success: "#10b981",
            danger: "#ef4444",
            muted: colors[4] ?? colors[0],
          })
        : [],
    [overview, t, colors],
  );

  const riskById = useMemo(() => {
    const map = new Map<string, string>();
    if (!showRisk) return map;
    for (const item of poolQuotaQuery.data?.accounts ?? []) map.set(item.accountId, item.riskLevel);
    return map;
  }, [poolQuotaQuery.data, showRisk]);

  const runAccountAction = useCallback(async (account: Account, action: () => Promise<unknown>) => {
    setBusyId(account.id);
    try {
      await action();
    } catch {
      // the mutation already reported the failure as a toast
    } finally {
      setBusyId(null);
    }
  }, []);

  const accountActions: AccountActions = {
    canWrite,
    busyId,
    onToggle: (account) =>
      void runAccountAction(account, () =>
        update.mutateAsync({ accountId: account.id, patch: { enabled: account.paused || !account.enabled } }),
      ),
    onProbe: (account) => void runAccountAction(account, () => probe.mutateAsync(account.id)),
  };

  const handleTimeframeChange = (next: OverviewTimeframe) => {
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        if (next === DEFAULT_OVERVIEW_TIMEFRAME) params.delete("window");
        else params.set("window", next);
        return params;
      },
      { replace: true },
    );
  };

  const showConversationRequests = useCallback(
    (sessionKey: string) => {
      setSearchParams(
        (current) => {
          const params = writeFilterState({ ...parseFilterState(current), sessionKey, offset: 0 }, current);
          params.delete("view");
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const isRefreshing =
    overviewQuery.isFetching || projectionsQuery.isFetching || logsQuery.isFetching || accountsQuery.isFetching;
  const handleRefresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    void queryClient.invalidateQueries({ queryKey: ["accounts", "list"] });
    void queryClient.invalidateQueries({ queryKey: ["usage", "quota"] });
  };

  const options = optionsQuery.data;
  const accountOptions = useMemo(
    () => (options?.accounts ?? []).map((option) => ({ value: option.id, label: option.name })),
    [options],
  );
  const apiKeyOptions = useMemo(
    () =>
      (options?.apiKeys ?? []).map((option) => ({
        value: option.id,
        label: option.keyHint ? `${option.name} · ${option.keyHint}` : option.name,
      })),
    [options],
  );
  const modelOptions = useMemo(
    () => (options?.models ?? []).map((model) => ({ value: model, label: model })),
    [options],
  );
  const statusOptions = useMemo(
    () =>
      (options?.statuses ?? []).map((status) => ({
        value: status,
        label: t(`dashboard.requestStatus.${status}`, { defaultValue: status }),
      })),
    [options, t],
  );

  const errorMessage = overviewQuery.error?.message ?? projectionsQuery.error?.message ?? null;
  const hasCapacity = Boolean(projections?.primary || projections?.secondary);
  const sideCards = [
    projections?.weeklyPace ? <WeeklyCreditsPaceCard key="pace" pace={projections.weeklyPace} /> : null,
    projections && projections.apiAccounts.length > 0 ? (
      <ApiSpendCard key="spend" accounts={projections.apiAccounts} />
    ) : null,
  ].filter(Boolean);
  const logPage = logsQuery.data;
  const retentionDays = overview?.meta.requestLogRetentionDays ?? null;
  const windowDays = overview ? overview.timeframe.windowMinutes / 1440 : 0;

  return (
    <div className="animate-fade-in-up min-w-0 space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{t("dashboard.page.title")}</h1>
          {overview ? (
            <MetaLine overview={overview} />
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">{t("dashboard.page.subtitle")}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <OverviewTimeframeSelect value={timeframe} onChange={handleTimeframeChange} />
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            aria-label={t("dashboard.page.refresh")}
            title={t("dashboard.page.refreshHint")}
          >
            <RefreshCw className={`h-4 w-4${isRefreshing ? " animate-spin" : ""}`} aria-hidden="true" />
          </button>
        </div>
      </div>

      {errorMessage ? <AlertMessage variant="error">{errorMessage}</AlertMessage> : null}

      {!overview ? (
        <DashboardSkeleton />
      ) : (
        <>
          <StatsGrid stats={stats} />
          {retentionDays !== null && windowDays > retentionDays ? (
            <p className="-mt-5 text-xs text-muted-foreground">
              {t("dashboard.page.retentionNote", { days: retentionDays })}
            </p>
          ) : null}

          {hasCapacity ? (
            <div
              className={
                sideCards.length > 0 ? "grid min-w-0 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]" : "min-w-0"
              }
            >
              <CapacityDonuts primary={projections?.primary ?? null} secondary={projections?.secondary ?? null} />
              {sideCards.length > 0 ? <div className="grid min-w-0 content-start gap-4">{sideCards}</div> : null}
            </div>
          ) : sideCards.length > 0 ? (
            <div className="grid min-w-0 gap-4 lg:grid-cols-2">{sideCards}</div>
          ) : null}

          <section className="space-y-4" aria-labelledby="dashboard-accounts-title">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-3">
                <h2 id="dashboard-accounts-title" className={SECTION_TITLE}>
                  {t("dashboard.accounts.title")}
                </h2>
                <AccountSummaryLine accounts={accounts} />
              </div>
              <div className="h-px min-w-8 flex-1 bg-border" />
              <AccountViewModeToggle value={accountViewMode} onChange={setAccountViewMode} />
            </div>
            {accountsQuery.isPending ? (
              <SpinnerBlock />
            ) : accounts.length === 0 ? (
              <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
                {t("dashboard.accounts.empty")}
              </p>
            ) : accountViewMode === "list" ? (
              <AccountList
                accounts={accounts}
                riskById={riskById}
                actions={accountActions}
                sort={accountListSort}
                onSortChange={setAccountListSort}
              />
            ) : (
              <AccountCards accounts={accounts} riskById={riskById} actions={accountActions} />
            )}
          </section>

          <section className="space-y-4" aria-labelledby="dashboard-usage-title">
            <div className="flex items-center gap-3">
              <h2 id="dashboard-usage-title" className={SECTION_TITLE}>
                {t("dashboard.usageSection.title")}
              </h2>
              <div className="h-px min-w-8 flex-1 bg-border" />
            </div>
            <div className="grid min-w-0 gap-4 xl:grid-cols-2">
              <UsageByModelTable models={overview.byModel} />
              {costTrendQuery.data ? <CostTrendChart points={costTrendQuery.data} /> : <SpinnerBlock />}
            </div>
          </section>
        </>
      )}

      <section className="space-y-4" aria-labelledby="dashboard-requests-title">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="dashboard-requests-title" className={SECTION_TITLE}>
            {t("dashboard.requests.title")}
          </h2>
          <ViewSwitch value={logView} onChange={setLogView} />
          {logView === "requests" && logPage ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {t("dashboard.requests.total", { count: logPage.total })}
            </span>
          ) : null}
          <div className="h-px min-w-8 flex-1 bg-border" />
          {logView === "requests" ? (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="sm">
                    <Columns3 className="mr-2 h-4 w-4" />
                    {t("dashboard.requests.columnLayout.columns", { count: visibleColumns.length })}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuLabel>{t("dashboard.requests.columnLayout.visibleColumns")}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {REQUEST_LOG_COLUMN_OPTIONS.map((column) => {
                    const isVisible = visibleColumns.includes(column.id);
                    return (
                      <DropdownMenuCheckboxItem
                        key={column.id}
                        checked={isVisible}
                        disabled={isVisible && visibleColumns.length === 1}
                        onCheckedChange={() => toggleColumn(column.id)}
                        onSelect={(event) => event.preventDefault()}
                      >
                        {t(column.translationKey)}
                      </DropdownMenuCheckboxItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("dashboard.requests.columnLayout.restoreDefault")}
                title={t("dashboard.requests.columnLayout.restoreDefault")}
                onClick={restoreDefaultLayout}
              >
                <RotateCcw className="h-4 w-4" />
              </Button>
            </>
          ) : null}
        </div>

        {logView === "conversations" ? (
          <ConversationsView onShowRequests={showConversationRequests} />
        ) : (
          <>
            <RequestFilters
              filters={filters}
              filtersApplied={filtersApplied}
              accountOptions={accountOptions}
              apiKeyOptions={apiKeyOptions}
              modelOptions={modelOptions}
              statusOptions={statusOptions}
              onChange={updateFilters}
              onReset={resetFilters}
            />

            {logsQuery.error && !logPage ? (
              <div className="space-y-3 rounded-xl border bg-card p-4">
                <div role="alert">
                  <AlertMessage variant="error">{logsQuery.error.message}</AlertMessage>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void logsQuery.refetch()}
                  disabled={logsQuery.isFetching}
                >
                  {t("common.actions.retry")}
                </Button>
              </div>
            ) : !logPage ? (
              <div className="rounded-xl border bg-card py-8">
                <SpinnerBlock />
              </div>
            ) : (
              <div className={logsQuery.isPlaceholderData ? "opacity-60 transition-opacity" : "transition-opacity"}>
                <RecentRequestsTable
                  requests={logPage.requests}
                  total={logPage.total}
                  limit={filters.limit}
                  offset={filters.offset}
                  hasMore={logPage.hasMore}
                  filtersApplied={filtersApplied}
                  visibleColumns={visibleColumns}
                  columnWidths={columnWidths}
                  onColumnWidthChange={setColumnWidth}
                  onLimitChange={(limit) => updateFilters({ limit, offset: 0 })}
                  onOffsetChange={(offset) => updateFilters({ offset })}
                  onSelect={setSelectedRequestId}
                />
              </div>
            )}
          </>
        )}
      </section>

      <RequestDetailsDialog
        requestId={selectedRequestId}
        onClose={() => setSelectedRequestId(null)}
        onShowConversation={(sessionKey) => updateFilters({ sessionKey, offset: 0 })}
      />
    </div>
  );
}
