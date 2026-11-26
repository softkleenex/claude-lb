import { Gauge } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import type { WeeklyPace } from "@/features/dashboard/schemas";
import { formatHours } from "@/features/dashboard/utils";
import { cn } from "@/lib/utils";
import { formatCompactNumber } from "@/utils/formatters";

// Ported from codex-lb's weekly-credits-pace-card.tsx (MIT); the math runs server-side
// (claude_lb/modules/dashboard/pace.py), this card only words it.

export type WeeklyCreditsPaceCardProps = {
  pace: WeeklyPace | null;
};

function percent(value: number): string {
  return `${Math.round(value)}%`;
}

function proEquivalent(value: number): string {
  if (value < 1) return value >= 0.1 ? value.toFixed(2) : value.toFixed(3);
  return value < 10 ? value.toFixed(1) : value.toFixed(0);
}

function paceStatusLabel(pace: WeeklyPace, t: TFunction): string {
  const delta = pace.smoothedDeltaPercent;
  if (pace.status === "on_track") return t("dashboard.weeklyPace.status.onPace");
  if (pace.status === "danger" && pace.projectedShortfallCredits > 0 && delta <= 0) {
    return t("dashboard.weeklyPace.status.recentBurnShortfall");
  }
  return delta > 0
    ? t("dashboard.weeklyPace.status.overPlanned", { percent: percent(Math.abs(delta)) })
    : t("dashboard.weeklyPace.status.belowPlanned", { percent: percent(Math.abs(delta)) });
}

function scheduleGapLine(pace: WeeklyPace, t: TFunction): string {
  const window = formatHours(pace.smoothingMinutes / 60);
  if (pace.smoothedScheduleGapCredits > 0) {
    return t("dashboard.weeklyPace.lines.overPlanned", {
      credits: formatCompactNumber(pace.smoothedScheduleGapCredits),
      window,
    });
  }
  if (pace.smoothedDeltaPercent < 0) {
    return t("dashboard.weeklyPace.lines.belowPlanned", {
      percent: percent(Math.abs(pace.smoothedDeltaPercent)),
      window,
    });
  }
  return t("dashboard.weeklyPace.lines.onSchedule");
}

function forecastLine(pace: WeeklyPace, t: TFunction): string {
  if (pace.projectedShortfallCredits > 0) {
    return pace.projectedDepletionHours !== null
      ? t("dashboard.weeklyPace.lines.projectedShortfallIn", {
          credits: formatCompactNumber(pace.projectedShortfallCredits),
          duration: formatHours(pace.projectedDepletionHours),
        })
      : t("dashboard.weeklyPace.lines.projectedShortfall", {
          credits: formatCompactNumber(pace.projectedShortfallCredits),
        });
  }
  if (pace.forecastBurnRateCreditsPerHour === null) return t("dashboard.weeklyPace.lines.noRecentBurn");
  if (pace.forecastBurnRateCreditsPerHour === 0) return t("dashboard.weeklyPace.lines.noShortfall");
  return t("dashboard.weeklyPace.lines.lowWaterMark", {
    credits: formatCompactNumber(pace.projectedMinimumRemainingCredits),
  });
}

function recommendations(pace: WeeklyPace, t: TFunction): Array<{ label: string; value: string }> {
  if (pace.projectedShortfallCredits <= 0) return [];
  const rows: Array<{ label: string; value: string }> = [];
  rows.push({
    label: t("dashboard.weeklyPace.recommendations.pause"),
    value:
      pace.pauseForBreakEvenHours !== null
        ? t("dashboard.weeklyPace.recommendations.pauseFor", { duration: formatHours(pace.pauseForBreakEvenHours) })
        : t("dashboard.weeklyPace.recommendations.untilReset"),
  });
  if (pace.reduceByPercent !== null) {
    rows.push({
      label: t("dashboard.weeklyPace.recommendations.throttleLabel"),
      value: t("dashboard.weeklyPace.recommendations.throttle", { percent: `~${Math.round(pace.reduceByPercent)}%` }),
    });
  }
  if (pace.proAccountsToCover !== null && pace.proAccountEquivalent !== null) {
    rows.push({
      label: t("dashboard.weeklyPace.recommendations.addCapacity"),
      value: t("dashboard.weeklyPace.recommendations.proAccounts", {
        count: pace.proAccountsToCover,
        equivalent: proEquivalent(pace.proAccountEquivalent),
      }),
    });
  }
  return rows;
}

