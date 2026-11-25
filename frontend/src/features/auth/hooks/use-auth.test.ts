import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { get } from "@/lib/api-client";
import { MOCK_BOOTSTRAP_TOKEN, MOCK_DASHBOARD_PASSWORD, MOCK_TOTP_CODE } from "@/test/mocks/factories";
import { setMockAuth } from "@/test/mocks/handlers";
import { z } from "zod";

describe("useAuthStore", () => {
  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState());
  });

  it("maps a signed-in status to an admin who can write", async () => {
    await useAuthStore.getState().refreshSession();

    const state = useAuthStore.getState();
    expect(state.initialized).toBe(true);
    expect(state.authenticated).toBe(true);
    expect(state.passwordRequired).toBe(true);
    expect(state.role).toBe("admin");
    expect(state.canWrite).toBe(true);
    expect(state.insecure).toBe(false);
    expect(state.bootstrapRequired).toBe(false);
  });

  it("flags loopback without a password as insecure", async () => {
    setMockAuth({ configured: false, authenticated: true, reason: "unprotected: no password set (loopback only)" });

    await useAuthStore.getState().refreshSession();

    expect(useAuthStore.getState()).toMatchObject({ authenticated: true, insecure: true, bootstrapRequired: false });
  });

  it("requires the bootstrap token for a remote first visit", async () => {
    setMockAuth({ configured: false, authenticated: false, password: null });

    await useAuthStore.getState().refreshSession();
    expect(useAuthStore.getState()).toMatchObject({ authenticated: false, bootstrapRequired: true, canWrite: false });

    await useAuthStore.getState().setupPassword("long-enough-pw", MOCK_BOOTSTRAP_TOKEN);
    expect(useAuthStore.getState()).toMatchObject({ authenticated: true, passwordRequired: true, insecure: false });
  });

  it("treats auth disabled by config as insecure", async () => {
    setMockAuth({ configured: false, authenticated: true, auth_enabled: false, reason: "auth disabled by config" });

    await useAuthStore.getState().refreshSession();

    expect(useAuthStore.getState()).toMatchObject({ authEnabled: false, insecure: true, bootstrapRequired: false });
  });

  it("logs in with password and TOTP, and keeps the error on failure", async () => {
    setMockAuth({ authenticated: false, totpEnabled: true });
    await useAuthStore.getState().refreshSession();

    await expect(useAuthStore.getState().login(MOCK_DASHBOARD_PASSWORD, "000000")).rejects.toThrow(
      "invalid credentials",
    );
    expect(useAuthStore.getState().error).toBe("auth.login.invalidCredentials");

    await useAuthStore.getState().login(MOCK_DASHBOARD_PASSWORD, MOCK_TOTP_CODE);
    expect(useAuthStore.getState()).toMatchObject({ authenticated: true, totpEnabled: true, error: null });
  });

  it("logs out and re-reads the status", async () => {
    await useAuthStore.getState().refreshSession();

    await useAuthStore.getState().logout();

    expect(useAuthStore.getState()).toMatchObject({ authenticated: false, passwordRequired: true, canWrite: false });
  });

  it("drops back to sign-in when any request answers 401", async () => {
    await useAuthStore.getState().refreshSession();
    expect(useAuthStore.getState().authenticated).toBe(true);

    setMockAuth({ authenticated: false });
    await expect(get("/api/settings", z.unknown())).rejects.toMatchObject({ status: 401 });

    await waitFor(() => {
      expect(useAuthStore.getState()).toMatchObject({ authenticated: false, passwordRequired: true });
    });
  });
});
