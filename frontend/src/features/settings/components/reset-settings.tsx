import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/features/settings/components/settings-card";

export type ResetSettingsProps = {
  disabled: boolean;
  onReset: () => void;
};

/** `POST /api/settings/reset`: drop every stored override, back to the env defaults. */
export function ResetSettings({ disabled, onReset }: ResetSettingsProps) {
  const { t } = useTranslation();

  return (
    <SettingsCard
      id="reset"
      icon={RotateCcw}
      title={t("settings.reset.title")}
      description={t("settings.reset.description")}
      actions={
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 text-xs text-destructive hover:text-destructive"
              disabled={disabled}
            >
              {t("settings.reset.action")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("settings.reset.confirmTitle")}</AlertDialogTitle>
              <AlertDialogDescription>{t("settings.reset.confirmDescription")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
              <AlertDialogAction onClick={onReset}>{t("settings.reset.confirmAction")}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      }
    />
  );
}
