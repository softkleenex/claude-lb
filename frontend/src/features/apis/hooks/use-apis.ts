import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  createApiKey,
  deleteApiKey,
  getApiKeyTrends,
  getKeysOverview,
  listApiKeys,
  regenerateApiKey,
  updateApiKey,
} from "@/features/api-keys/api";
import type { ApiKey, ApiKeyCreateRequest, ApiKeyUpdateRequest } from "@/features/api-keys/schemas";

const REFRESH = { refetchInterval: 30_000, refetchIntervalInBackground: false } as const;

export function useApiKeys() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const apiKeysQuery = useQuery({ queryKey: ["api-keys", "list"], queryFn: listApiKeys, ...REFRESH });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
  };
  const fail = (fallback: string) => (error: Error) => {
    toast.error(error.message || t(fallback));
  };

  const createMutation = useMutation({
    mutationFn: (payload: ApiKeyCreateRequest) => createApiKey(payload),
    onSuccess: () => {
      toast.success(t("apiKeys.toasts.created"));
      invalidate();
    },
    onError: fail("apiKeys.toasts.createFailed"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ keyId, payload }: { keyId: string; payload: ApiKeyUpdateRequest }) => updateApiKey(keyId, payload),
    onSuccess: () => {
      toast.success(t("apiKeys.toasts.updated"));
      invalidate();
    },
    onError: fail("apiKeys.toasts.updateFailed"),
  });

  const deleteMutation = useMutation({
    mutationFn: (keyId: string) => deleteApiKey(keyId),
    onSuccess: (_, keyId) => {
      toast.success(t("apiKeys.toasts.deleted"));
      // Drop the deleted key first, or its still-mounted trends query refetches into a 404.
      queryClient.setQueryData<ApiKey[]>(["api-keys", "list"], (keys) => keys?.filter((key) => key.id !== keyId));
      queryClient.removeQueries({ queryKey: ["api-keys", "trends", keyId] });
      void queryClient.invalidateQueries({
        queryKey: ["api-keys"],
        predicate: (query) => !(query.queryKey[1] === "trends" && query.queryKey[2] === keyId),
      });
    },
    onError: fail("apiKeys.toasts.deleteFailed"),
  });

  const regenerateMutation = useMutation({
    mutationFn: (keyId: string) => regenerateApiKey(keyId),
    onSuccess: () => {
      toast.success(t("apiKeys.toasts.regenerated"));
      invalidate();
    },
    onError: fail("apiKeys.toasts.regenerateFailed"),
  });

  return { apiKeysQuery, createMutation, updateMutation, deleteMutation, regenerateMutation };
}

export function useKeysOverview() {
  return useQuery({ queryKey: ["api-keys", "overview"], queryFn: getKeysOverview, ...REFRESH });
}

export function useApiKeyTrends(keyId: string | null) {
  return useQuery({
    queryKey: ["api-keys", "trends", keyId],
    queryFn: () => getApiKeyTrends(keyId!),
    enabled: !!keyId,
    staleTime: 60_000,
    refetchInterval: 2 * 60_000,
    refetchIntervalInBackground: false,
  });
}
