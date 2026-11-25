import { describe, expect, it } from "vitest";

import i18n from "@/i18n";
import { formatDays, formatSchedule, sortDays, timezoneOptions, windowResetTime } from "@/features/automations/schedule";

describe("automation schedule helpers", () => {
  it("names common day sets and lists the rest in week order", async () => {
    await i18n.changeLanguage("en");
    const t = i18n.t.bind(i18n);
    expect(formatDays(["fri", "mon", "tue", "wed", "thu"], t)).toBe("Weekdays");
    expect(formatDays(["sun", "sat"], t)).toBe("Weekends");
    expect(formatDays(["mon", "tue", "wed", "thu", "fri", "sat", "sun"], t)).toBe("Every day");
    expect(formatDays(["fri", "mon"], t)).toBe("Mon, Fri");
    expect(sortDays(["sun", "mon"])).toEqual(["mon", "sun"]);
    expect(formatSchedule({ days: ["mon"], time: "07:00", timezone: "Asia/Seoul" }, t)).toBe("Mon at 07:00 (Asia/Seoul)");
  });

  it("computes when a 5-hour window started at a time resets, across midnight", () => {
    expect(windowResetTime("07:00")).toBe("12:00");
    expect(windowResetTime("21:30")).toBe("02:30");
    expect(windowResetTime("7:00")).toBeNull();
  });

  it("offers UTC first and keeps the current zone", () => {
    const zones = timezoneOptions("Asia/Seoul");
    expect(zones[0]).toBe("UTC");
    expect(zones).toContain("Asia/Seoul");
  });
});
