import { describe, expect, it } from "vitest";

import i18n from "@/i18n";
import { DashboardOverviewSchema } from "@/features/dashboard/schemas";
import {
  buildStats,
  comparePoints,
  compareValues,
  formatHours,
  formatMs,
  formatRatio,
  formatUsd,
  toIso,
} from "@/features/dashboard/utils";
import { camelizeKeys } from "@/lib/casing";
import { createDashboardOverviewWire } from "@/test/mocks/factories";

const t = i18n.t.bind(i18n);

describe("dashboard formatters", () => {
  it("formats USD with precision that suits per-request amounts", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(0.123)).toBe("$0.123");
    expect(formatUsd(1204.5)).toBe("$1,204.50");
    expect(formatUsd(null)).toBe("—");
  });

  it("formats ratios, durations and pacing hours", () => {
    expect(formatRatio(0.8412)).toBe("84.1%");
    expect(formatMs(640)).toBe("640 ms");
    expect(formatMs(2400)).toBe("2.40 s");
    expect(formatMs(null)).toBe("—");
    expect(formatHours(0.5)).toBe("30m");
    expect(formatHours(21.5)).toBe("21h 30m");
    expect(formatHours(50)).toBe("2d 2h");
  });

  it("reads naive server timestamps as UTC", () => {
    expect(toIso("2026-01-01T12:00:00")).toBe("2026-01-01T12:00:00.000Z");
    expect(toIso(null)).toBeNull();
  });
});

describe("period-over-period comparisons", () => {
  it("percent change with tone depending on direction", () => {
    expect(compareValues(120, 100, true, null, t)).toEqual({ text: "+20%", tone: "neutral" });
    expect(compareValues(90, 100, true, false, t)).toEqual({ text: "−10%", tone: "positive" });
    expect(compareValues(110, 100, true, false, t)).toEqual({ text: "+10%", tone: "negative" });
    expect(compareValues(5, 0, true, null, t)).toEqual({ text: "new", tone: "neutral" });
    expect(compareValues(5, 3, false, null, t)).toBeNull();
  });

  it("rate change in percentage points", () => {
    expect(comparePoints(0.84, 0.8, true, true)).toEqual({ text: "+4.0pp", tone: "positive" });
    expect(comparePoints(0.03, 0.01, true, false)).toEqual({ text: "+2.0pp", tone: "negative" });
    expect(comparePoints(0.1, 0.1, true, false)).toEqual({ text: "±0pp", tone: "neutral" });
  });
});

describe("buildStats", () => {
  it("builds six cards with sparklines from the claude-lb overview", () => {
    const overview = DashboardOverviewSchema.parse(camelizeKeys(createDashboardOverviewWire("24h")));
    const stats = buildStats(overview, t, {
      primary: "#000",
      info: "#111",
      success: "#222",
      danger: "#333",
      muted: "#444",
    });
    expect(stats.map((stat) => stat.id)).toEqual([
      "requests",
      "tokens",
      "cost",
      "savings",
      "errors",
      "conversations",
    ]);
    expect(stats.every((stat) => stat.trend.length === 24)).toBe(true);
    expect(stats[1].meta).toBe("In 540K · Out 960K · Cached 14M");
    expect(stats[5].meta).toBe("8.6 requests per conversation");
  });

  it("omits deltas when the previous window had no traffic", () => {
    const overview = DashboardOverviewSchema.parse(
      camelizeKeys(createDashboardOverviewWire("1h", { can_compare: false })),
    );
    const stats = buildStats(overview, t, { primary: "", info: "", success: "", danger: "", muted: "" });
    expect(stats.every((stat) => stat.comparison === null)).toBe(true);
  });
});
