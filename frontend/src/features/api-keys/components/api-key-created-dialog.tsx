import { useTranslation } from "react-i18next";

import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { claudeCodeEnv } from "@/features/api-keys/lib";

export type CreatedKey = {
  name: string;
  secret: string;
  regenerated: boolean;
};

export type ApiKeyCreatedDialogProps = {
  open: boolean;
  created: CreatedKey | null;
  onOpenChange: (open: boolean) => void;
  /** Base URL clients should use; defaults to this dashboard's origin. */
  origin?: string;
};

function Snippet({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <CopyButton value={value} />
      </div>
      <pre
        className="max-w-full overflow-x-auto rounded-lg border bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed"
        data-testid={testId}
      >
        {value}
      </pre>
    </div>
  );
}

export function ApiKeyCreatedDialog({ open, created, onOpenChange, origin }: ApiKeyCreatedDialogProps) {
  const { t } = useTranslation();
  const baseUrl = origin ?? window.location.origin;
  const env = created ? claudeCodeEnv(baseUrl, created.secret) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {created?.regenerated ? t("apiKeys.createdDialog.regeneratedTitle") : t("apiKeys.createdDialog.title")}
          </DialogTitle>
          <DialogDescription>
            {created?.regenerated
              ? t("apiKeys.createdDialog.regeneratedDescription", { name: created.name })
              : t("apiKeys.createdDialog.description")}
          </DialogDescription>
        </DialogHeader>

        {created && env ? (
          <div className="min-w-0 space-y-4">
            <div className="min-w-0 space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">{t("apiKeys.createdDialog.keyLabel")}</p>
              <div className="flex min-w-0 items-center gap-2 overflow-hidden rounded-lg border bg-muted/20 px-3 py-2">
                <p className="min-w-0 flex-1 truncate font-mono text-xs" data-testid="created-api-key">
                  {created.secret}
                </p>
                <CopyButton value={created.secret} />
              </div>
            </div>
            <div className="space-y-3 rounded-lg border p-3">
              <div>
                <p className="text-sm font-medium">{t("apiKeys.createdDialog.claudeCodeTitle")}</p>
                <p className="text-xs text-muted-foreground">{t("apiKeys.createdDialog.claudeCodeDescription")}</p>
              </div>
              <Snippet label={t("apiKeys.createdDialog.shell")} value={env.shell} testId="claude-code-shell" />
              <Snippet
                label={t("apiKeys.createdDialog.settingsJson")}
                value={env.settingsJson}
                testId="claude-code-settings"
              />
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("apiKeys.createdDialog.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
