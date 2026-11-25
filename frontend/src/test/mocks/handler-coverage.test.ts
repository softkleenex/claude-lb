import { describe, expect, it } from "vitest";

import { handlers } from "@/test/mocks/handlers";

/**
 * Structural test that ensures the MSW handler set covers every API endpoint
 * consumed by the frontend. When a new endpoint is added to an api.ts file,
 * add the corresponding method+path here so this test forces the mock handler
 * to be created at the same time.
 */

function extractHandlerPaths(): string[] {
	return handlers.map((handler) => {
		const { method, path } = handler.info;
		// Normalize: MSW stores method in uppercase, path as the string literal
		return `${String(method).toUpperCase()} ${String(path)}`;
	});
}

// All API endpoints consumed by the frontend (method + MSW path pattern).
// Parameterized segments use MSW `:param` syntax.
const EXPECTED_ENDPOINTS = [
	// health
	"GET /health",
	"GET /health/ready",
	// dashboard
	"GET /api/dashboard/overview",
	"GET /api/dashboard/projections",
	"GET /api/usage/trend",
	"GET /api/request-logs",
	"GET /api/request-logs/options",
	"GET /api/request-logs/:requestId",
	// reports
	"GET /api/reports",
	"GET /api/reports/options",
	// accounts (claude-lb)
	"GET /api/accounts",
	"POST /api/accounts",
	"POST /api/accounts/import",
	"PATCH /api/accounts/:accountId",
	"DELETE /api/accounts/:accountId",
	"POST /api/accounts/:accountId/probe",
	"POST /api/accounts/:accountId/reset-quota",
	"DELETE /api/accounts/:accountId/model-blocks",
	"GET /api/accounts/:accountId/trends",
	"GET /api/usage/quota",
	// auth (claude-lb)
	"GET /api/auth/status",
	"POST /api/auth/login",
	"POST /api/auth/logout",
	"POST /api/auth/password",
	"POST /api/auth/totp/enroll",
	"POST /api/auth/totp/confirm",
	"DELETE /api/auth/totp",
	"POST /api/auth/sessions/revoke-all",
	// settings (claude-lb)
	"GET /api/settings",
	"PATCH /api/settings",
	"POST /api/settings/reset",
	// sticky sessions (claude-lb, in-memory map)
	"GET /api/sticky-sessions",
	"POST /api/sticky-sessions/delete",
	"POST /api/sticky-sessions/delete-account",
	"POST /api/sticky-sessions/purge",
	"DELETE /api/sticky-sessions/:key",
	// conversations
	"GET /api/conversations",
	"GET /api/conversations/:sessionKey",
	// audit log
	"GET /api/audit/events",
	"GET /api/audit/actions",
	// model catalog page
	"GET /api/health/catalog",
	"POST /api/health/sync-models",
	"POST /api/health/probe",
	// firewall (proxy IP allowlist)
	"GET /api/firewall",
	"GET /api/firewall/check",
	"PUT /api/firewall/mode",
	"POST /api/firewall/entries",
	"PATCH /api/firewall/entries/:entryId",
	"DELETE /api/firewall/entries/:entryId",
	// guest role
	"POST /api/auth/guest/login",
	"GET /api/auth/guest",
	"PATCH /api/auth/guest",
	// automations
	"GET /api/automations",
	"POST /api/automations",
	"GET /api/automations/runs",
	"PATCH /api/automations/:jobId",
	"DELETE /api/automations/:jobId",
	"POST /api/automations/:jobId/run",
	// api keys (claude-lb)
	"GET /api/keys",
	"GET /api/keys/overview",
	"POST /api/keys",
	"GET /api/keys/:keyId",
	"PATCH /api/keys/:keyId",
	"DELETE /api/keys/:keyId",
	"POST /api/keys/:keyId/regenerate",
	"GET /api/keys/:keyId/trends",
	"GET /api/health/models",
];

describe("MSW handler coverage", () => {
	it("covers all expected API endpoints", () => {
		const actual = new Set(extractHandlerPaths());
		const missing = EXPECTED_ENDPOINTS.filter((ep) => !actual.has(ep));
		expect(missing, "Missing MSW handlers for these endpoints").toEqual([]);
	});

	it("has no unexpected handlers outside the expected set", () => {
		const expected = new Set(EXPECTED_ENDPOINTS);
		const actual = extractHandlerPaths();
		const extra = actual.filter((ep) => !expected.has(ep));
		expect(
			extra,
			"Unexpected MSW handlers — add them to EXPECTED_ENDPOINTS",
		).toEqual([]);
	});
});
