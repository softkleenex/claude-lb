import { describe, expect, it } from "vitest";

import { camelToSnake, camelizeKeys, snakeToCamel, snakifyKeys, snakifyQueryKeys } from "@/lib/casing";

describe("snakeToCamel", () => {
  it("converts snake_case keys", () => {
    expect(snakeToCamel("routing_strategy")).toBe("routingStrategy");
    expect(snakeToCamel("primary_used_percent")).toBe("primaryUsedPercent");
    expect(snakeToCamel("window_5h")).toBe("window5h");
  });

  it("leaves camelCase and single words alone", () => {
    expect(snakeToCamel("routingStrategy")).toBe("routingStrategy");
    expect(snakeToCamel("status")).toBe("status");
  });

  it("keeps leading and trailing underscores", () => {
    expect(snakeToCamel("_private_key")).toBe("_privateKey");
    expect(snakeToCamel("value_")).toBe("value_");
  });
});

describe("camelToSnake", () => {
  it("converts camelCase keys", () => {
    expect(camelToSnake("routingStrategy")).toBe("routing_strategy");
    expect(camelToSnake("totpCode")).toBe("totp_code");
    expect(camelToSnake("stickyTtlSeconds")).toBe("sticky_ttl_seconds");
  });

  it("handles acronyms and digits", () => {
    expect(camelToSnake("spendCapUSD")).toBe("spend_cap_usd");
    expect(camelToSnake("HTTPServer")).toBe("http_server");
    expect(camelToSnake("window5h")).toBe("window5h");
  });

  it("leaves snake_case alone", () => {
    expect(camelToSnake("current_password")).toBe("current_password");
  });

  it("round-trips with snakeToCamel", () => {
    for (const key of ["requestLogRetentionDays", "maxAttempts", "healthProbeIntervalSeconds"]) {
      expect(snakeToCamel(camelToSnake(key))).toBe(key);
    }
  });
});

describe("camelizeKeys", () => {
  it("converts nested objects and arrays of objects", () => {
    expect(
      camelizeKeys({
        available_strategies: ["round_robin"],
        settings: { routing_strategy: "round_robin", sticky_ttl_seconds: 900 },
        accounts: [{ quota_observed_at: null }],
      }),
    ).toEqual({
      availableStrategies: ["round_robin"],
      settings: { routingStrategy: "round_robin", stickyTtlSeconds: 900 },
      accounts: [{ quotaObservedAt: null }],
    });
  });

  it("never converts string values", () => {
    expect(camelizeKeys({ routing_strategy: "capacity_weighted" })).toEqual({
      routingStrategy: "capacity_weighted",
    });
  });

  it("passes primitives, null and undefined through", () => {
    expect(camelizeKeys(null)).toBeNull();
    expect(camelizeKeys(undefined)).toBeUndefined();
    expect(camelizeKeys("text_value")).toBe("text_value");
    expect(camelizeKeys(3)).toBe(3);
  });

  it("does not mutate the input", () => {
    const input = { nested_key: { inner_key: 1 } };
    camelizeKeys(input);
    expect(input).toEqual({ nested_key: { inner_key: 1 } });
  });
});

describe("snakifyKeys", () => {
  it("converts request payloads deeply", () => {
    expect(snakifyKeys({ currentPassword: "a", nested: [{ totpCode: "1" }] })).toEqual({
      current_password: "a",
      nested: [{ totp_code: "1" }],
    });
  });

  it("leaves non-plain objects untouched", () => {
    const date = new Date(0);
    expect(snakifyKeys({ createdAt: date })).toEqual({ created_at: date });
  });
});

describe("snakifyQueryKeys", () => {
  it("rewrites query keys but not values", () => {
    expect(snakifyQueryKeys("/api/usage/summary?windowHours=24&groupBy=apiKey")).toBe(
      "/api/usage/summary?window_hours=24&group_by=apiKey",
    );
  });

  it("keeps repeated keys and fragments", () => {
    expect(snakifyQueryKeys("/x?accountId=a&accountId=b#top")).toBe("/x?account_id=a&account_id=b#top");
  });

  it("returns URLs without a query unchanged", () => {
    expect(snakifyQueryKeys("/api/settings")).toBe("/api/settings");
  });
});
