import { Pencil, Shield, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { AlertMessage } from "@/components/alert-message";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SpinnerBlock } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatAbsolute } from "@/features/accounts/lib/time";
import { checkFirewallEntry } from "@/features/firewall/api";
import { useFirewall } from "@/features/firewall/hooks/use-firewall";
import type { FirewallEntry, FirewallMode } from "@/features/firewall/schemas";
import { SettingsCard } from "@/features/settings/components/settings-card";
import { cn } from "@/lib/utils";
import { getErrorMessageOrNull } from "@/utils/errors";

const HEAD = "text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80";

type Confirm =
  | { kind: "mode"; mode: FirewallMode }
  | { kind: "add"; network: string; note: string }
  | { kind: "remove"; entry: FirewallEntry };

export type FirewallSettingsProps = {
  canWrite: boolean;
};

/**
 * IP allowlist for the proxy (`/v1/*`). The dashboard is never firewalled — it has its
 * own password — so a wrong entry cannot lock the operator out of fixing it.
 */
export function FirewallSettings({ canWrite }: FirewallSettingsProps) {
  const { t } = useTranslation();
  const { firewallQuery, setMode, add, updateNote, remove, busy } = useFirewall();
  const [network, setNetwork] = useState("");
  const [note, setNote] = useState("");
  const [checking, setChecking] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [editing, setEditing] = useState<{ id: string; note: string } | null>(null);
  const state = firewallQuery.data;
  const disabled = !canWrite || busy || checking;

  const submitAdd = async () => {
    const value = network.trim();
    if (!value || !state) return;
    setInputError(null);
    setChecking(true);
    try {
      const check = await checkFirewallEntry(value);
      // Warn before an allowlist leaves this machine's own proxy clients outside.
      if (state.mode === "allowlist" && !check.clientAllowedAfter) {
        setConfirm({ kind: "add", network: check.network, note: note.trim() });
        return;
      }
      await doAdd(check.network, note.trim());
    } catch (error) {
      setInputError(getErrorMessageOrNull(error));
    } finally {
      setChecking(false);
    }
  };

  const doAdd = async (value: string, entryNote: string) => {
    await add.mutateAsync({ network: value, note: entryNote });
    setNetwork("");
    setNote("");
  };

  const requestMode = (mode: FirewallMode) => {
    if (!state || mode === state.mode) return;
    setConfirm({ kind: "mode", mode });
  };

  const confirmText = (): { title: string; description: string; warning?: string } => {
    if (!confirm || !state) return { title: "", description: "" };
    if (confirm.kind === "mode") {
      if (confirm.mode === "allow_all") {
        return { title: t("firewall.confirm.allowAllTitle"), description: t("firewall.confirm.allowAllBody") };
      }
      return {
        title: t("firewall.confirm.allowlistTitle"),
        description: t("firewall.confirm.allowlistBody", { count: state.entries.length }),
        warning:
          state.entries.length === 0
            ? t("firewall.warning.emptyAllowlist")
            : !state.clientCovered
              ? t("firewall.warning.selfNotCovered", { ip: state.clientIp })
              : undefined,
      };
    }
    if (confirm.kind === "add") {
      return {
        title: t("firewall.confirm.addTitle", { network: confirm.network }),
        description: t("firewall.confirm.addBody"),
        warning: t("firewall.warning.selfNotCovered", { ip: state.clientIp }),
      };
    }
    const lastCover =
      state.mode === "allowlist" &&
      confirm.entry.coversClient &&
      state.entries.filter((entry) => entry.coversClient).length === 1;
    return {
      title: t("firewall.confirm.removeTitle", { network: confirm.entry.network }),
      description:
        state.mode === "allowlist" ? t("firewall.confirm.removeBodyActive") : t("firewall.confirm.removeBodyIdle"),
      warning: lastCover ? t("firewall.warning.selfRemoved", { ip: state.clientIp }) : undefined,
    };
  };

  const onConfirm = () => {
    if (!confirm) return;
    const current = confirm;
    setConfirm(null);
    if (current.kind === "mode") setMode.mutate(current.mode);
    else if (current.kind === "add") void doAdd(current.network, current.note).catch(() => undefined);
    else remove.mutate(current.entry.id);
  };

  const text = confirmText();
  const loadError = getErrorMessageOrNull(firewallQuery.error);

  return (
    <SettingsCard id="firewall" icon={Shield} title={t("firewall.title")} description={t("firewall.description")}>
      {loadError && !state ? <AlertMessage variant="error">{loadError}</AlertMessage> : null}
      {!state ? (
        loadError ? null : <SpinnerBlock />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t("firewall.mode.label")}</p>
              <p className="text-xs text-muted-foreground">
                {state.mode === "allowlist" ? t("firewall.mode.allowlistHelp") : t("firewall.mode.allowAllHelp")}
              </p>
            </div>
            <div className="inline-flex shrink-0 rounded-lg border p-0.5" role="radiogroup" aria-label={t("firewall.mode.label")}>
              {(["allow_all", "allowlist"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={state.mode === mode}
                  disabled={disabled}
                  onClick={() => requestMode(mode)}
                  className={cn(
                    "rounded-md px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                    state.mode === mode ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {mode === "allowlist" ? t("firewall.mode.allowlist") : t("firewall.mode.allowAll")}
                </button>
              ))}
            </div>
          </div>

          <p className="text-xs text-muted-foreground" data-testid="firewall-client">
            {t("firewall.client", { ip: state.clientIp || "?" })}{" "}
            <Badge variant={state.clientAllowed ? "secondary" : "destructive"} className="ml-1 align-middle">
              {state.clientAllowed ? t("firewall.clientAllowed") : t("firewall.clientBlocked")}
            </Badge>
          </p>
          {state.mode === "allowlist" && state.entries.length === 0 ? (
            <AlertMessage variant="warning">{t("firewall.warning.emptyAllowlist")}</AlertMessage>
          ) : null}
          <p className="text-xs text-muted-foreground">{t("firewall.scopeNote")}</p>

          {canWrite ? (
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(event) => {
                event.preventDefault();
                void submitAdd();
              }}
            >
              <Input
                id="firewall-network"
                name="firewall-network"
                value={network}
                onChange={(event) => {
                  setNetwork(event.target.value);
                  setInputError(null);
                }}
                placeholder={t("firewall.add.networkPlaceholder")}
                aria-label={t("firewall.add.networkLabel")}
                className="h-8 font-mono text-xs sm:w-56"
                disabled={disabled}
              />
              <Input
                id="firewall-note"
                name="firewall-note"
                value={note}
                maxLength={255}
                onChange={(event) => setNote(event.target.value)}
                placeholder={t("firewall.add.notePlaceholder")}
                aria-label={t("firewall.add.noteLabel")}
                className="h-8 flex-1 text-xs"
                disabled={disabled}
              />
              <Button type="submit" size="sm" className="h-8 text-xs" disabled={disabled || !network.trim()}>
                {t("firewall.add.submit")}
              </Button>
            </form>
          ) : null}
          {inputError ? <AlertMessage variant="error">{inputError}</AlertMessage> : null}

          {state.entries.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
              {t("firewall.empty")}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className={HEAD}>{t("firewall.table.network")}</TableHead>
                    <TableHead className={HEAD}>{t("firewall.table.note")}</TableHead>
                    <TableHead className={HEAD}>{t("firewall.table.added")}</TableHead>
                    {canWrite ? <TableHead className={cn(HEAD, "w-[88px] text-right")}>{t("firewall.table.actions")}</TableHead> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {state.entries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="whitespace-nowrap font-mono text-xs">
                        {entry.network}
                        <span className="ml-2 text-[10px] text-muted-foreground">IPv{entry.version}</span>
                        {entry.coversClient ? (
                          <Badge variant="outline" className="ml-2 text-[10px]">
                            {t("firewall.table.you")}
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="min-w-[160px] text-xs">
                        {editing?.id === entry.id ? (
                          <form
                            className="flex gap-1.5"
                            onSubmit={(event) => {
                              event.preventDefault();
                              updateNote.mutate({ id: entry.id, note: editing.note });
                              setEditing(null);
                            }}
                          >
                            <Input
                              id={`firewall-note-${entry.id}`}
                              name="firewall-note-edit"
                              autoFocus
                              value={editing.note}
                              maxLength={255}
                              aria-label={t("firewall.add.noteLabel")}
                              onChange={(event) => setEditing({ id: entry.id, note: event.target.value })}
                              className="h-7 text-xs"
                            />
                            <Button type="submit" size="sm" className="h-7 text-xs">
                              {t("common.actions.save")}
                            </Button>
                            <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditing(null)}>
                              {t("common.cancel")}
                            </Button>
                          </form>
                        ) : (
                          <span className={entry.note ? "" : "text-muted-foreground"}>{entry.note || "—"}</span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatAbsolute(entry.createdAt)}
                      </TableCell>
                      {canWrite ? (
                        <TableCell className="text-right whitespace-nowrap">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0"
                            aria-label={t("firewall.table.editNote", { network: entry.network })}
                            disabled={disabled}
                            onClick={() => setEditing({ id: entry.id, note: entry.note })}
                          >
                            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                            aria-label={t("firewall.table.remove", { network: entry.network })}
                            disabled={disabled}
                            onClick={() => setConfirm({ kind: "remove", entry })}
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </Button>
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={text.title}
        description={text.description}
        confirmLabel={
          confirm?.kind === "remove"
            ? t("firewall.confirm.remove")
            : confirm?.kind === "add"
              ? t("firewall.confirm.addAnyway")
              : t("common.confirm")
        }
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        onConfirm={onConfirm}
      >
        {text.warning ? <AlertMessage variant="warning">{text.warning}</AlertMessage> : null}
      </ConfirmDialog>
    </SettingsCard>
  );
}
