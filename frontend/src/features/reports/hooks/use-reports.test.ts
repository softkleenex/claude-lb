import { describe, expect, it } from "vitest";

import { DEFAULT_PRESET, parseReportState, writeReportState } from "./use-reports";

const NOW = new Date("2026-01-31T12:00:00Z");

describe("report URL state", () => {
  it("defaults to the rolling 30-day preset grouped by day", () => {
    const state = parseReportState(new URLSearchParams(), NOW);
    expect(state).toMatchObject({ preset: DEFAULT_PRESET, start: "2026-01-02", end: "2026-01-31", groupBy: "day" });
    expect(writeReportState(state).toString()).toBe("");
  });

  it("reads a preset, a grouping and multi-value filters", () => {
    const params = new URLSearchParams(
      "preset=7&groupBy=model&accountId=a&accountId=b&apiKeyId=k&model=m&userAgent=claude-cli",
    );
    const state = parseReportState(params, NOW);
    expect(state).toMatchObject({
      preset: 7,
      start: "2026-01-25",
      groupBy: "model",
      accountIds: ["a", "b"],
      apiKeyIds: ["k"],
      models: ["m"],
      userAgents: ["claude-cli"],
    });
    expect(writeReportState(state).toString()).toBe(params.toString());
  });

  it("keeps a fixed range, even an invalid one, so the page can explain it", () => {
    const state = parseReportState(new URLSearchParams("start=2026-01-10&end=2026-01-05"), NOW);
    expect(state).toMatchObject({ preset: null, start: "2026-01-10", end: "2026-01-05" });
    expect(writeReportState(state).toString()).toBe("start=2026-01-10&end=2026-01-05");
  });

  it("ignores an unknown grouping and preset", () => {
    const state = parseReportState(new URLSearchParams("groupBy=colour&preset=12"), NOW);
    expect(state.groupBy).toBe("day");
    expect(state.preset).toBe(DEFAULT_PRESET);
  });

  it("leaves unrelated params alone", () => {
    const base = new URLSearchParams("selected=x&model=old");
    const state = parseReportState(base, NOW);
    expect(writeReportState({ ...state, models: ["new"] }, base).toString()).toBe("selected=x&model=new");
  });
});
