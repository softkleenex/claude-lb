import { describe, expect, it } from "vitest";

import { AccountSchema } from "@/features/accounts/schemas";
import { filterAccounts, sortAccounts } from "@/features/accounts/sorting";
import { camelizeKeys } from "@/lib/casing";
import { createAccountWire, type AccountWire } from "@/test/mocks/factories";

function account(overrides: Partial<AccountWire>) {
  return AccountSchema.parse(camelizeKeys(createAccountWire(overrides)));
}

const now = Date.parse("2026-01-01T00:00:00Z");
const accounts = [
  account({ id: "c", name: "charlie", primary_used_percent: 90, primary_reset_at: "2026-01-01T01:00:00Z" }),
  account({ id: "a", name: "alpha", primary_used_percent: 10, primary_reset_at: "2026-01-01T03:00:00Z" }),
  account({ id: "b", name: "bravo", enabled: false, available: false, paused: true }),
];

describe("sortAccounts", () => {
  it("sorts by name", () => {
    expect(sortAccounts(accounts, "name", now).map((a) => a.name)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("puts the soonest reset first and unknown resets last", () => {
    expect(sortAccounts(accounts, "reset_soonest", now).map((a) => a.id)).toEqual(["c", "a", "b"]);
  });

  it("puts available accounts with the most headroom first", () => {
    expect(sortAccounts(accounts, "most_remaining", now).map((a) => a.id)).toEqual(["a", "c", "b"]);
  });
});

describe("filterAccounts", () => {
  it("matches name, plan and policy text", () => {
    expect(filterAccounts(accounts, "BRA", "all").map((a) => a.id)).toEqual(["b"]);
    expect(filterAccounts(accounts, "api", "all")).toHaveLength(3);
  });

  it("filters by derived status", () => {
    expect(filterAccounts(accounts, "", "paused").map((a) => a.id)).toEqual(["b"]);
    expect(filterAccounts(accounts, "", "available").map((a) => a.id)).toEqual(["c", "a"]);
  });
});
