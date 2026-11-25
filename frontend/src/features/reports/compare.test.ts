import { describe, expect, it } from "vitest";

import { compareToPrevious } from "./compare";

describe("compareToPrevious", () => {
  it("reports a rounded change with a direction", () => {
    expect(compareToPrevious(150, 100, true)).toEqual({ text: "▲ 50%", tone: "up" });
    expect(compareToPrevious(75, 100, true)).toEqual({ text: "▼ 25%", tone: "down" });
  });

  it("hides the delta when it cannot be compared or rounds to zero", () => {
    expect(compareToPrevious(150, 100, false)).toBeNull();
    expect(compareToPrevious(150, 0, true)).toBeNull();
    expect(compareToPrevious(100.2, 100, true)).toBeNull();
  });
});
