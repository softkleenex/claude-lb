import { describe, expect, it } from "vitest";

import {
  createApiKey,
  deleteApiKey,
  getApiKeyTrends,
  getKeysOverview,
  listApiKeys,
  listCatalogModels,
  regenerateApiKey,
  updateApiKey,
} from "@/features/api-keys/api";
import { getMockApiKeys } from "@/test/mocks/handlers";

describe("api keys api", () => {
  it("lists keys from claude-lb's snake_case wire shape", async () => {
    const keys = await listApiKeys();
    const first = keys.find((key) => key.id === "key_1");
    expect(first?.keyHint).toBe("a1b2c3");
    expect(first?.assignedAccountIds).toEqual(["acc_max"]);
    expect(first?.limits[1]).toMatchObject({ metric: "requests", window: "5h", maxValue: 100, currentValue: 92 });
    expect(keys.find((key) => key.id === "key_2")?.limits[0].source).toBe("legacy");
  });

  it("creates a key with snake_case rules and returns the secret once", async () => {
    const created = await createApiKey({
      name: "ci",
      allowedModels: ["claude-haiku-5"],
      assignedAccountIds: ["acc_console"],
      limits: [{ metric: "cost_usd", window: "custom", maxValue: 2.5, windowSeconds: 7200, modelFilter: null }],
    });
    expect(created.apiKey).toMatch(/^clb_/);
    const stored = getMockApiKeys().find((key) => key.id === created.id);
    expect(stored?.allowed_models).toEqual(["claude-haiku-5"]);
    expect(stored?.limits[0]).toMatchObject({ metric: "cost_usd", window: "custom", window_seconds: 7200, max_value: 2.5 });
    expect(stored).not.toHaveProperty("api_key");
  });

  it("surfaces the server's validation message", async () => {
    await expect(createApiKey({ name: "x", assignedAccountIds: ["nope"] })).rejects.toThrow(/unknown account id/);
  });

  it("updates, regenerates, reads trends and deletes", async () => {
    const updated = await updateApiKey("key_2", { enabled: true, limits: [] });
    expect(updated.status).toBe("active");
    expect(updated.limits).toEqual([]);
    expect(updated.maxCostUsdPerWindow).toBeNull();

    const regenerated = await regenerateApiKey("key_1");
    expect(regenerated.keyHint).toBe(regenerated.apiKey.slice(-6));

    const trends = await getApiKeyTrends("key_1");
    expect(trends.usage).toHaveLength(7);
    expect(trends.byAccount[1].deleted).toBe(true);

    await deleteApiKey("key_2");
    expect(getMockApiKeys().map((key) => key.id)).toEqual(["key_1"]);
  });

  it("reads the overview and the model catalog", async () => {
    const overview = await getKeysOverview();
    expect(overview).toMatchObject({ total: 2, active: 1, disabled: 1 });
    expect(overview.byKey[0].name).toBe("claude-code-team");
    expect((await listCatalogModels()).map((model) => model.modelId)).toContain("claude-opus-5");
  });
});
