import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { createJob, deleteJob, listJobs, listRuns, runJobNow, updateJob } from "@/features/automations/api";
import type { JobInput, RunFilters } from "@/features/automations/schemas";

const KEY = ["automations"] as const;

export function useAutomationJobs() {
  return useQuery({
    queryKey: [...KEY, "jobs"],
    queryFn: listJobs,
    refetchInterval: (query) =>
      // Poll fast while a cycle is in flight so "Run now" results show up promptly.
      query.state.data?.jobs.some((job) => job.lastCycle && ["pending", "running"].includes(job.lastCycle.status))
        ? 3_000
        : 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useAutomationRuns(filters: RunFilters) {
  return useQuery({
    queryKey: [...KEY, "runs", filters],
    queryFn: () => listRuns(filters),
    placeholderData: (previous) => previous,
    refetchInterval: (query) =>
      query.state.data?.cycles.some((cycle) => ["pending", "running"].includes(cycle.status)) ? 3_000 : 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useAutomationMutations() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: KEY });
  const onError = (error: Error) => toast.error(error.message);

  const create = useMutation({
    mutationFn: (input: JobInput) => createJob(input),
    onSuccess: (job) => {
      toast.success(t("automations.toast.created", { name: job.name }));
      void invalidate();
    },
    onError,
  });
  const update = useMutation({
    mutationFn: ({ id, changes }: { id: string; changes: Partial<JobInput> }) => updateJob(id, changes),
    onSuccess: (job, { changes }) => {
      toast.success(
        Object.keys(changes).length === 1 && changes.enabled !== undefined
          ? t(job.enabled ? "automations.toast.enabled" : "automations.toast.disabled", { name: job.name })
          : t("automations.toast.saved", { name: job.name }),
      );
      void invalidate();
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteJob(id),
    onSuccess: () => {
      toast.success(t("automations.toast.deleted"));
      void invalidate();
    },
    onError,
  });
  const runNow = useMutation({
    mutationFn: (id: string) => runJobNow(id),
    onSuccess: (result) => {
      toast.success(t("automations.toast.started", { count: result.runs }));
      void invalidate();
    },
    onError,
  });

  return {
    create,
    update,
    remove,
    runNow,
    busy: create.isPending || update.isPending || remove.isPending || runNow.isPending,
  };
}
