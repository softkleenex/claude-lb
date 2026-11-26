import { describe, expect, it } from "vitest";

import {
  DEFAULT_FILTER_STATE,
  parseFilterState,
  requestLogFiltersApplied,
  writeFilterState,
} from "@/features/dashboard/hooks/use-request-logs";

describe("request-log filter state in the URL", () => {
  it("round-trips every filter and keeps unrelated params", () => {
    const state = {
      ...DEFAULT_FILTER_STATE,
      search: "overloaded",
      timeframe: "7d" as const,
      accountIds: ["acc_a", "acc_b"],
      apiKeyIds: ["key_1"],
      models: ["claude-opus-5-5"],
      statuses: ["overloaded", "rate_limited"],
      sessionKey: "abc",
      limit: 50,
      offset: 100,
    };
    const params = writeFilterState(state, new URLSearchParams("window=7d"));
    expect(params.get("window")).toBe("7d");
    expect(params.getAll("accountId")).toEqual(["acc_a", "acc_b"]);
    expect(params.get("session")).toBe("abc");
    expect(parseFilterState(params)).toEqual(state);
  });

  it("omits defaults from the URL", () => {
    expect(writeFilterState(DEFAULT_FILTER_STATE).toString()).toBe("");
    expect(requestLogFiltersApplied(DEFAULT_FILTER_STATE)).toBe(false);
  });

  it("falls back to defaults for invalid values", () => {
    expect(parseFilterState(new URLSearchParams("timeframe=2y&limit=-3"))).toEqual(DEFAULT_FILTER_STATE);
  });

  it("counts a conversation filter as applied", () => {
    expect(requestLogFiltersApplied({ ...DEFAULT_FILTER_STATE, sessionKey: "k" })).toBe(true);
  });
});
