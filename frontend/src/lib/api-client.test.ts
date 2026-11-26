import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ApiError, get, patch, post } from "@/lib/api-client";
import { server } from "@/test/mocks/server";

describe("api-client key casing", () => {
  it("camelizes response keys before validation", async () => {
    server.use(http.get("/api/thing", () => HttpResponse.json({ outer_key: { inner_key: [{ deep_key: 1 }] } })));

    const data = await get(
      "/api/thing",
      z.object({ outerKey: z.object({ innerKey: z.array(z.object({ deepKey: z.number() })) }) }),
    );

    expect(data.outerKey.innerKey[0]?.deepKey).toBe(1);
  });

  it("snakifies request bodies and query keys", async () => {
    let seen: { url: string; body: unknown } | null = null;
    server.use(
      http.patch("/api/thing", async ({ request }) => {
        seen = { url: request.url, body: await request.json() };
        return HttpResponse.json({});
      }),
    );

    await patch("/api/thing?windowHours=24&groupBy=apiKey", z.object({}), {
      body: { stickyTtlSeconds: 60, nestedList: [{ modelName: "x" }] },
    });

    expect(seen!.url).toMatch(/\/api\/thing\?window_hours=24&group_by=apiKey$/);
    expect(seen!.body).toEqual({ sticky_ttl_seconds: 60, nested_list: [{ model_name: "x" }] });
  });

  it("leaves keys alone with rawKeys", async () => {
    let body: unknown;
    server.use(
      http.post("/api/thing", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ "claude-3_haiku": { input_tokens: 1 } });
      }),
    );

    const data = await post("/api/thing", z.record(z.string(), z.record(z.string(), z.number())), {
      body: { "x-Custom-Header": "1", someKey: 2 },
      rawKeys: true,
    });

    expect(body).toEqual({ "x-Custom-Header": "1", someKey: 2 });
    expect(data).toEqual({ "claude-3_haiku": { input_tokens: 1 } });
  });

  it("supports bodiless 204 responses with a null schema", async () => {
    server.use(http.post("/api/empty", () => new HttpResponse(null, { status: 204 })));

    await expect(post("/api/empty", null)).resolves.toBeUndefined();
  });

  it("maps FastAPI detail strings and lists to ApiError", async () => {
    server.use(
      http.get("/api/string", () => HttpResponse.json({ detail: "no settings supplied" }, { status: 400 })),
      http.get("/api/list", () =>
        HttpResponse.json(
          { detail: [{ loc: ["body", "max_attempts"], msg: "Input should be less than or equal to 10" }] },
          { status: 422 },
        ),
      ),
    );

    await expect(get("/api/string", z.unknown())).rejects.toMatchObject({
      status: 400,
      code: "http_400",
      message: "no settings supplied",
    });
    const error = await get("/api/list", z.unknown()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe("max_attempts: Input should be less than or equal to 10");
  });
});
