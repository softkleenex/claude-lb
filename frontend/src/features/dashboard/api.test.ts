import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { getDashboardProjections, getRequestLogDetail, getRequestLogs } from "@/features/dashboard/api";
import { createRequestLogWire } from "@/test/mocks/factories";
import { server } from "@/test/mocks/server";

describe("dashboard api", () => {
  it("sends request-log filters as claude-lb's snake_case query", async () => {
    let query = "";
    server.use(
      http.get("/api/request-logs", ({ request }) => {
        query = new URL(request.url).search;
        return HttpResponse.json({ requests: [createRequestLogWire()], total: 1, limit: 10, offset: 0, has_more: false });
      }),
    );

    const page = await getRequestLogs({
      limit: 10,
      offset: 0,
      search: "  boom ",
      timeframe: "24h",
      accountIds: ["a1", "a2"],
      apiKeyIds: ["k1"],
      models: ["claude-opus-5-5"],
      statuses: ["overloaded"],
      sessionKey: "abc",
    });

    const params = new URLSearchParams(query);
    expect(params.getAll("account_id")).toEqual(["a1", "a2"]);
    expect(params.get("api_key_id")).toBe("k1");
    expect(params.get("model")).toBe("claude-opus-5-5");
    expect(params.get("status")).toBe("overloaded");
    expect(params.get("session_key")).toBe("abc");
    expect(params.get("search")).toBe("boom");
    expect(params.get("timeframe")).toBe("24h");
    expect(page.requests[0].cacheReadInputTokens).toBe(18_000);
    expect(page.hasMore).toBe(false);
  });

  it("does not send the 'all' timeframe", async () => {
    let query = "x";
    server.use(
      http.get("/api/request-logs", ({ request }) => {
        query = new URL(request.url).search;
        return HttpResponse.json({ requests: [], total: 0, limit: 25, offset: 0, has_more: false });
      }),
    );
    await getRequestLogs({ timeframe: "all" });
    expect(query).toBe("");
  });

  it("parses projections and request details", async () => {
    const projections = await getDashboardProjections();
    expect(projections.weeklyPace?.status).toBe("danger");
    expect(projections.primary?.accounts[0].accountName).toBe("alice-max");

    const detail = await getRequestLogDetail("req_0001");
    expect(detail.costBreakdown.cacheReadUsd).toBeCloseTo(0.0036);
    expect(detail.conversation?.requests).toBe(2);
  });
});
