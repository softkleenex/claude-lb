import type { TFunction } from "i18next";

import { formatDuration } from "@/features/accounts/lib/time";
import type { ApiKey, LimitMetric, LimitRuleInput, LimitUsage, LimitWindow } from "@/features/api-keys/schemas";
import { formatCompactNumber, formatCurrency, formatNumber } from "@/utils/formatters";

export const WINDOW_PRESET_SECONDS: Record<Exclude<LimitWindow, "custom">, number> = {
  "5h": 5 * 3600,
  "7d": 7 * 86400,
  daily: 86400,
  weekly: 7 * 86400,
  monthly: 31 * 86400,
};

export const CALENDAR_WINDOWS: ReadonlySet<LimitWindow> = new Set(["daily", "weekly", "monthly"]);

export function formatLimitValue(metric: LimitMetric, value: number): string {
  if (metric === "cost_usd") return formatCurrency(value);
  if (metric === "requests") return formatNumber(value);
  return formatCompactNumber(value);
}

export function metricLabel(t: TFunction, metric: LimitMetric): string {
  return t(`apiKeys.metrics.${metric}`);
}

/** "Rolling 5h", "UTC day", "Rolling 2h 30m". */
export function windowLabel(t: TFunction, window: LimitWindow, windowSeconds: number): string {
  if (window === "custom") return t("apiKeys.windows.customRolling", { duration: formatDuration(windowSeconds * 1000) });
  return t(`apiKeys.windows.${window}`);
}

/** Colour for a used-% bar. */
export function usageTone(percent: number): string {
  if (percent >= 90) return "bg-red-500";
  if (percent >= 70) return "bg-amber-500";
  return "bg-primary";
}

/** The most used limit, which is what decides whether the key gets refused next. */
export function tightestLimit(apiKey: ApiKey): LimitUsage | null {
  let best: LimitUsage | null = null;
  for (const limit of apiKey.limits) {
    if (best === null || limit.usedPercent > best.usedPercent) best = limit;
  }
  return best;
}

export function limitToInput(limit: LimitUsage): LimitRuleInput {
  return {
    metric: limit.metric,
    window: limit.window,
    maxValue: limit.maxValue,
    windowSeconds: limit.window === "custom" ? limit.windowSeconds : null,
    modelFilter: limit.modelFilter,
  };
}

function ruleKey(rule: LimitRuleInput): string {
  return [
    rule.metric,
    rule.window,
    rule.window === "custom" ? String(rule.windowSeconds ?? "") : "",
    String(rule.maxValue),
    (rule.modelFilter ?? "").trim(),
  ].join("|");
}

/** Rules ready to send: positive amounts only, model filter trimmed, custom seconds only when custom. */
export function normalizeRules(rules: LimitRuleInput[]): LimitRuleInput[] {
  return rules
    .filter((rule) => Number.isFinite(rule.maxValue) && rule.maxValue > 0)
    .map((rule) => ({
      metric: rule.metric,
      window: rule.window,
      maxValue: rule.maxValue,
      windowSeconds: rule.window === "custom" ? (rule.windowSeconds ?? null) : null,
      modelFilter: rule.modelFilter?.trim() || null,
    }));
}

export function rulesChanged(initial: LimitRuleInput[], current: LimitRuleInput[]): boolean {
  const a = normalizeRules(initial).map(ruleKey);
  const b = normalizeRules(current).map(ruleKey);
  return a.length !== b.length || a.some((key, index) => key !== b[index]);
}

/** A rule the editor cannot submit: custom window without a length, or no amount. */
export function ruleProblem(rule: LimitRuleInput): "amount" | "window" | null {
  if (!Number.isFinite(rule.maxValue) || rule.maxValue <= 0) return "amount";
  if (rule.window === "custom" && (!rule.windowSeconds || rule.windowSeconds < 60)) return "window";
  return null;
}

export function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** The env vars Claude Code reads, as `claude-lb setup claude-code` prints them. */
export function claudeCodeEnv(origin: string, apiKey: string): { shell: string; settingsJson: string } {
  const env = { ANTHROPIC_BASE_URL: origin.replace(/\/+$/, ""), ANTHROPIC_API_KEY: apiKey };
  return {
    shell: Object.entries(env)
      .map(([name, value]) => `export ${name}=${value}`)
      .join("\n"),
    settingsJson: JSON.stringify({ env }, null, 2),
  };
}
