import { describe, expect, it } from "vitest";

import { MAX_REPORT_DAYS, dateRangeProblem, daysAgoUtcISO, isISODate, rangeDays, utcDateISO } from "./date";

describe("report dates (UTC)", () => {
  const now = new Date("2026-03-01T23:30:00-05:00"); // 2026-03-02 04:30 UTC

  it("uses the UTC calendar day", () => {
    expect(utcDateISO(now)).toBe("2026-03-02");
    expect(daysAgoUtcISO(6, now)).toBe("2026-02-24");
  });

  it("validates ISO dates strictly", () => {
    expect(isISODate("2026-02-28")).toBe(true);
    expect(isISODate("2026-02-30")).toBe(false);
    expect(isISODate("")).toBe(false);
    expect(isISODate("03/01/2026")).toBe(false);
  });

  it("counts days inclusively", () => {
    expect(rangeDays("2026-01-01", "2026-01-01")).toBe(1);
    expect(rangeDays("2026-01-01", "2026-01-31")).toBe(31);
    expect(rangeDays("", "2026-01-31")).toBeNull();
  });

  it("names the problem with a range", () => {
    expect(dateRangeProblem("2026-01-01", "2026-01-07")).toBeNull();
    expect(dateRangeProblem("2026-01-08", "2026-01-07")).toBe("reversed");
    expect(dateRangeProblem("", "2026-01-07")).toBe("invalid");
    expect(dateRangeProblem("2024-01-01", "2026-01-07")).toBe("tooLong");
    expect(rangeDays("2025-01-01", "2026-01-01")).toBe(MAX_REPORT_DAYS);
    expect(dateRangeProblem("2025-01-01", "2026-01-01")).toBeNull();
  });
});
