import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";

import { AlertMessage } from "@/components/alert-message";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { ApiKeyCreatedDialog, type CreatedKey } from "@/features/api-keys/components/api-key-created-dialog";
import { ApiKeysOverview } from "@/features/api-keys/components/api-keys-overview";
import type { ApiKey, ApiKeyCreateRequest, ApiKeyUpdateRequest } from "@/features/api-keys/schemas";
import { ApiDetail } from "@/features/apis/components/api-detail";
import { ApiList } from "@/features/apis/components/api-list";
import { ApisSkeleton } from "@/features/apis/components/apis-skeleton";
import { useApiKeys, useApiKeyTrends, useKeysOverview } from "@/features/apis/hooks/use-apis";
import { useDialogState } from "@/hooks/use-dialog-state";
import { getErrorMessageOrNull } from "@/utils/errors";

const ApiKeyFormDialog = lazy(() =>
  import("@/features/api-keys/components/api-key-form-dialog").then((m) => ({ default: m.ApiKeyFormDialog })),
);

export function ApisPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { apiKeysQuery, createMutation, updateMutation, deleteMutation, regenerateMutation } = useApiKeys();
  const overviewQuery = useKeysOverview();

  // `editing === null` with the dialog open means "create".
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ApiKey | null>(null);
  const deleteDialog = useDialogState<ApiKey>();
  const regenerateDialog = useDialogState<ApiKey>();
  const createdDialog = useDialogState<CreatedKey>();

  const apiKeys = useMemo(() => apiKeysQuery.data ?? [], [apiKeysQuery.data]);
  const selectedKeyId = searchParams.get("selected");

  const handleSelectKey = useCallback(
    (keyId: string) => {
      const next = new URLSearchParams(searchParams);
      next.set("selected", keyId);
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  const selectedApiKey = useMemo(() => {
    if (apiKeys.length === 0) return null;
    return apiKeys.find((key) => key.id === selectedKeyId) ?? apiKeys[0];
  }, [apiKeys, selectedKeyId]);

  const trendsQuery = useApiKeyTrends(selectedApiKey?.id ?? null);

  const busy =
    createMutation.isPending || updateMutation.isPending || deleteMutation.isPending || regenerateMutation.isPending;
  const listError = getErrorMessageOrNull(apiKeysQuery.error);

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const handleCreate = async (payload: ApiKeyCreateRequest) => {
    const created = await createMutation.mutateAsync(payload);
    handleSelectKey(created.id);
    createdDialog.show({ name: created.name, secret: created.apiKey, regenerated: false });
  };

  const handleUpdate = async (apiKey: ApiKey, payload: ApiKeyUpdateRequest) => {
    await updateMutation.mutateAsync({ keyId: apiKey.id, payload });
  };

  return (
    <div className="animate-fade-in-up space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("apis.page.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("apis.page.subtitle")}</p>
      </div>

      {apiKeysQuery.isPending ? (
        <ApisSkeleton />
      ) : !apiKeysQuery.data ? (
        <div className="space-y-3 rounded-xl border bg-card p-4">
          <AlertMessage variant="error">{listError ?? t("apiKeys.toasts.loadFailed")}</AlertMessage>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void apiKeysQuery.refetch()}
            disabled={apiKeysQuery.isFetching}
          >
            {t("common.actions.retry")}
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          {overviewQuery.data ? <ApiKeysOverview overview={overviewQuery.data} /> : null}

          <div className="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
            <div className="min-w-0 rounded-xl border bg-card p-4">
              <ApiList
                apiKeys={apiKeys}
                selectedKeyId={selectedApiKey?.id ?? null}
                onSelect={handleSelectKey}
                onOpenCreate={openCreate}
              />
            </div>

            <ApiDetail
              apiKey={selectedApiKey}
              trends={trendsQuery.data}
              trendsLoading={trendsQuery.isPending}
              trendsError={getErrorMessageOrNull(trendsQuery.error)}
              busy={busy}
              onEdit={(apiKey) => {
                setEditing(apiKey);
                setFormOpen(true);
              }}
              onToggleEnabled={(apiKey) => {
                void updateMutation
                  .mutateAsync({ keyId: apiKey.id, payload: { enabled: !apiKey.enabled } })
                  .catch(() => null);
              }}
              onDelete={(apiKey) => deleteDialog.show(apiKey)}
              onRegenerate={(apiKey) => regenerateDialog.show(apiKey)}
            />
          </div>
        </div>
      )}

      <Suspense fallback={null}>
        <ApiKeyFormDialog
          open={formOpen}
          busy={busy}
          apiKey={editing}
          onOpenChange={setFormOpen}
          onCreate={handleCreate}
          onUpdate={handleUpdate}
        />
      </Suspense>

      <ApiKeyCreatedDialog
        open={createdDialog.open}
        created={createdDialog.data}
        onOpenChange={createdDialog.onOpenChange}
      />

      <ConfirmDialog
        open={regenerateDialog.open}
        title={t("apiKeys.regenerateDialog.title", { name: regenerateDialog.data?.name ?? "" })}
        description={t("apiKeys.regenerateDialog.description")}
        confirmLabel={t("apis.detail.regenerate")}
        onOpenChange={regenerateDialog.onOpenChange}
        onConfirm={() => {
          const target = regenerateDialog.data;
          if (!target) return;
          void regenerateMutation
            .mutateAsync(target.id)
            .then((result) => createdDialog.show({ name: result.name, secret: result.apiKey, regenerated: true }))
            .catch(() => null);
        }}
      />

      <ConfirmDialog
        open={deleteDialog.open}
        title={t("apiKeys.deleteDialog.title", { name: deleteDialog.data?.name ?? "" })}
        description={t("apiKeys.deleteDialog.description")}
        confirmLabel={t("common.actions.delete")}
        onOpenChange={deleteDialog.onOpenChange}
        onConfirm={() => {
          const target = deleteDialog.data;
          if (!target) return;
          void deleteMutation.mutateAsync(target.id).catch(() => null);
        }}
      />
    </div>
  );
}
