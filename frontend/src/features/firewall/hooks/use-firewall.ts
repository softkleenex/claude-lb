import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  addFirewallEntry,
  deleteFirewallEntry,
  getFirewall,
  setFirewallMode,
  updateFirewallEntry,
} from "@/features/firewall/api";
import type { FirewallMode } from "@/features/firewall/schemas";

export const FIREWALL_QUERY_KEY = ["firewall", "state"] as const;

export function useFirewall() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const firewallQuery = useQuery({
    queryKey: FIREWALL_QUERY_KEY,
    queryFn: getFirewall,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["firewall"] });
  const onError = (error: Error) => toast.error(error.message);

  const setMode = useMutation({
    mutationFn: (mode: FirewallMode) => setFirewallMode(mode),
    onSuccess: (state) => {
      queryClient.setQueryData(FIREWALL_QUERY_KEY, state);
      toast.success(t(state.mode === "allowlist" ? "firewall.toast.allowlistOn" : "firewall.toast.allowAllOn"));
    },
    onError,
  });
  const add = useMutation({
    mutationFn: ({ network, note }: { network: string; note: string }) => addFirewallEntry(network, note),
    onSuccess: (entry) => {
      toast.success(t("firewall.toast.added", { network: entry.network }));
      void invalidate();
    },
    onError,
  });
  const updateNote = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) => updateFirewallEntry(id, note),
    onSuccess: () => {
      toast.success(t("firewall.toast.noteSaved"));
      void invalidate();
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteFirewallEntry(id),
    onSuccess: () => {
      toast.success(t("firewall.toast.removed"));
      void invalidate();
    },
    onError,
  });

  return {
    firewallQuery,
    setMode,
    add,
    updateNote,
    remove,
    busy: setMode.isPending || add.isPending || updateNote.isPending || remove.isPending,
  };
}
