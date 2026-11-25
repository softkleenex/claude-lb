import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getCatalog, probeUnhealthy, syncModels } from "@/features/model-catalog/api";

export const CATALOG_QUERY_KEY = ["model-catalog"] as const;

export function useModelCatalog() {
  const queryClient = useQueryClient();
  const catalogQuery = useQuery({
    queryKey: CATALOG_QUERY_KEY,
    queryFn: getCatalog,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ["accounts"] });
  };

  const sync = useMutation({ mutationFn: syncModels, onSettled: refresh });
  const probe = useMutation({ mutationFn: probeUnhealthy, onSettled: refresh });

  return { catalogQuery, sync, probe };
}
