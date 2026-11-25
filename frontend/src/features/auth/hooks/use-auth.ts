import { ApiError, setUnauthorizedHandler } from "@/lib/api-client";
import { create } from "zustand";

import {
  getAuthStatus,
  guestLogin as guestLoginRequest,
  login as loginRequest,
  logout as logoutRequest,
  setPassword as setPasswordRequest,
} from "@/features/auth/api";
import type { AuthStatus, DashboardPermission, DashboardRole } from "@/features/auth/schemas";

let isLoginInProgress = false;

export const INVALID_CREDENTIALS_KEY = "auth.login.invalidCredentials";

type AuthState = {
  /** A dashboard password exists (`configured` in `/api/auth/status`). */
  passwordRequired: boolean;
  authenticated: boolean;
  totpEnabled: boolean;
  /** False when the server runs with `CLAUDE_LB_DASHBOARD_AUTH_ENABLED=false`. */
  authEnabled: boolean;
  /** No password yet and this client is not trusted (remote): setup needs the bootstrap token. */
  bootstrapRequired: boolean;
  /** Signed in without any password protecting the management plane. */
  insecure: boolean;
  reason: string;
  /** `guest` = read-only session; every write control is hidden or disabled. */
  role: DashboardRole;
  /** Guest sign-in is offered on the sign-in screen. */
  guestAccessEnabled: boolean;
  guestPasswordRequired: boolean;
  permissions: DashboardPermission[];
  canWrite: boolean;
  loading: boolean;
  initialized: boolean;
  error: string | null;
  refreshSession: () => Promise<AuthStatus>;
  login: (password: string, totpCode?: string) => Promise<AuthStatus>;
  loginAsGuest: (password?: string) => Promise<AuthStatus>;
  setupPassword: (password: string, bootstrapToken?: string) => Promise<AuthStatus>;
  logout: () => Promise<void>;
  clearError: () => void;
};

function deriveState(status: AuthStatus): Partial<AuthState> {
  const authEnabled = status.authEnabled;
  const guest = status.authenticated && status.role === "guest";
  return {
    passwordRequired: status.configured,
    authenticated: status.authenticated,
    totpEnabled: status.totpEnabled,
    authEnabled,
    bootstrapRequired: authEnabled && !status.configured && !status.authenticated,
    insecure: status.authenticated && (!authEnabled || !status.configured),
    reason: status.reason,
    role: guest ? "guest" : "admin",
    guestAccessEnabled: status.guestAccessEnabled,
    guestPasswordRequired: status.guestPasswordRequired,
    permissions: !status.authenticated ? [] : guest ? ["read"] : ["read", "write"],
    canWrite: status.authenticated && !guest,
  };
}

function applyStatus(set: (next: Partial<AuthState>) => void, status: AuthStatus): AuthStatus {
  set({ ...deriveState(status), initialized: true, error: null });
  return status;
}

export const useAuthStore = create<AuthState>((set) => ({
  passwordRequired: false,
  authenticated: false,
  totpEnabled: false,
  authEnabled: true,
  bootstrapRequired: false,
  insecure: false,
  reason: "",
  role: "admin",
  guestAccessEnabled: false,
  guestPasswordRequired: false,
  permissions: [],
  canWrite: false,
  loading: false,
  initialized: false,
  error: null,
  refreshSession: async () => {
    set({ loading: true, error: null });
    try {
      const status = await getAuthStatus();
      return applyStatus(set, status);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to refresh session",
      });
      throw error;
    } finally {
      set({ loading: false, initialized: true });
    }
  },
  login: async (password, totpCode) => {
    set({ loading: true, error: null });
    isLoginInProgress = true;
    try {
      const status = await loginRequest({ password, totpCode: totpCode || undefined });
      return applyStatus(set, status);
    } catch (error) {
      // The server deliberately says only "invalid credentials" for a wrong password or
      // code; surface it as an i18n key so the form can show it translated.
      const message =
        error instanceof ApiError && error.status === 401
          ? INVALID_CREDENTIALS_KEY
          : error instanceof Error
            ? error.message
            : "Login failed";
      set({ error: message });
      throw error;
    } finally {
      isLoginInProgress = false;
      set({ loading: false, initialized: true });
    }
  },
  loginAsGuest: async (password) => {
    set({ loading: true, error: null });
    isLoginInProgress = true;
    try {
      const status = await guestLoginRequest(password || undefined);
      return applyStatus(set, status);
    } catch (error) {
      const message =
        error instanceof ApiError && error.status === 401
          ? INVALID_CREDENTIALS_KEY
          : error instanceof Error
            ? error.message
            : "Login failed";
      set({ error: message });
      throw error;
    } finally {
      isLoginInProgress = false;
      set({ loading: false, initialized: true });
    }
  },
  setupPassword: async (password, bootstrapToken) => {
    set({ loading: true, error: null });
    try {
      const status = await setPasswordRequest({ password }, { bootstrapToken });
      return applyStatus(set, status);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "Password setup failed" });
      throw error;
    } finally {
      set({ loading: false, initialized: true });
    }
  },
  logout: async () => {
    set({ loading: true, error: null });
    try {
      await logoutRequest();
      set({ authenticated: false, role: "admin", permissions: [], canWrite: false });
      await useAuthStore.getState().refreshSession();
    } finally {
      set({ loading: false });
    }
  },
  clearError: () => {
    set({ error: null });
  },
}));

setUnauthorizedHandler(() => {
  if (isLoginInProgress) {
    return;
  }

  useAuthStore.setState({
    authenticated: false,
    permissions: [],
    canWrite: false,
    initialized: true,
    error: null,
  });
  void useAuthStore.getState().refreshSession().catch(() => undefined);
});
