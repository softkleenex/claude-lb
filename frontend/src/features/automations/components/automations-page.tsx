import { Bot, ChevronDown, ChevronRight, Inbox, Info, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { AlertMessage } from "@/components/alert-message";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { SearchInput } from "@/components/search-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SpinnerBlock } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatAbsolute, formatUntil, useNow } from "@/features/accounts/lib/time";
import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { AutomationJobDialog } from "@/features/automations/components/automation-job-dialog";
import { useAutomationJobs, useAutomationMutations, useAutomationRuns } from "@/features/automations/hooks/use-automations";
import { formatSchedule } from "@/features/automations/schedule";
import type { AutomationCycle, AutomationJob, CycleStatus, RunFilters, RunStatus } from "@/features/automations/schemas";
import { MultiSelectFilter } from "@/features/dashboard/components/filters/multi-select-filter";
import { PaginationControls } from "@/features/dashboard/components/filters/pagination-controls";
import { formatMs, formatUsd } from "@/features/dashboard/utils";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/utils/formatters";

const HEAD = "text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80";
const RUN_STATUSES: RunStatus[] = ["success", "failed", "skipped", "running", "pending"];
const ALL = "__all__";

const STATUS_TONE: Record<CycleStatus | RunStatus, string> = {
  success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  partial: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  failed: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  skipped: "border-border bg-muted text-muted-foreground",
  running: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  pending: "border-sky-500/30 bg-sky-500/5 text-sky-700 dark:text-sky-300",
};

export function StatusBadge({ status }: { status: CycleStatus | RunStatus }) {
  const { t } = useTranslation();
  return (
    <Badge variant="outline" className={cn("text-[11px]", STATUS_TONE[status])}>
      {t(`automations.status.${status}`)}
    </Badge>
  );
}

type Confirm = { kind: "run" | "delete"; job: AutomationJob };

function accountsLabel(job: AutomationJob, t: ReturnType<typeof useTranslation>["t"]): string {
  const names = job.targets.map((target) => target.name);
  const head = names.slice(0, 2).join(", ");
  const more = names.length > 2 ? ` ${t("automations.jobs.more", { count: names.length - 2 })}` : "";
  const scope = job.accountIds.length === 0 ? `${t("automations.jobs.allAccounts")} · ` : "";
  return names.length === 0 ? t("automations.jobs.noTargets") : `${scope}${head}${more}`;
}

function EstimateCell({ job }: { job: AutomationJob }) {
  const { t } = useTranslation();
  const { apiAccounts, subscriptionAccounts, perRunUsd } = job.estimate;
  return (
    <div className="space-y-0.5 leading-tight">
      <div className="tabular-nums">{apiAccounts > 0 ? `≤ ${formatUsd(perRunUsd)}` : formatUsd(0)}</div>
      <div className="text-[11px] text-muted-foreground">
        {apiAccounts > 0 ? t("automations.jobs.apiAccounts", { count: apiAccounts }) : null}
        {apiAccounts > 0 && subscriptionAccounts > 0 ? " · " : null}
        {subscriptionAccounts > 0 ? t("automations.jobs.subscriptionAccounts", { count: subscriptionAccounts }) : null}
      </div>
    </div>
  );
}

function CycleRows({ cycle, expanded, onToggle }: { cycle: AutomationCycle; expanded: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <>
      <TableRow className="cursor-pointer" onClick={onToggle} aria-expanded={expanded}>
        <TableCell className="w-8 pl-3">
          <Chevron className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </TableCell>
        <TableCell>
          <StatusBadge status={cycle.status} />
        </TableCell>
        <TableCell className="text-xs">
          <div className="max-w-[220px] truncate font-medium" title={cycle.jobName}>
            {cycle.jobName}
          </div>
          <div className="text-[11px] text-muted-foreground">{t(`automations.trigger.${cycle.trigger}`)}</div>
        </TableCell>
        <TableCell className="whitespace-nowrap text-xs">{formatAbsolute(cycle.scheduledFor)}</TableCell>
        <TableCell className="whitespace-nowrap text-xs">
          {t("automations.runs.summary", {
            ok: cycle.succeeded,
            total: cycle.total,
          })}
          {cycle.failed > 0 ? (
            <span className="ml-1 text-red-600 dark:text-red-400">{t("automations.runs.failedCount", { count: cycle.failed })}</span>
          ) : null}
          {cycle.skipped > 0 ? (
            <span className="ml-1 text-muted-foreground">{t("automations.runs.skippedCount", { count: cycle.skipped })}</span>
          ) : null}
        </TableCell>
        <TableCell className="whitespace-nowrap text-right text-xs tabular-nums">
          {formatNumber(cycle.inputTokens)} / {formatNumber(cycle.outputTokens)}
        </TableCell>
        <TableCell className="whitespace-nowrap pr-4 text-right text-xs tabular-nums">{formatUsd(cycle.costUsd)}</TableCell>
      </TableRow>
      {expanded
        ? cycle.runs.map((run) => (
            <TableRow key={run.id} className="bg-muted/30 hover:bg-muted/40">
              <TableCell />
              <TableCell>
                <StatusBadge status={run.status} />
              </TableCell>
              <TableCell className="text-xs">
                <div className="font-medium">{run.accountName || "—"}</div>
                <div className="text-[11px] text-muted-foreground">
                  {run.httpStatus !== null ? `HTTP ${run.httpStatus}` : null}
                  {run.httpStatus !== null && run.durationMs !== null ? " · " : null}
                  {run.durationMs !== null ? formatMs(run.durationMs) : null}
                </div>
              </TableCell>
              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                {formatAbsolute(run.startedAt ?? run.scheduledFor)}
              </TableCell>
              <TableCell className="max-w-[320px] text-xs whitespace-normal break-words text-muted-foreground">
                {run.error ?? (run.status === "success" ? t("automations.runs.ok") : "—")}
              </TableCell>
              <TableCell className="whitespace-nowrap text-right text-xs tabular-nums">
                {formatNumber(run.inputTokens)} / {formatNumber(run.outputTokens)}
              </TableCell>
              <TableCell className="whitespace-nowrap pr-4 text-right text-xs tabular-nums">{formatUsd(run.costUsd)}</TableCell>
            </TableRow>
          ))
        : null}
    </>
  );
}

export function AutomationsPage() {
  const { t } = useTranslation();
  const now = useNow(30_000);
  const canWrite = useAuthStore((state) => state.canWrite);
  const jobsQuery = useAutomationJobs();
  const { create, update, remove, runNow, busy } = useAutomationMutations();
  const [search, setSearch] = useState("");
  const [enabledFilter, setEnabledFilter] = useState<string>(ALL);
  const [dialog, setDialog] = useState<{ open: boolean; job: AutomationJob | null }>({ open: false, job: null });
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [runFilters, setRunFilters] = useState<RunFilters>({ jobId: [], status: [], trigger: null, limit: 20, offset: 0 });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const runsQuery = useAutomationRuns(runFilters);

  const data = jobsQuery.data;
  const jobs = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (data?.jobs ?? []).filter((job) => {
      if (enabledFilter === "enabled" && !job.enabled) return false;
      if (enabledFilter === "disabled" && job.enabled) return false;
      if (!needle) return true;
      return [job.name, job.model, job.prompt, ...job.targets.map((target) => target.name)]
        .join("\n")
        .toLowerCase()
        .includes(needle);
    });
  }, [data, search, enabledFilter]);
  const limits = { maxTokensCap: data?.maxTokensCap ?? 1024, maxSpreadMinutes: data?.maxSpreadMinutes ?? 120 };
  const updateRunFilters = (patch: Partial<RunFilters>) =>
    setRunFilters((current) => ({ ...current, offset: 0, ...patch }));
  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const confirmJob = confirm?.job;
  return (
    <div className="animate-fade-in-up space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Bot className="h-5 w-5 text-primary" aria-hidden="true" />
            {t("automations.page.title")}
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t("automations.page.subtitle")}</p>
        </div>
        {canWrite ? (
          <Button type="button" size="sm" onClick={() => setDialog({ open: true, job: null })}>
            <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
            {t("automations.jobs.add")}
          </Button>
        ) : null}
      </div>

      <p className="flex items-start gap-1.5 rounded-lg border bg-card px-3 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {t("automations.page.note", { minutes: data?.minIntervalMinutes ?? 5 })}
      </p>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            name="automation-search"
            value={search}
            onChange={setSearch}
            placeholder={t("automations.filters.search")}
            ariaLabel={t("automations.filters.search")}
            className="w-full sm:w-64"
          />
          <Select value={enabledFilter} onValueChange={setEnabledFilter}>
            <SelectTrigger className="h-8 w-40 text-xs" aria-label={t("automations.filters.state")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("automations.filters.allStates")}</SelectItem>
              <SelectItem value="enabled">{t("automations.filters.enabled")}</SelectItem>
              <SelectItem value="disabled">{t("automations.filters.disabled")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {jobsQuery.error && !data ? <AlertMessage variant="error">{jobsQuery.error.message}</AlertMessage> : null}
        {!data ? (
          jobsQuery.error ? null : <SpinnerBlock />
        ) : jobs.length === 0 ? (
          <EmptyState
            icon={Bot}
            title={data.jobs.length === 0 ? t("automations.jobs.emptyTitle") : t("automations.jobs.emptyFilteredTitle")}
            description={data.jobs.length === 0 ? t("automations.jobs.emptyDescription") : undefined}
          />
        ) : (
          <div className="overflow-x-auto rounded-xl border bg-card">
            <Table className="min-w-[980px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className={cn(HEAD, "pl-4")}>{t("automations.jobs.columns.name")}</TableHead>
                  <TableHead className={HEAD}>{t("automations.jobs.columns.schedule")}</TableHead>
                  <TableHead className={HEAD}>{t("automations.jobs.columns.model")}</TableHead>
                  <TableHead className={HEAD}>{t("automations.jobs.columns.accounts")}</TableHead>
                  <TableHead className={HEAD}>{t("automations.jobs.columns.nextRun")}</TableHead>
                  <TableHead className={HEAD}>{t("automations.jobs.columns.lastRun")}</TableHead>
                  <TableHead className={HEAD}>{t("automations.jobs.columns.cost")}</TableHead>
                  <TableHead className={cn(HEAD, "pr-4 text-right")}>{t("automations.jobs.columns.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => (
                  <TableRow key={job.id} data-testid={`automation-${job.id}`}>
                    <TableCell className="pl-4 text-xs">
                      <div className="max-w-[200px] truncate font-medium" title={job.name}>
                        {job.name}
                      </div>
                      <div className="max-w-[200px] truncate text-[11px] text-muted-foreground" title={job.prompt}>
                        “{job.prompt}”
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">
                      <div>{formatSchedule(job.schedule, t)}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {job.schedule.spreadMinutes > 0
                          ? t("automations.schedule.spread", { minutes: job.schedule.spreadMinutes })
                          : t("automations.schedule.noSpread")}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">
                      <div className="font-mono text-[11px]">{job.model}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {t("automations.jobs.maxTokens", { count: job.maxTokens })}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[220px] text-xs">
                      <div className="truncate" title={job.targets.map((target) => target.name).join(", ")}>
                        {accountsLabel(job, t)}
                      </div>
                      {job.missingAccountIds.length > 0 ? (
                        <div className="text-[11px] text-amber-700 dark:text-amber-400">
                          {t("automations.jobs.missing", { count: job.missingAccountIds.length })}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {job.nextRunAt ? (
                        <>
                          <div>{formatAbsolute(job.nextRunAt)}</div>
                          <div className="text-[11px] text-muted-foreground">{formatUntil(job.nextRunAt, now)}</div>
                        </>
                      ) : (
                        <span className="text-muted-foreground">{t("automations.jobs.off")}</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {job.lastCycle ? (
                        <div className="space-y-0.5">
                          <StatusBadge status={job.lastCycle.status} />
                          <div className="text-[11px] text-muted-foreground">{formatAbsolute(job.lastCycle.scheduledFor)}</div>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      <EstimateCell job={job} />
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Switch
                          checked={job.enabled}
                          disabled={!canWrite || busy}
                          aria-label={t(job.enabled ? "automations.jobs.disableAria" : "automations.jobs.enableAria", {
                            name: job.name,
                          })}
                          onCheckedChange={(enabled) => update.mutate({ id: job.id, changes: { enabled } })}
                        />
                        {canWrite ? (
                          <>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8"
                              disabled={busy}
                              aria-label={t("automations.jobs.runNowAria", { name: job.name })}
                              title={t("automations.jobs.runNow")}
                              onClick={() => setConfirm({ kind: "run", job })}
                            >
                              <Play className="h-4 w-4" aria-hidden="true" />
                            </Button>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8"
                              disabled={busy}
                              aria-label={t("automations.jobs.editAria", { name: job.name })}
                              title={t("automations.jobs.edit")}
                              onClick={() => setDialog({ open: true, job })}
                            >
                              <Pencil className="h-4 w-4" aria-hidden="true" />
                            </Button>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8 text-destructive hover:text-destructive"
                              disabled={busy}
                              aria-label={t("automations.jobs.deleteAria", { name: job.name })}
                              title={t("automations.jobs.delete")}
                              onClick={() => setConfirm({ kind: "delete", job })}
                            >
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">{t("automations.runs.title")}</h2>
          <p className="text-xs text-muted-foreground">{t("automations.runs.description")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MultiSelectFilter
            label={t("automations.runs.filterJob")}
            values={runFilters.jobId}
            options={(data?.jobs ?? []).map((job) => ({ value: job.id, label: job.name }))}
            onChange={(jobId) => updateRunFilters({ jobId })}
          />
          <MultiSelectFilter
            label={t("automations.runs.filterStatus")}
            values={runFilters.status}
            options={RUN_STATUSES.map((status) => ({ value: status, label: t(`automations.status.${status}`) }))}
            onChange={(status) => updateRunFilters({ status })}
          />
          <Select
            value={runFilters.trigger ?? ALL}
            onValueChange={(value) => updateRunFilters({ trigger: value === ALL ? null : value })}
          >
            <SelectTrigger className="h-8 w-40 text-xs" aria-label={t("automations.runs.filterTrigger")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("automations.runs.allTriggers")}</SelectItem>
              <SelectItem value="scheduled">{t("automations.trigger.scheduled")}</SelectItem>
              <SelectItem value="manual">{t("automations.trigger.manual")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {!runsQuery.data ? (
          runsQuery.error ? <AlertMessage variant="error">{runsQuery.error.message}</AlertMessage> : <SpinnerBlock />
        ) : runsQuery.data.cycles.length === 0 ? (
          <EmptyState icon={Inbox} title={t("automations.runs.emptyTitle")} description={t("automations.runs.emptyDescription")} />
        ) : (
          <>
            <div className="overflow-x-auto rounded-xl border bg-card">
              <Table className="min-w-[860px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-8" />
                    <TableHead className={HEAD}>{t("automations.runs.columns.status")}</TableHead>
                    <TableHead className={HEAD}>{t("automations.runs.columns.job")}</TableHead>
                    <TableHead className={HEAD}>{t("automations.runs.columns.time")}</TableHead>
                    <TableHead className={HEAD}>{t("automations.runs.columns.result")}</TableHead>
                    <TableHead className={cn(HEAD, "text-right")}>{t("automations.runs.columns.tokens")}</TableHead>
                    <TableHead className={cn(HEAD, "pr-4 text-right")}>{t("automations.runs.columns.cost")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runsQuery.data.cycles.map((cycle) => (
                    <Fragment key={cycle.cycleKey}>
                      <CycleRows cycle={cycle} expanded={expanded.has(cycle.cycleKey)} onToggle={() => toggle(cycle.cycleKey)} />
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex justify-end">
              <PaginationControls
                total={runsQuery.data.total}
                limit={runFilters.limit}
                offset={runFilters.offset}
                hasMore={runsQuery.data.hasMore}
                onLimitChange={(limit) => updateRunFilters({ limit })}
                onOffsetChange={(offset) => setRunFilters((current) => ({ ...current, offset }))}
              />
            </div>
          </>
        )}
      </section>

      <AutomationJobDialog
        open={dialog.open}
        job={dialog.job}
        limits={limits}
        busy={busy}
        onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
        onCreate={(input) => create.mutateAsync(input)}
        onUpdate={(job, changes) => update.mutateAsync({ id: job.id, changes })}
      />

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm?.kind === "delete"
            ? t("automations.confirm.deleteTitle", { name: confirmJob?.name ?? "" })
            : t("automations.confirm.runTitle", { name: confirmJob?.name ?? "" })
        }
        description={
          confirm?.kind === "delete"
            ? t("automations.confirm.deleteBody")
            : t("automations.confirm.runBody", {
                count: confirmJob?.targets.length ?? 0,
                model: confirmJob?.model ?? "",
              })
        }
        confirmLabel={confirm?.kind === "delete" ? t("automations.confirm.delete") : t("automations.confirm.run")}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.kind === "delete") remove.mutate(confirm.job.id);
          else runNow.mutate(confirm.job.id);
          setConfirm(null);
        }}
      >
        {confirm?.kind === "run" && confirmJob && confirmJob.estimate.apiAccounts > 0 ? (
          <AlertMessage variant="warning">
            {t("automations.confirm.runCost", {
              cost: formatUsd(confirmJob.estimate.perRunUsd),
              count: confirmJob.estimate.apiAccounts,
            })}
          </AlertMessage>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
