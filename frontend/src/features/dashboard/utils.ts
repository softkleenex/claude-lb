import type { TFunction } from "i18next";
import {
  Activity,
  AlertTriangle,
  Coins,
  DatabaseZap,
  DollarSign,
  MessagesSquare,
  type LucideIcon,
} from "lucide-react";

import { formatDuration } from "@/features/accounts/lib/time";
import type { DashboardOverview, TrendBucket } from "@/features/dashboard/schemas";
import { formatCompactNumber } from "@/utils/formatters";
import { parseServerDate } from "@/utils/server-date";

export type StatComparison = { text: string; tone: "positive" | "negative" | "neutral" };

export type DashboardStat = {
  id: string;
  label: string;
  value: string;
  meta?: string;
  icon: LucideIcon;
  trend: { value: number }[];
  trendColor: string;
  comparison?: StatComparison | null;
};

const usdFormatters = new Map<number, Intl.NumberFormat>();

function usdFormatter(digits: number): Intl.NumberFormat {
  let formatter = usdFormatters.get(digits);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: digits,
    });
    usdFormatters.set(digits, formatter);
  }
  return formatter;
}

/** USD with enough precision for per-request amounts: $0.0042, $1.27, $1,204.50. */
export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs === 0) return "$0.00";
  if (abs < 0.01) return usdFormatter(4).format(value);
  if (abs < 1) return usdFormatter(3).format(value);
  return usdFormatter(2).format(value);
}

