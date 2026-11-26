import { describe, expect, it } from "vitest";

import {
  claudeCodeEnv,
  normalizeRules,
  ruleProblem,
  rulesChanged,
  sameIds,
  tightestLimit,
} from "@/features/api-keys/lib";
import { ApiKeySchema } from "@/features/api-keys/schemas";
import { camelizeKeys } from "@/lib/casing";
import { createApiKeyWire } from "@/test/mocks/factories";

describe("api key helpers", () => {
  it("normalizes rules: drops empty amounts, trims filters, keeps seconds only for custom windows", () => {
    expect(
      normalizeRules([
        { metric: "requests", window: "5h", maxValue: 0 },
        { metric: "cost_usd", window: "daily", maxValue: 5, windowSeconds: 999, modelFilter: "  claude-opus-5 " },
        { metric: "total_tokens", window: "custom", maxValue: 10, windowSeconds: 600, modelFilter: "" },
      ]),
    ).toEqual([
      { metric: "cost_usd", window: "daily", maxValue: 5, windowSeconds: null, modelFilter: "claude-opus-5" },
      { metric: "total_tokens", window: "custom", maxValue: 10, windowSeconds: 600, modelFilter: null },
    ]);
  });

  it("detects rule changes, ignoring blank drafts", () => {
    const base = [{ metric: "requests" as const, window: "5h" as const, maxValue: 10 }];
    expect(rulesChanged(base, [...base, { metric: "cost_usd", window: "daily", maxValue: 0 }])).toBe(false);
    expect(rulesChanged(base, [{ ...base[0], maxValue: 11 }])).toBe(true);
    expect(rulesChanged(base, [])).toBe(true);
  });

  it("flags rules the API would refuse", () => {
    expect(ruleProblem({ metric: "requests", window: "5h", maxValue: 0 })).toBe("amount");
    expect(ruleProblem({ metric: "requests", window: "custom", maxValue: 1, windowSeconds: 30 })).toBe("window");
    expect(ruleProblem({ metric: "requests", window: "custom", maxValue: 1, windowSeconds: 3600 })).toBeNull();
  });

  it("compares id sets regardless of order", () => {
    expect(sameIds(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameIds(["a"], ["a", "b"])).toBe(false);
  });

  it("picks the most used limit", () => {
    const key = ApiKeySchema.parse(camelizeKeys(createApiKeyWire()));
    expect(tightestLimit(key)?.metric).toBe("requests");
    expect(tightestLimit({ ...key, limits: [] })).toBeNull();
  });

  it("prints the Claude Code env like `claude-lb setup claude-code`", () => {
    const env = claudeCodeEnv("http://127.0.0.1:2456/", "clb_secret");
    expect(env.shell).toBe("export ANTHROPIC_BASE_URL=http://127.0.0.1:2456\nexport ANTHROPIC_API_KEY=clb_secret");
    expect(JSON.parse(env.settingsJson)).toEqual({
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:2456", ANTHROPIC_API_KEY: "clb_secret" },
    });
  });
});
