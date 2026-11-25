import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowRightLeft, Tag } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { usePoolStatus } from "@/features/accounts/pool-status";
import { getHealth, getServiceReadiness } from "@/features/health/api";
import { useSettingsQuery } from "@/features/settings/hooks/use-settings";
import { routingStrategyLabelKey } from "@/features/settings/routing-labels";
import type { RuntimeSettings } from "@/features/settings/schemas";
import { useDateDisplayFormatStore } from "@/hooks/use-date-format";
import { formatTimeLong } from "@/utils/formatters";

const GITHUB_REPOSITORY_URL = "https://github.com/softkleenex/claude-lb";
const STATUS_REFRESH_INTERVAL_MS = 60_000;
/** Fallback when settings are unavailable; otherwise two probe intervals plus slack. */
const DEFAULT_USAGE_FRESHNESS_MS = 5 * 60_000;
export const STATUS_BAR_DEFAULT_HEIGHT_PX = 40;

export interface StatusBarProps {
  onHeightChange?: (height: number) => void;
}

function getRoutingLabel(t: TFunction, settings: Pick<RuntimeSettings, "routingStrategy" | "stickySessionsEnabled">): string {
  const key = routingStrategyLabelKey(settings.routingStrategy);
  const strategyLabel = key ? t(key) : settings.routingStrategy;
  // `single_account` ignores affinity on the server, so "+ sticky" would be misleading.
  if (settings.stickySessionsEnabled && settings.routingStrategy !== "single_account") {
    return t("statusBar.routingLabels.withSticky", {
      strategy: strategyLabel,
      sticky: t("statusBar.routingLabels.sticky"),
    });
  }
  return strategyLabel;
}

/**
 * Usage freshness: claude-lb refreshes an account's quota from the response headers of
 * every proxied request and from the periodic health probe. "Synced" means some account
 * was observed within two probe intervals.
 */
function usageFreshnessThresholdMs(settings: RuntimeSettings | undefined): number {
  if (!settings?.healthProbeEnabled) {
    return DEFAULT_USAGE_FRESHNESS_MS;
  }
  return Math.max(DEFAULT_USAGE_FRESHNESS_MS, settings.healthProbeIntervalSeconds * 2 * 1000 + 60_000);
}

export function StatusBar({ onHeightChange }: StatusBarProps = {}) {
  const { t } = useTranslation();
  const footerRef = useRef<HTMLElement>(null);
  const readinessQuery = useQuery({
    queryKey: ["health", "ready"],
    queryFn: getServiceReadiness,
    refetchInterval: STATUS_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const { data: health } = useQuery({
    queryKey: ["health", "live"],
    queryFn: getHealth,
    retry: false,
    staleTime: 60 * 60 * 1000,
  });
  const { data: pool } = usePoolStatus();
  const { data: settingsEnvelope } = useSettingsQuery();
  const settings = settingsEnvelope?.settings;

  const lastSyncAt = pool?.lastQuotaObservedAt ?? null;
  const dateDisplayFormat = useDateDisplayFormatStore((state) => state.dateDisplayFormat);
  const lastSync = formatTimeLong(lastSyncAt === null ? null : new Date(lastSyncAt).toISOString(), dateDisplayFormat);
  const freshnessMs = usageFreshnessThresholdMs(settings);
  const [isUsageSynced, setIsUsageSynced] = useState(false);
  useEffect(() => {
    function check() {
      setIsUsageSynced(lastSyncAt !== null && Date.now() - lastSyncAt < freshnessMs);
    }
    check();
    const id = setInterval(check, 10_000);
    return () => clearInterval(id);
  }, [lastSyncAt, freshnessMs]);

  const serviceReadiness = readinessQuery.isPending
    ? "checking"
    : !readinessQuery.isError && readinessQuery.data?.status === "ok"
      ? "ready"
      : "notReady";
  const serviceStatusLabel = t(`statusBar.${serviceReadiness}`);
  const usageStatusLabel =
    lastSyncAt === null ? t("statusBar.neverSynced") : t(isUsageSynced ? "statusBar.synced" : "statusBar.stale");
  const routingLabel = settings ? getRoutingLabel(t, settings) : "—";
  const currentVersion = health?.version ?? readinessQuery.data?.version ?? __APP_VERSION__;

  useLayoutEffect(() => {
    const footer = footerRef.current;
    if (!footer || !onHeightChange) {
      return;
    }

    const reportHeight = () => {
      onHeightChange(Math.max(STATUS_BAR_DEFAULT_HEIGHT_PX, footer.offsetHeight));
    };
    reportHeight();

    const observer = new ResizeObserver(reportHeight);
    observer.observe(footer);
    return () => observer.disconnect();
  }, [onHeightChange]);

  return (
    <footer
      ref={footerRef}
      className="fixed bottom-0 left-0 right-0 z-50 border-t border-white/[0.08] bg-background/50 px-4 py-2 shadow-[0_-1px_12px_rgba(0,0,0,0.06)] backdrop-blur-xl backdrop-saturate-[1.8] supports-[backdrop-filter]:bg-background/40 dark:shadow-[0_-1px_12px_rgba(0,0,0,0.25)]"
    >
      <div className="mx-auto flex w-full max-w-[1500px] items-center gap-4 text-xs text-muted-foreground">
        <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1">
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${
                serviceReadiness === "ready"
                  ? "bg-emerald-500"
                  : serviceReadiness === "checking"
                    ? "bg-amber-500"
                    : "bg-red-500"
              }`}
            />
            <span className="font-medium">{t("statusBar.serviceReady")}</span> <span>{serviceStatusLabel}</span>
          </span>
          {pool && pool.total > 0 ? (
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full ${isUsageSynced ? "bg-emerald-500" : "bg-amber-500"}`}
              />
              <span className="font-medium">{t("statusBar.usageSynced")}</span> <span>{usageStatusLabel}</span>
              {lastSyncAt !== null ? <> · {lastSync.time}</> : null}
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1.5">
            <ArrowRightLeft className="h-3 w-3" aria-hidden="true" />
            <span className="font-medium">{t("statusBar.routing")}</span> {routingLabel}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Tag className="h-3 w-3" aria-hidden="true" />
            <span className="font-medium">{t("statusBar.version")}</span> {currentVersion}
          </span>
        </div>
        <a
          aria-label={t("statusBar.repositoryLabel")}
          className="ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/70 text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          href={GITHUB_REPOSITORY_URL}
          rel="noreferrer"
          target="_blank"
          title="GitHub"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.63 7.63 0 0 1 8 3.86c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
        </a>
      </div>
    </footer>
  );
}