export function formatRatio(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** Head and tail of a conversation key ("3f9a1c0b…e4d2"): enough to tell conversations apart. */
export function shortConversationKey(key: string): string {
  return key.length > 14 ? `${key.slice(0, 8)}…${key.slice(-4)}` : key;
}

/** "850 ms", "42.0 s", then "3m", "1h 5m" — conversations run from seconds to hours. */
export function formatConversationDuration(ms: number): string {
  if (ms <= 0) return "—";
  if (ms < 60_000) return formatMs(ms);
  return formatDuration(ms);
}

/** ISO string with an explicit offset, so shared formatters read naive UTC correctly. */
export function toIso(value: string | null | undefined): string | null {
  return parseServerDate(value)?.toISOString() ?? null;
}

/**
 * Period-over-period change as "+12%" / "−3%". `higherIsBetter` decides the tone;
 * returns null when there is nothing to compare against.
 */
export function compareValues(
  current: number,
  previous: number,
  canCompare: boolean,
  higherIsBetter: boolean | null,
  t: TFunction,
): StatComparison | null {
  if (!canCompare) return null;
  if (previous === 0) {
    return current === 0 ? { text: "±0%", tone: "neutral" } : { text: t("dashboard.stats.new"), tone: "neutral" };
  }
  const change = (current - previous) / Math.abs(previous);
  const rounded = Math.round(change * 100);
  if (rounded === 0) return { text: "±0%", tone: "neutral" };
  const text = `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)}%`;
  if (higherIsBetter === null) return { text, tone: "neutral" };
  const good = higherIsBetter ? rounded > 0 : rounded < 0;
  return { text, tone: good ? "positive" : "negative" };
}

/** Rate change in percentage points ("+1.2pp"), for error and cache-hit rates. */
export function comparePoints(
  current: number,
  previous: number,
  canCompare: boolean,
  higherIsBetter: boolean,
): StatComparison | null {
  if (!canCompare) return null;
  const delta = (current - previous) * 100;
  if (Math.abs(delta) < 0.05) return { text: "±0pp", tone: "neutral" };
  const text = `${delta > 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)}pp`;
  const good = higherIsBetter ? delta > 0 : delta < 0;
  return { text, tone: good ? "positive" : "negative" };
}

function series(trends: TrendBucket[], pick: (point: TrendBucket) => number) {
  return trends.map((point) => ({ value: pick(point) }));
}

export type StatColors = { primary: string; success: string; danger: string; muted: string; info: string };

export function buildStats(overview: DashboardOverview, t: TFunction, colors: StatColors): DashboardStat[] {
  const { current: cur, previous: prev, canCompare, trends } = overview;
  return [
    {
      id: "requests",
      label: t("dashboard.stats.requests"),
      value: formatCompactNumber(cur.requests),
      meta:
        cur.avgDurationMs != null
          ? t("dashboard.stats.requestsMeta", {
              latency: formatMs(cur.avgDurationMs),
              ttft: formatMs(cur.avgTtftMs),
            })
          : undefined,
      icon: Activity,
      trend: series(trends, (p) => p.requests),
      trendColor: colors.primary,
      comparison: compareValues(cur.requests, prev.requests, canCompare, null, t),
    },
    {
      id: "tokens",
      label: t("dashboard.stats.tokens"),
      value: formatCompactNumber(cur.totalTokens),
      meta: t("dashboard.stats.tokensMeta", {
        input: formatCompactNumber(cur.inputTokens),
        output: formatCompactNumber(cur.outputTokens),
        cached: formatCompactNumber(cur.cacheReadInputTokens),
      }),
      icon: Coins,
      trend: series(trends, (p) => p.tokens),
      trendColor: colors.info,
      comparison: compareValues(cur.totalTokens, prev.totalTokens, canCompare, null, t),
    },
    {
      id: "cost",
      label: t("dashboard.stats.cost"),
      value: formatUsd(cur.costUsd),
      meta: canCompare ? t("dashboard.stats.previousValue", { value: formatUsd(prev.costUsd) }) : undefined,
      icon: DollarSign,
      trend: series(trends, (p) => p.costUsd),
      trendColor: colors.primary,
      comparison: compareValues(cur.costUsd, prev.costUsd, canCompare, false, t),
    },
    {
      id: "savings",
      label: t("dashboard.stats.cacheSavings"),
      value: formatUsd(cur.cacheSavingsUsd),
      meta: t("dashboard.stats.cacheHitRate", { rate: formatRatio(cur.cacheHitRate) }),
      icon: DatabaseZap,
      trend: series(trends, (p) => p.cacheSavingsUsd),
      trendColor: colors.success,
      comparison: comparePoints(cur.cacheHitRate, prev.cacheHitRate, canCompare, true),
    },
    {
      id: "errors",
      label: t("dashboard.stats.errorRate"),
      value: formatRatio(cur.errorRate),
      meta: cur.topError
        ? t("dashboard.stats.topError", { error: cur.topError, count: cur.topErrorCount })
        : t("dashboard.stats.errorCount", { count: cur.errors }),
      icon: AlertTriangle,
      trend: series(trends, (p) => p.errorRate),
      trendColor: colors.danger,
      comparison: comparePoints(cur.errorRate, prev.errorRate, canCompare, false),
    },
    {
      id: "conversations",
      label: t("dashboard.stats.conversations"),
      value: formatCompactNumber(cur.conversations),
      meta:
        cur.conversations > 0
          ? t("dashboard.stats.conversationsMeta", {
              perConversation: (cur.requests / cur.conversations).toFixed(1),
            })
          : undefined,
      icon: MessagesSquare,
      trend: series(trends, (p) => p.conversations),
      trendColor: colors.muted,
      comparison: compareValues(cur.conversations, prev.conversations, canCompare, null, t),
    },
  ];
}

/** "2d 4h", "3h 20m", "45m" — compact and language-neutral, for pacing durations. */
export function formatHours(hours: number): string {
  const totalMinutes = Math.max(1, Math.ceil(hours * 60));
  const days = Math.floor(totalMinutes / 1440);
  const h = Math.floor((totalMinutes % 1440) / 60);
  const m = totalMinutes % 60;
  if (days > 0) return h > 0 ? `${days}d ${h}h` : `${days}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}
