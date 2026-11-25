import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import {
  BOOTSTRAP_HEADER,
  confirmTotp,
  disableTotp,
  enrollTotp,
  getAuthStatus,
  login,
  logout,
  revokeAllSessions,
  setPassword,
} from "@/features/auth/api";
import { ApiError } from "@/lib/api-client";
import { MOCK_BOOTSTRAP_TOKEN, MOCK_DASHBOARD_PASSWORD, MOCK_TOTP_CODE } from "@/test/mocks/factories";
import { setMockAuth } from "@/test/mocks/handlers";
import { server } from "@/test/mocks/server";

describe("auth api (claude-lb /api/auth)", () => {
  it("reads the status and camelizes it", async () => {
    setMockAuth({ configured: true, authenticated: false, totpEnabled: true, reason: "sign in required" });

    await expect(getAuthStatus()).resolves.toEqual({
      configured: true,
      totpEnabled: true,
      authenticated: false,
      reason: "sign in required",
      authEnabled: true,
    });
  });

  it("sends password and snake_case totp_code to /login", async () => {
    let body: unknown;
    server.use(
      http.post("/api/auth/login", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ configured: true, totp_enabled: true, authenticated: true, reason: "" });
      }),
    );

    await login({ password: "pw", totpCode: "123456" });

    expect(body).toEqual({ password: "pw", totp_code: "123456" });
  });

  it("omits totp_code when there is none", async () => {
    let body: unknown;
    server.use(
      http.post("/api/auth/login", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ configured: true, totp_enabled: false, authenticated: true, reason: "" });
      }),
    );

    await login({ password: "pw" });

    expect(body).toEqual({ password: "pw" });
  });

  it("turns FastAPI's detail into the ApiError message", async () => {
    setMockAuth({ authenticated: false });

    const error = await login({ password: "wrong" }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).message).toBe("invalid credentials");
  });

  it("formats 422 validation details", async () => {
    setMockAuth({ configured: false, authenticated: true });

    const error = await setPassword({ password: "short" }).catch((caught: unknown) => caught);

    expect((error as ApiError).status).toBe(422);
    expect((error as ApiError).message).toBe("password: String should have at least 8 characters");
  });

  it("sends the bootstrap token header for remote first-time setup", async () => {
    setMockAuth({ configured: false, authenticated: false, password: null });

    await expect(setPassword({ password: "long-enough-pw" })).rejects.toMatchObject({ status: 401 });
    const status = await setPassword({ password: "long-enough-pw" }, { bootstrapToken: ` ${MOCK_BOOTSTRAP_TOKEN} ` });

    expect(status).toMatchObject({ configured: true, authenticated: true });
    expect(BOOTSTRAP_HEADER).toBe("x-claude-lb-bootstrap");
  });

  it("rotates the password with current_password", async () => {
    let body: unknown;
    server.use(
      http.post("/api/auth/password", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ configured: true, totp_enabled: false, authenticated: true, reason: "" });
      }),
    );

    await setPassword({ password: "new-password", currentPassword: MOCK_DASHBOARD_PASSWORD });

    expect(body).toEqual({ password: "new-password", current_password: MOCK_DASHBOARD_PASSWORD });
  });

  it("enrolls, confirms and disables TOTP", async () => {
    const enrollment = await enrollTotp();
    expect(enrollment.secret).toBe("JBSWY3DPEHPK3PXP");
    expect(enrollment.provisioningUri).toMatch(/^otpauth:\/\/totp\//);

    await expect(confirmTotp("000000")).rejects.toMatchObject({ status: 403, message: "that code did not match" });
    await expect(confirmTotp(MOCK_TOTP_CODE)).resolves.toBeUndefined();
    await expect(getAuthStatus()).resolves.toMatchObject({ totpEnabled: true });

    await expect(disableTotp()).resolves.toBeUndefined();
    await expect(getAuthStatus()).resolves.toMatchObject({ totpEnabled: false });
  });

  it("logs out and revokes every session with 204s", async () => {
    await expect(revokeAllSessions()).resolves.toBeUndefined();
    await expect(logout()).resolves.toBeUndefined();
    await expect(getAuthStatus()).resolves.toMatchObject({ authenticated: false });
  });
});
