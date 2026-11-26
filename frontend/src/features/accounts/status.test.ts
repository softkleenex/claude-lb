import { describe, expect, it } from "vitest";

import { AccountSchema } from "@/features/accounts/schemas";
import {
  accountStatus,
  isSubscription,
  nextResetAt,
  peakUsedPercent,
  rateLimitRemainingPercent,
  statusLiftsAt,
} from "@/features/accounts/status";
import { camelizeKeys } from "@/lib/casing";
import { createAccountWire, createSubscriptionAccountWire, type AccountWire } from "@/test/mocks/factories";

function account(overrides: Partial<AccountWire> = {}, subscription = false) {
  const wire = subscription ? createSubscriptionAccountWire(overrides) : createAccountWire(overrides);
  return AccountSchema.parse(camelizeKeys(wire));
}

describe("accountStatus", () => {
  it("parses the real /api/accounts wire shape", () => {
    const parsed = account({}, true);
    expect(parsed.planType).toBe("max_5x");
    expect(parsed.primaryUsedPercent).toBe(42);
  });

  it("orders reasons from most to least decisive", () => {
    expect(accountStatus(account())).toBe("available");
    expect(accountStatus(account({ enabled: false, paused: true, available: false }))).toBe("paused");
    expect(accountStatus(account({ enabled: false, available: false }))).toBe("disabled");
    expect(accountStatus(account({ spend_cap_reached: true, available: false }))).toBe("spend_cap");
    expect(accountStatus(account({ quota_status: "rate_limited", available: false }))).toBe("rate_limited");
    expect(accountStatus(account({ quota_status: "quota_exceeded", available: false }))).toBe("quota_exceeded");
    expect(accountStatus(account({ available: false, cooldown_until: "2099-01-01T00:00:00" }))).toBe("cooling_down");
  });

  it("says when a status lifts on its own", () => {
    const limited = account({ quota_status: "rate_limited", available: false, primary_reset_at: "2099-01-01T05:00:00" });
    expect(statusLiftsAt(limited)?.toISOString()).toBe("2099-01-01T05:00:00.000Z");
    expect(statusLiftsAt(account({ enabled: false, paused: true, available: false }))).toBeNull();
  });
});

describe("helpers", () => {
  it("tells subscriptions from API keys", () => {
    expect(isSubscription(account())).toBe(false);
    expect(isSubscription(account({}, true))).toBe(true);
  });

  it("computes the peak window and rate-limit headroom", () => {
    expect(peakUsedPercent(account({}, true))).toBe(42);
    expect(peakUsedPercent(account())).toBeNull();
    expect(rateLimitRemainingPercent(account())).toBeCloseTo(92);
    expect(rateLimitRemainingPercent(account({}, true))).toBeNull();
  });

  it("finds the next future reset", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const next = nextResetAt(
      account({ primary_reset_at: "2025-12-31T00:00:00Z", secondary_reset_at: "2026-01-02T00:00:00Z" }),
      now,
    );
    expect(next).toBe(Date.parse("2026-01-02T00:00:00Z"));
  });
});
