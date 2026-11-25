import { del, get, post } from "@/lib/api-client";
import {
  AuthStatusSchema,
  type LoginRequest,
  type SetPasswordRequest,
  TotpEnrollmentSchema,
} from "@/features/auth/schemas";

const AUTH_BASE_PATH = "/api/auth";

/** Header carrying the one-time token printed in the server log (remote first-time setup). */
export const BOOTSTRAP_HEADER = "x-claude-lb-bootstrap";

export function getAuthStatus() {
  return get(`${AUTH_BASE_PATH}/status`, AuthStatusSchema);
}

export function login(payload: LoginRequest) {
  return post(`${AUTH_BASE_PATH}/login`, AuthStatusSchema, {
    body: payload.totpCode ? payload : { password: payload.password },
    suppressUnauthorizedHandler: true,
  });
}

export function logout() {
  return post(`${AUTH_BASE_PATH}/logout`, null);
}

/**
 * First-time setup (loopback, or remote with `bootstrapToken`) and rotation
 * (`currentPassword` required). The backend replies with a fresh session cookie
 * and revokes every other session.
 */
export function setPassword(payload: SetPasswordRequest, options: { bootstrapToken?: string } = {}) {
  const token = options.bootstrapToken?.trim();
  return post(`${AUTH_BASE_PATH}/password`, AuthStatusSchema, {
    body: payload,
    headers: token ? { [BOOTSTRAP_HEADER]: token } : undefined,
    // A wrong bootstrap token is a 401; keep the setup form instead of bouncing.
    suppressUnauthorizedHandler: true,
  });
}

export function enrollTotp() {
  return post(`${AUTH_BASE_PATH}/totp/enroll`, TotpEnrollmentSchema);
}

export function confirmTotp(code: string) {
  return post(`${AUTH_BASE_PATH}/totp/confirm`, null, { body: { code } });
}

export function disableTotp() {
  return del(`${AUTH_BASE_PATH}/totp`);
}

export function revokeAllSessions() {
  return post(`${AUTH_BASE_PATH}/sessions/revoke-all`, null);
}
