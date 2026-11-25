import { describe, expect, it } from "vitest";

import { parseServerDate } from "@/utils/server-date";

describe("parseServerDate", () => {
  it("treats naive timestamps as UTC", () => {
    expect(parseServerDate("2026-11-26T10:00:00")?.toISOString()).toBe("2026-11-26T10:00:00.000Z");
  });

  it("keeps explicit offsets", () => {
    expect(parseServerDate("2026-11-26T10:00:00+09:00")?.toISOString()).toBe("2026-11-26T01:00:00.000Z");
    expect(parseServerDate("2026-11-26T10:00:00Z")?.toISOString()).toBe("2026-11-26T10:00:00.000Z");
  });

  it("returns null for empty or invalid input", () => {
    expect(parseServerDate(null)).toBeNull();
    expect(parseServerDate("")).toBeNull();
    expect(parseServerDate("not a date")).toBeNull();
  });
});
