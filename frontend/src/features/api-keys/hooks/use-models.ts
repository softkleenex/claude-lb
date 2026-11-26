import { useQuery } from "@tanstack/react-query";

import { listCatalogModels } from "@/features/api-keys/api";

/** Model ids from every account's synced catalog (may be empty before the first sync). */
export function useModels() {
  return useQuery({
    queryKey: ["models", "catalog"],
    queryFn: listCatalogModels,
    staleTime: 5 * 60 * 1000,
    select: (models) => models.map((model) => model.modelId),
  });
}