const STATUS_CLASS: Record<WeeklyPace["status"], string> = {
  danger: "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300",
  ahead: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  behind: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  on_track: "border-border bg-muted/40 text-muted-foreground",
};

export function WeeklyCreditsPaceCard({ pace }: WeeklyCreditsPaceCardProps) {
  const { t } = useTranslation();
  if (!pace) return null;

  const actualWidth = Math.max(0, Math.min(100, pace.actualUsedPercent));
  const markerLeft = Math.max(0, Math.min(100, pace.scheduledUsedPercent));
  const barClass = pace.status === "danger" ? "bg-red-500" : pace.status === "ahead" ? "bg-amber-500" : "bg-primary";
  const rows = recommendations(pace, t);

  return (
    <section className="min-w-0 rounded-xl border bg-card p-5" aria-label={t("dashboard.weeklyPace.title")}>
      <div className="mb-4 flex justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{t("dashboard.weeklyPace.title")}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("dashboard.weeklyPace.subtitle", {
              count: pace.accountCount,
              confidence: t(`dashboard.weeklyPace.confidence.${pace.confidence}`),
            })}
          </p>
        </div>
        <div
          className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border", STATUS_CLASS[pace.status])}
          data-testid="weekly-pace-status"
          data-status={pace.status}
        >
          <Gauge className="h-4 w-4" aria-hidden="true" />
        </div>
      </div>

      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="min-w-0 rounded-md bg-muted/30 px-2.5 py-2">
            <p className="truncate text-muted-foreground">{t("dashboard.weeklyPace.usedNow")}</p>
            <p className="mt-1 text-sm font-semibold tabular-nums">{percent(pace.actualUsedPercent)}</p>
          </div>
          <div className="min-w-0 rounded-md bg-muted/30 px-2.5 py-2">
            <p className="truncate text-muted-foreground">{t("dashboard.weeklyPace.scheduledByNow")}</p>
            <p className="mt-1 text-sm font-semibold tabular-nums">{percent(pace.scheduledUsedPercent)}</p>
          </div>
          <div className="min-w-0 rounded-md bg-muted/30 px-2.5 py-2">
            <p className="truncate text-muted-foreground">{t("dashboard.weeklyPace.paceGap")}</p>
            <p className="mt-1 text-sm font-semibold" data-testid="weekly-pace-label">
              {paceStatusLabel(pace, t)}
            </p>
          </div>
        </div>
        <div className="relative h-1.5 rounded-full bg-muted">
          <div className={cn("h-full rounded-full", barClass)} style={{ width: `${actualWidth}%` }} />
          <div
            className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-full bg-foreground/70"
            style={{ left: `${markerLeft}%` }}
            data-testid="weekly-pace-marker"
          />
        </div>
        <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className={cn("h-1.5 w-4 rounded-full", barClass)} />
            {t("dashboard.weeklyPace.actual")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-0.5 rounded-full bg-foreground/70" />
            {t("dashboard.weeklyPace.scheduleMarker")}
          </span>
        </div>
        <div className="rounded-lg border bg-background/60 px-3 py-2 text-xs text-muted-foreground">
          <p>{scheduleGapLine(pace, t)}</p>
          <p className="mt-1">{forecastLine(pace, t)}</p>
          {pace.paceMultiplier !== null ? (
            <p className="mt-1">
              {t("dashboard.weeklyPace.lines.paceMultiplier", { multiplier: pace.paceMultiplier.toFixed(1) })}
            </p>
          ) : null}
        </div>

        {rows.length > 0 ? (
          <div className="rounded-lg border bg-background/60 px-3 py-2 text-xs" data-testid="weekly-pace-recommendations">
            <p className="font-medium">{t("dashboard.weeklyPace.recommendations.title")}</p>
            <div className="mt-2 grid gap-1.5">
              {rows.map((row) => (
                <div key={row.label} className="flex items-baseline justify-between gap-3">
                  <span className="shrink-0 text-muted-foreground">{row.label}</span>
                  <span className="min-w-0 text-right tabular-nums">{row.value}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {pace.staleAccountCount > 0 ? (
          <p className="text-[11px] text-muted-foreground">
            {t("dashboard.weeklyPace.stale", { count: pace.staleAccountCount })}
          </p>
        ) : null}
      </div>
    </section>
  );
}
