import { HttpResponse, http } from "msw";
import { z } from "zod";

import { camelizeKeys, snakeToCamel } from "@/lib/casing";

import {
  type ApiKeyWire,
  type LimitUsageWire,
  createApiKeyWire,
  createCatalogModelWires,
  createDefaultApiKeyWires,
  createKeyTrendsWire,
  createKeysOverviewWire,
  createLimitUsageWire,
  MOCK_WINDOW_SECONDS,
  createAuthStatus,
  createRuntimeSettings,
  createDefaultAccountWires,
  createAccountWire,
  createAccountTrendsWire,
  createPoolQuotaWire,
  type AccountWire,
  createDashboardOverviewWire,
  createDashboardProjectionsWire,
  createDefaultRequestLogWires,
  createUsageTrendWire,
  createReportWire,
  createReportOptionsWire,
  type ReportWire,
  type RequestLogWire,
  createQuotaPlannerDecision,
  createQuotaPlannerForecast,
  createQuotaPlannerSettings,
  createQuotaPlannerWarmupActionResponse,
  type AuthStatusWire,
  MOCK_BOOTSTRAP_TOKEN,
  MOCK_DASHBOARD_PASSWORD,
  MOCK_TOTP_CODE,
  ROUTING_STRATEGIES_WIRE,
  type RuntimeSettingsWire,
  type QuotaPlannerDecision,
  type QuotaPlannerForecast,
  type QuotaPlannerSettings,
  type AuditEventWire,
  type StickyEntryWire,
  createCatalogWire,
  createDefaultAuditEventWires,
  createDefaultStickyEntryWires,
  type AutomationCycleWire,
  type AutomationJobWire,
  type FirewallEntryWire,
  createAutomationCycleWire,
  createAutomationJobWire,
  createAutomationRunWire,
  createDefaultAutomationWires,
  createFirewallEntryWire,
} from "@/test/mocks/factories";

const REQUEST_STATUS_ORDER = [
  "ok",
  "aborted",
  "rate_limited",
  "overloaded",
  "auth_error",
  "client_error",
  "server_error",
] as const;

// ── Zod schemas for mock request bodies ──

const QuotaPlannerSettingsPayloadSchema = z.looseObject({
  mode: z.enum(["off", "shadow", "suggest", "auto"]).optional(),
  timezone: z.string().optional(),
  workingDays: z.array(z.number().int().min(0).max(6)).optional(),
  workingHoursStart: z.string().optional(),
  workingHoursEnd: z.string().optional(),
  prewarmEnabled: z.boolean().optional(),
  prewarmLeadMinutes: z.number().int().min(0).optional(),
  maxWarmupsPerDay: z.number().int().min(0).optional(),
  maxWarmupCreditsPerDay: z.number().min(0).optional(),
  minExpectedGain: z.number().min(0).optional(),
  forecastQuantile: z.enum(["p50", "p75", "p90"]).optional(),
  allowSyntheticTraffic: z.boolean().optional(),
  warmupModelPreference: z.string().nullable().optional(),
  dryRun: z.boolean().optional(),
});

// ── Helpers ──

// LEGACY: the codex-lb handlers below model codex-lb's camelCase API. The api-client now
// sends snake_case bodies and query keys (claude-lb's wire format), so these helpers
// convert requests back before the legacy handlers read them. Handlers for claude-lb
// endpoints must NOT use them: they read the snake_case request as the real backend does.
// Remove once Steps C–G have replaced every codex-lb handler.
function legacyRequestUrl(request: Request): URL {
  const url = new URL(request.url);
  const converted = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    converted.append(snakeToCamel(key), value);
  }
  url.search = converted.toString();
  return url;
}

async function legacyJson(request: Request): Promise<unknown> {
  return camelizeKeys(await request.json());
}

async function parseJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    const raw: unknown = await legacyJson(request);
    const result = schema.safeParse(raw);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

type MockState = {
  /** claude-lb `GET /api/accounts` rows (snake_case wire shape). */
  accounts: AccountWire[];
  /** claude-lb `GET /api/request-logs` rows, newest first (snake_case wire shape). */
  requestLogs: RequestLogWire[];
  /** Overrides merged into `GET /api/dashboard/projections`. */
  projections: Record<string, unknown>;
  authStatus: AuthStatusWire;
  /** Password the mock auth endpoints accept once `authStatus.configured` is true. */
  password: string | null;
  totpEnabled: boolean;
  totpPending: boolean;
  settings: RuntimeSettingsWire;
  quotaPlannerSettings: QuotaPlannerSettings;
  quotaPlannerDecisions: QuotaPlannerDecision[];
  quotaPlannerForecast: QuotaPlannerForecast;
  apiKeys: ApiKeyWire[];
  firewall: { mode: "allow_all" | "allowlist"; entries: FirewallEntryWire[]; clientIp: string };
  guest: { enabled: boolean; password: string | null };
  automationJobs: AutomationJobWire[];
  automationCycles: AutomationCycleWire[];
  reportOverrides: Partial<ReportWire>;
  stickyEntries: StickyEntryWire[];
  auditEvents: AuditEventWire[];
  catalog: ReturnType<typeof createCatalogWire>;
};

function createInitialState(): MockState {
  return {
    accounts: createDefaultAccountWires(),
    requestLogs: createDefaultRequestLogWires(),
    projections: {},
    authStatus: createAuthStatus(),
    password: MOCK_DASHBOARD_PASSWORD,
    totpEnabled: false,
    totpPending: false,
    settings: createRuntimeSettings(),
    quotaPlannerSettings: createQuotaPlannerSettings(),
    quotaPlannerDecisions: [createQuotaPlannerDecision()],
    quotaPlannerForecast: createQuotaPlannerForecast(),
    apiKeys: createDefaultApiKeyWires(),
    firewall: { mode: "allow_all", entries: [createFirewallEntryWire()], clientIp: "127.0.0.1" },
    guest: { enabled: false, password: null },
    automationJobs: createDefaultAutomationWires().jobs,
    automationCycles: createDefaultAutomationWires().cycles,
    reportOverrides: {},
    stickyEntries: createDefaultStickyEntryWires(),
    auditEvents: createDefaultAuditEventWires(),
    catalog: createCatalogWire(),
  };
}

let state: MockState = createInitialState();

/**
 * Adjusts the claude-lb auth mock for a test, e.g. `{ configured: false, authenticated: false }`
 * for a remote first visit, or `{ authenticated: false, totpEnabled: true }` for a TOTP sign-in.
 */
export function setMockAuth(overrides: Partial<AuthStatusWire> & { password?: string | null; totpEnabled?: boolean }): void {
  const { password, totpEnabled, ...status } = overrides;
  if (password !== undefined) state.password = password;
  if (totpEnabled !== undefined) state.totpEnabled = totpEnabled;
  state.authStatus = { ...state.authStatus, ...status, totp_enabled: state.totpEnabled };
}

export function getMockSettings(): RuntimeSettingsWire {
  return state.settings;
}

export function resetMockState(): void {
  state = createInitialState();
}

/** Overrides merged into every `/api/reports` response (e.g. `{ coverage: {...} }`). */
export function setMockReport(overrides: Partial<ReportWire>): void {
  state.reportOverrides = overrides;
}

const REPORT_GROUPINGS_WIRE = ["day", "account", "api_key", "model", "user_agent"] as const;

/** Mirrors `usage.reports.normalize_range`: 422 with the backend's messages. */
function reportRangeError(url: URL): Response | null {
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if ((start && !iso.test(start)) || (end && !iso.test(end))) return detail(422, "dates must be ISO YYYY-MM-DD");
  if (start && end && start > end) return detail(422, "start must not be after end");
  if (start && end && (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1 > 366) {
    return detail(422, "the range must be 366 days or less");
  }
  return null;
}

export function setMockRequestLogs(rows: RequestLogWire[]): void {
  state.requestLogs = rows;
}

export function setMockProjections(overrides: Record<string, unknown>): void {
  state.projections = overrides;
}

const TIMEFRAME_MS: Record<string, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

/** Mirrors `claude_lb/modules/request_logs/service.py` filtering on the snake_case query. */
function filterRequestLogWires(url: URL): RequestLogWire[] {
  const params = url.searchParams;
  const search = (params.get("search") ?? "").trim().toLowerCase();
  const accountIds = params.getAll("account_id");
  const apiKeyIds = params.getAll("api_key_id");
  const models = params.getAll("model");
  const statuses = params.getAll("status");
  const sessionKey = params.get("session_key");
  const timeframe = params.get("timeframe");
  const since = timeframe && TIMEFRAME_MS[timeframe] ? Date.now() - TIMEFRAME_MS[timeframe] : null;
  return state.requestLogs.filter((row) => {
    if (since !== null && new Date(`${row.created_at}Z`).getTime() < since) return false;
    if (accountIds.length && !accountIds.includes(row.account_id ?? "")) return false;
    if (apiKeyIds.length && !apiKeyIds.includes(row.api_key_id ?? "")) return false;
    if (models.length && !models.includes(row.model ?? "")) return false;
    if (statuses.length && !statuses.includes(row.status)) return false;
    if (sessionKey && row.session_key !== sessionKey) return false;
    if (search) {
      const haystack = [row.id, row.model, row.error, row.account_name, row.api_key_name, row.session_key, row.user_agent, row.client_ip]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

function findApiKey(keyId: string): ApiKeyWire | undefined {
  return state.apiKeys.find((item) => item.id === keyId);
}

const SETTINGS_BOUNDS: Record<string, [number, number]> = {
  max_attempts: [1, 10],
  sticky_ttl_seconds: [0, 24 * 3600],
  health_probe_interval_seconds: [30, 3600],
  model_sync_interval_seconds: [300, 24 * 3600],
  request_log_retention_days: [1, 3650],
};

function detail(status: number, message: unknown, headers?: Record<string, string>) {
  return HttpResponse.json({ detail: message }, { status, headers });
}

/** `require_management_auth`: 401 unless the mock session is authenticated. */
function managementAuthError(): Response | null {
  if (state.authStatus.authenticated) {
    return null;
  }
  return detail(401, state.authStatus.reason || "sign in required", { "x-claude-lb-auth": "required" });
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  try {
    const raw: unknown = await request.json();
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function settingsEnvelope() {
  return { settings: state.settings, available_strategies: [...ROUTING_STRATEGIES_WIRE] };
}


// ── claude-lb accounts ──

const PAUSED_REASON = "paused by operator";
const PLAN_TYPES_WIRE = ["api", "free", "pro", "max", "max_5x", "max_20x", "team", "enterprise"];
const ROUTING_POLICIES_WIRE = ["normal", "burn_first", "preserve"];

function maskSecret(secret: string): string {
  return `${secret.slice(0, 7)}…${secret.slice(-4)}`;
}

/** Re-derive the computed fields the backend's `AccountOut.of` would return. */
function refreshAccount(account: AccountWire): AccountWire {
  const capReached = account.spend_cap_usd !== null && account.total_cost_usd >= account.spend_cap_usd;
  account.spend_cap_reached = capReached;
  account.paused = !account.enabled && account.disabled_reason === PAUSED_REASON;
  account.blocked_models = account.model_blocks.map((block) => block.model);
  account.available =
    account.enabled && !capReached && account.quota_status === "active" && account.cooldown_until === null;
  return account;
}

function findAccountWire(accountId: string): AccountWire | undefined {
  return state.accounts.find((account) => account.id === accountId);
}

function nameTaken(name: string, exceptId?: string): boolean {
  return state.accounts.some((account) => account.name === name && account.id !== exceptId);
}

function newAccountId(): string {
  return `acc_${Math.random().toString(16).slice(2, 10)}`;
}

const accountHandlers = [
  http.get("/api/accounts", () => {
    const authError = managementAuthError();
    if (authError) return authError;
    return HttpResponse.json([...state.accounts].sort((a, b) => a.name.localeCompare(b.name)));
  }),

  http.post("/api/accounts", async ({ request }) => {
    const authError = managementAuthError();
    if (authError) return authError;
    const body = await readJsonObject(request);
    const name = typeof body.name === "string" ? body.name : "";
    const apiKey = typeof body.api_key === "string" ? body.api_key : "";
    if (!name || apiKey.length < 8) {
      return detail(422, [{ loc: ["body", !name ? "name" : "api_key"], msg: "invalid value" }]);
    }
    if (nameTaken(name)) return detail(409, `an account named '${name}' already exists`);
    const provider = body.provider === "oauth" ? "oauth" : "anthropic_api_key";
    const planType = typeof body.plan_type === "string" ? body.plan_type : provider === "oauth" ? "pro" : "api";
    if (!PLAN_TYPES_WIRE.includes(planType)) return detail(422, "plan_type is invalid");
    const account = refreshAccount(
      createAccountWire({
        id: newAccountId(),
        name,
        provider,
        plan_type: planType,
        auth_scheme:
          typeof body.auth_scheme === "string" ? body.auth_scheme : provider === "oauth" ? "bearer" : "x-api-key",
        credential_hint: maskSecret(apiKey),
        routing_policy: typeof body.routing_policy === "string" ? body.routing_policy : "normal",
        weight: typeof body.weight === "number" ? body.weight : 1,
        priority: typeof body.priority === "number" ? body.priority : 0,
        spend_cap_usd: typeof body.spend_cap_usd === "number" ? body.spend_cap_usd : null,
        total_requests: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost_usd: 0,
        rl_requests_limit: null,
        rl_requests_remaining: null,
        rl_tokens_limit: null,
        rl_tokens_remaining: null,
        rl_reset_at: null,
        last_used_at: null,
        created_at: new Date().toISOString(),
      }),
    );
    state.accounts = [...state.accounts, account];
    return HttpResponse.json(account, { status: 201 });
  }),

  http.post("/api/accounts/import", async ({ request }) => {
    const authError = managementAuthError();
    if (authError) return authError;
    const body = await readJsonObject(request);
    const name = typeof body.name === "string" ? body.name : "";
    const credentials = body.credentials as Record<string, unknown> | undefined;
    if (!name || !credentials || typeof credentials !== "object") {
      return detail(422, [{ loc: ["body", "credentials"], msg: "field required" }]);
    }
    if (nameTaken(name)) return detail(409, `an account named '${name}' already exists`);
    const nested = (credentials.claudeAiOauth ?? credentials) as Record<string, unknown>;
    const token = nested.accessToken ?? nested.access_token;
    if (typeof token !== "string" || !token) {
      return detail(422, "credential bundle has no access token");
    }
    const account = refreshAccount(
      createAccountWire({
        id: newAccountId(),
        name,
        provider: "oauth",
        auth_scheme: "bearer",
        plan_type: typeof body.plan_type === "string" ? body.plan_type : "pro",
        routing_policy: typeof body.routing_policy === "string" ? body.routing_policy : "normal",
        credential_hint: maskSecret(token),
        rl_requests_limit: null,
        rl_requests_remaining: null,
        rl_tokens_limit: null,
        rl_tokens_remaining: null,
        total_requests: 0,
        total_cost_usd: 0,
      }),
    );
    state.accounts = [...state.accounts, account];
    return HttpResponse.json(account, { status: 201 });
  }),

  http.patch("/api/accounts/:accountId", async ({ params, request }) => {
    const authError = managementAuthError();
    if (authError) return authError;
    const account = findAccountWire(String(params.accountId));
    if (!account) return detail(404, "account not found");
    const body = await readJsonObject(request);
    if (typeof body.name === "string") {
      if (!body.name) return detail(422, [{ loc: ["body", "name"], msg: "too short" }]);
      if (nameTaken(body.name, account.id)) return detail(409, `an account named '${body.name}' already exists`);
      account.name = body.name;
    }
    if (typeof body.plan_type === "string") {
      if (!PLAN_TYPES_WIRE.includes(body.plan_type)) return detail(422, "plan_type is invalid");
      account.plan_type = body.plan_type;
    }
    if (typeof body.routing_policy === "string") {
      if (!ROUTING_POLICIES_WIRE.includes(body.routing_policy)) return detail(422, "routing_policy is invalid");
      account.routing_policy = body.routing_policy;
    }
    if (typeof body.weight === "number") account.weight = body.weight;
    if (typeof body.priority === "number") account.priority = body.priority;
    if ("spend_cap_usd" in body) {
      account.spend_cap_usd = typeof body.spend_cap_usd === "number" ? body.spend_cap_usd : null;
    }
    if (body.enabled === true) {
      account.enabled = true;
      account.disabled_reason = null;
      account.cooldown_until = null;
      account.consecutive_failures = 0;
      account.quota_status = "active";
    } else if (body.enabled === false) {
      account.enabled = false;
      account.disabled_reason = PAUSED_REASON;
    }
    return HttpResponse.json(refreshAccount(account));
  }),

  http.delete("/api/accounts/:accountId", ({ params }) => {
    const authError = managementAuthError();
    if (authError) return authError;
    if (!findAccountWire(String(params.accountId))) return detail(404, "account not found");
    state.accounts = state.accounts.filter((account) => account.id !== params.accountId);
    return new HttpResponse(null, { status: 204 });
  }),

  http.post("/api/accounts/:accountId/probe", ({ params }) => {
    const authError = managementAuthError();
    if (authError) return authError;
    const account = findAccountWire(String(params.accountId));
    if (!account) return detail(404, "account not found");
    const ok = !account.name.includes("broken");
    account.last_probe_at = new Date().toISOString();
    account.last_probe_ok = ok;
    account.last_probe_detail = ok ? "ok" : "upstream returned 401";
    if (!ok && !account.paused) {
      account.enabled = false;
      account.disabled_reason = "upstream returned 401";
    }
    return HttpResponse.json({
      probe: { ok, status_code: ok ? 200 : 401, detail: account.last_probe_detail, models: ok ? 3 : 0 },
      account: refreshAccount(account),
    });
  }),

  http.post("/api/accounts/:accountId/reset-quota", ({ params }) => {
    const authError = managementAuthError();
    if (authError) return authError;
    const account = findAccountWire(String(params.accountId));
    if (!account) return detail(404, "account not found");
    Object.assign(account, {
      quota_status: "active",
      model_blocks: [],
      primary_used_percent: null,
      primary_reset_at: null,
      secondary_used_percent: null,
      secondary_reset_at: null,
      unified_status: null,
      cooldown_until: null,
    });
    return HttpResponse.json(refreshAccount(account));
  }),

  http.delete("/api/accounts/:accountId/model-blocks", ({ params, request }) => {
    const authError = managementAuthError();
    if (authError) return authError;
    const account = findAccountWire(String(params.accountId));
    if (!account) return detail(404, "account not found");
    const model = new URL(request.url).searchParams.get("model");
    if (model === null) {
      account.model_blocks = [];
    } else if (account.model_blocks.some((block) => block.model === model)) {
      account.model_blocks = account.model_blocks.filter((block) => block.model !== model);
    } else {
      return detail(404, `'${model}' is not blocked on this account`);
    }
    return HttpResponse.json(refreshAccount(account));
  }),

  http.get("/api/accounts/:accountId/trends", ({ params, request }) => {
    const authError = managementAuthError();
    if (authError) return authError;
    if (!findAccountWire(String(params.accountId))) return detail(404, "account not found");
    const days = Number(new URL(request.url).searchParams.get("days") ?? 7) || 7;
    return HttpResponse.json(createAccountTrendsWire(String(params.accountId), days));
  }),

  http.get("/api/usage/quota", () => {
    const authError = managementAuthError();
    if (authError) return authError;
    return HttpResponse.json(createPoolQuotaWire(state.accounts));
  }),
];

/** Replaces the claude-lb account rows for a test (wire shape). */
export function setMockAccounts(accounts: AccountWire[]): void {
  state.accounts = accounts.map((account) => refreshAccount({ ...account }));
}

export function getMockAccounts(): AccountWire[] {
  return state.accounts;
}

// ── API keys (mirror claude_lb/modules/api_keys/api.py) ──

const LIMIT_METRICS_WIRE = ["requests", "total_tokens", "input_tokens", "output_tokens", "cost_usd"];
const LIMIT_WINDOWS_WIRE = ["5h", "7d", "daily", "weekly", "monthly", "custom"];
let keySequence = 100;

/** Validates a `limits` array like `LimitRuleIn`; returns rows with zero usage, or an error message. */
function parseLimitRules(raw: unknown): LimitUsageWire[] | string {
  if (!Array.isArray(raw)) return "limits must be a list";
  const rows: LimitUsageWire[] = [];
  for (const [index, item] of raw.entries()) {
    if (typeof item !== "object" || item === null) return `limits.${index}: invalid`;
    const rule = item as Record<string, unknown>;
    if (!LIMIT_METRICS_WIRE.includes(String(rule.metric))) return `limits.${index}.metric: invalid`;
    if (!LIMIT_WINDOWS_WIRE.includes(String(rule.window))) return `limits.${index}.window: invalid`;
    if (typeof rule.max_value !== "number" || rule.max_value <= 0) return `limits.${index}.max_value: must be > 0`;
    const window = rule.window as LimitUsageWire["window"];
    let windowSeconds = MOCK_WINDOW_SECONDS[window];
    if (window === "custom") {
      if (typeof rule.window_seconds !== "number" || rule.window_seconds < 60) {
        return "a custom window needs window_seconds";
      }
      windowSeconds = rule.window_seconds;
    }
    const filter = typeof rule.model_filter === "string" ? rule.model_filter.trim() : "";
    rows.push(
      createLimitUsageWire({
        id: `rule_${keySequence++}`,
        metric: rule.metric as LimitUsageWire["metric"],
        window,
        window_seconds: windowSeconds,
        max_value: rule.max_value,
        model_filter: filter || null,
        current_value: 0,
        resets_at: ["daily", "weekly", "monthly"].includes(window) ? new Date(Date.now() + 3_600_000).toISOString() : null,
      }),
    );
  }
  return rows;
}

function cleanList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const values = [...new Set(raw.map((v) => String(v).trim()).filter(Boolean))];
  return values.length > 0 ? values : null;
}

function keyStatus(key: ApiKeyWire): ApiKeyWire["status"] {
  if (!key.enabled) return "disabled";
  if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now()) return "expired";
  return "active";
}

function unknownAccounts(ids: string[] | null): string[] {
  return (ids ?? []).filter((id) => !state.accounts.some((account) => account.id === id));
}

function newSecret(): string {
  return `clb_mock${String(keySequence++).padStart(6, "0")}secret`;
}

const apiKeyHandlers = [
  http.get("/api/keys", () => {
    const denied = managementAuthError();
    if (denied) return denied;
    return HttpResponse.json([...state.apiKeys].sort((a, b) => a.name.localeCompare(b.name)));
  }),

  http.get("/api/keys/overview", () => {
    const denied = managementAuthError();
    if (denied) return denied;
    return HttpResponse.json(createKeysOverviewWire(state.apiKeys));
  }),

  http.post("/api/keys", async ({ request }) => {
    const denied = managementAuthError();
    if (denied) return denied;
    const body = await readJsonObject(request);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return detail(422, [{ loc: ["body", "name"], msg: "String should have at least 1 character" }]);
    if (state.apiKeys.some((key) => key.name === name)) return detail(409, `a key named '${name}' already exists`);
    const assigned = cleanList(body.assigned_account_ids);
    const missing = unknownAccounts(assigned);
    if (missing.length > 0) return detail(422, `unknown account id(s): ${missing.join(", ")}`);
    const limits = body.limits === undefined || body.limits === null ? [] : parseLimitRules(body.limits);
    if (typeof limits === "string") return detail(422, limits);
    const secret = newSecret();
    const key = createApiKeyWire({
      id: `key_${keySequence++}`,
      name,
      key_hint: secret.slice(-6),
      expires_at: typeof body.expires_at === "string" ? body.expires_at : null,
      allowed_models: cleanList(body.allowed_models),
      enforced_model: typeof body.enforced_model === "string" && body.enforced_model.trim() ? body.enforced_model.trim() : null,
      assigned_account_ids: assigned,
      limits,
      total_requests: 0,
      total_cost_usd: 0,
      total_tokens: 0,
      lifetime_requests: 0,
      lifetime_cost_usd: 0,
      last_used_at: null,
      created_at: new Date().toISOString(),
    });
    key.status = keyStatus(key);
    state.apiKeys = [...state.apiKeys, key];
    return HttpResponse.json({ ...key, api_key: secret }, { status: 201 });
  }),

  http.get("/api/keys/:keyId", ({ params }) => {
    const denied = managementAuthError();
    if (denied) return denied;
    const key = findApiKey(String(params.keyId));
    return key ? HttpResponse.json(key) : detail(404, "API key not found");
  }),

  http.patch("/api/keys/:keyId", async ({ params, request }) => {
    const denied = managementAuthError();
    if (denied) return denied;
    const existing = findApiKey(String(params.keyId));
    if (!existing) return detail(404, "API key not found");
    const body = await readJsonObject(request);
    const queryEnabled = new URL(request.url).searchParams.get("enabled");
    if (queryEnabled !== null && !("enabled" in body)) body.enabled = queryEnabled === "true";
    if (Object.keys(body).length === 0) return detail(422, "nothing to update");
    const next: ApiKeyWire = { ...existing };
    if (typeof body.name === "string" && body.name !== existing.name) {
      if (state.apiKeys.some((key) => key.name === body.name)) return detail(409, `a key named '${body.name}' already exists`);
      next.name = body.name;
    }
    if ("enabled" in body) next.enabled = body.enabled === true;
    if ("expires_at" in body) next.expires_at = typeof body.expires_at === "string" ? body.expires_at : null;
    if ("allowed_models" in body) next.allowed_models = cleanList(body.allowed_models);
    if ("enforced_model" in body) {
      next.enforced_model = typeof body.enforced_model === "string" && body.enforced_model.trim() ? body.enforced_model.trim() : null;
    }
    if ("assigned_account_ids" in body) {
      const assigned = cleanList(body.assigned_account_ids);
      const missing = unknownAccounts(assigned);
      if (missing.length > 0) return detail(422, `unknown account id(s): ${missing.join(", ")}`);
      next.assigned_account_ids = assigned;
    }
    if ("pinned_account_id" in body) next.pinned_account_id = typeof body.pinned_account_id === "string" ? body.pinned_account_id : null;
    if ("limits" in body) {
      const limits = parseLimitRules(body.limits ?? []);
      if (typeof limits === "string") return detail(422, limits);
      next.limits = limits;
      next.max_requests_per_window = null;
      next.max_tokens_per_window = null;
      next.max_cost_usd_per_window = null;
    }
    next.status = keyStatus(next);
    state.apiKeys = state.apiKeys.map((key) => (key.id === next.id ? next : key));
    return HttpResponse.json(next);
  }),

  http.delete("/api/keys/:keyId", ({ params }) => {
    const denied = managementAuthError();
    if (denied) return denied;
    if (!findApiKey(String(params.keyId))) return detail(404, "API key not found");
    state.apiKeys = state.apiKeys.filter((key) => key.id !== params.keyId);
    return new HttpResponse(null, { status: 204 });
  }),

  http.post("/api/keys/:keyId/regenerate", ({ params }) => {
    const denied = managementAuthError();
    if (denied) return denied;
    const existing = findApiKey(String(params.keyId));
    if (!existing) return detail(404, "API key not found");
    const secret = newSecret();
    const next = { ...existing, key_hint: secret.slice(-6) };
    state.apiKeys = state.apiKeys.map((key) => (key.id === next.id ? next : key));
    return HttpResponse.json({ ...next, api_key: secret });
  }),

  http.get("/api/keys/:keyId/trends", ({ params, request }) => {
    const denied = managementAuthError();
    if (denied) return denied;
    if (!findApiKey(String(params.keyId))) return detail(404, "API key not found");
    const days = Number(new URL(request.url).searchParams.get("days") ?? "7");
    if (!Number.isInteger(days) || days < 1 || days > 90) return detail(422, "days must be between 1 and 90");
    return HttpResponse.json(createKeyTrendsWire(String(params.keyId), days));
  }),

  http.get("/api/health/models", () => {
    const denied = managementAuthError();
    if (denied) return denied;
    return HttpResponse.json(createCatalogModelWires());
  }),
];

/** Replaces the API key rows for a test (wire shape). */
export function setMockApiKeys(keys: ApiKeyWire[]): void {
  state.apiKeys = keys.map((key) => ({ ...key }));
}

export function getMockApiKeys(): ApiKeyWire[] {
  return state.apiKeys;
}

const claudeLbHandlers = [
  http.get("/health", () => HttpResponse.json({ status: "ok", version: "0.6.1" })),

  http.get("/health/ready", () => HttpResponse.json({ status: "ok", version: "0.6.1" })),

  http.get("/api/auth/status", () => HttpResponse.json(state.authStatus)),

  http.post("/api/auth/login", async ({ request }) => {
    const body = await readJsonObject(request);
    if (!state.authStatus.configured) {
      return detail(409, "dashboard authentication is not configured");
    }
    const passwordOk = body.password === state.password;
    const totpOk = !state.totpEnabled || body.totp_code === MOCK_TOTP_CODE;
    if (!passwordOk || !totpOk) {
      return detail(401, "invalid credentials");
    }
    state.authStatus = { ...state.authStatus, authenticated: true, role: "admin", reason: "", totp_enabled: state.totpEnabled };
    return HttpResponse.json(state.authStatus);
  }),

  http.post("/api/auth/logout", () => {
    // Loopback without a password stays trusted after logout, as on the real server.
    state.authStatus = { ...state.authStatus, authenticated: !state.authStatus.configured, role: "admin" };
    return new HttpResponse(null, { status: 204 });
  }),

  http.post("/api/auth/password", async ({ request }) => {
    if (!state.authStatus.authenticated) {
      const bootstrapOk =
        !state.authStatus.configured && request.headers.get("x-claude-lb-bootstrap") === MOCK_BOOTSTRAP_TOKEN;
      if (!bootstrapOk) {
        return detail(401, state.authStatus.reason || "sign in required", { "x-claude-lb-auth": "required" });
      }
    }
    const body = await readJsonObject(request);
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < 8) {
      return detail(422, [
        { type: "string_too_short", loc: ["body", "password"], msg: "String should have at least 8 characters" },
      ]);
    }
    if (state.authStatus.configured && body.current_password !== state.password) {
      return detail(403, "current password is incorrect");
    }
    state.password = password;
    state.authStatus = {
      ...state.authStatus,
      configured: true,
      authenticated: true,
      reason: "",
      totp_enabled: state.totpEnabled,
    };
    return HttpResponse.json(state.authStatus);
  }),

  http.post("/api/auth/totp/enroll", () => {
    const denied = managementAuthError();
    if (denied) return denied;
    if (!state.authStatus.configured) {
      return detail(409, "set a password before enabling TOTP");
    }
    state.totpPending = true;
    return HttpResponse.json({
      secret: "JBSWY3DPEHPK3PXP",
      provisioning_uri: "otpauth://totp/claude-lb:dashboard?secret=JBSWY3DPEHPK3PXP&issuer=claude-lb",
    });
  }),

  http.post("/api/auth/totp/confirm", async ({ request }) => {
    const denied = managementAuthError();
    if (denied) return denied;
    const body = await readJsonObject(request);
    if (!state.totpPending) {
      return detail(409, "no TOTP enrollment in progress");
    }
    if (body.code !== MOCK_TOTP_CODE) {
      return detail(403, "that code did not match");
    }
    state.totpPending = false;
    state.totpEnabled = true;
    state.authStatus = { ...state.authStatus, totp_enabled: true };
    return new HttpResponse(null, { status: 204 });
  }),

  http.delete("/api/auth/totp", () => {
    const denied = managementAuthError();
    if (denied) return denied;
    state.totpEnabled = false;
    state.totpPending = false;
    state.authStatus = { ...state.authStatus, totp_enabled: false };
    return new HttpResponse(null, { status: 204 });
  }),

  http.post("/api/auth/sessions/revoke-all", () => {
    const denied = managementAuthError();
    if (denied) return denied;
    state.authStatus = { ...state.authStatus, authenticated: !state.authStatus.configured, role: "admin" };
    return new HttpResponse(null, { status: 204 });
  }),

  http.get("/api/settings", () => {
    const denied = managementAuthError();
    if (denied) return denied;
    return HttpResponse.json(settingsEnvelope());
  }),

  http.patch("/api/settings", async ({ request }) => {
    const denied = managementAuthError();
    if (denied) return denied;
    const body = await readJsonObject(request);
    const changes = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== null));
    if (Object.keys(changes).length === 0) {
      return detail(400, "no settings supplied");
    }
    const unknown = Object.keys(changes).filter((key) => !(key in state.settings));
    if (unknown.length > 0) {
      return detail(422, unknown.map((key) => ({ type: "extra_forbidden", loc: ["body", key], msg: "Extra inputs are not permitted" })));
    }
    if (typeof changes.routing_strategy === "string" && !ROUTING_STRATEGIES_WIRE.includes(changes.routing_strategy)) {
      return detail(422, `unknown routing strategy '${changes.routing_strategy}'`);
    }
    for (const [key, [min, max]] of Object.entries(SETTINGS_BOUNDS)) {
      const value = changes[key];
      if (typeof value === "number" && (value < min || value > max)) {
        return detail(422, `${key} must be between ${min} and ${max}`);
      }
    }
    state.settings = { ...state.settings, ...(changes as Partial<RuntimeSettingsWire>) };
    return HttpResponse.json(settingsEnvelope());
  }),

  http.post("/api/settings/reset", () => {
    const denied = managementAuthError();
    if (denied) return denied;
    state.settings = createRuntimeSettings();
    return HttpResponse.json(settingsEnvelope());
  }),
];

/** Replaces the sticky-session map for a test (wire shape, most recent first). */
export function setMockStickyEntries(entries: StickyEntryWire[]): void {
  state.stickyEntries = entries;
}

export function getMockStickyEntries(): StickyEntryWire[] {
  return state.stickyEntries;
}

export function setMockAuditEvents(events: AuditEventWire[]): void {
  state.auditEvents = events;
}

export function setMockCatalog(overrides: Partial<ReturnType<typeof createCatalogWire>>): void {
  state.catalog = { ...state.catalog, ...overrides };
}

function wireTime(value: string): number {
  return new Date(/Z$|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`).getTime();
}

/** Mirrors `request_logs/conversations.py`: group by session_key, newest activity first. */
function conversationWires(url: URL) {
  const params = url.searchParams;
  const timeframe = params.get("timeframe");
  const since = timeframe && TIMEFRAME_MS[timeframe] ? Date.now() - TIMEFRAME_MS[timeframe] : null;
  const term = (params.get("search") ?? "").trim().toLowerCase();
  const rows = state.requestLogs.filter(
    (row) => row.session_key && (since === null || wireTime(row.created_at) >= since),
  );
  const groups = new Map<string, RequestLogWire[]>();
  for (const row of rows) {
    const key = row.session_key as string;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const ranked = (values: Array<string | null>) => {
    const counts = new Map<string, number>();
    for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value]) => value);
  };
  const items = [...groups].map(([key, group]) => {
    const times = group.map((row) => wireTime(row.created_at));
    const first = group[times.indexOf(Math.min(...times))].created_at;
    const last = group[times.indexOf(Math.max(...times))].created_at;
    const sum = (pick: (row: RequestLogWire) => number) => group.reduce((total, row) => total + pick(row), 0);
    const named = (pairs: Array<[string | null, string | null]>) => {
      const names = new Map(pairs.filter(([id]) => id).map(([id, name]) => [id as string, name ?? "(deleted)"]));
      return ranked(pairs.map(([id]) => id)).map((id) => ({ id, name: names.get(id) as string }));
    };
    return {
      session_key: key,
      first_at: first,
      last_at: last,
      duration_ms: Math.max(...times) - Math.min(...times),
      requests: group.length,
      errors: group.filter((row) => row.status !== "ok").length,
      input_tokens: sum((row) => row.input_tokens),
      output_tokens: sum((row) => row.output_tokens),
      cache_read_input_tokens: sum((row) => row.cache_read_input_tokens),
      cache_creation_input_tokens: sum((row) => row.cache_creation_input_tokens),
      total_tokens: sum((row) => row.total_tokens),
      cost_usd: sum((row) => row.cost_usd),
      accounts: named(group.map((row) => [row.account_id, row.account_name])),
      api_keys: named(group.map((row) => [row.api_key_id, row.api_key_name])),
      models: ranked(group.map((row) => row.model)),
      _haystack: group
        .flatMap((row) => [row.session_key, row.model, row.user_agent, row.client_ip, row.account_name, row.api_key_name])
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    };
  });
  return items
    .filter((item) => !term || item._haystack.includes(term))
    .sort((a, b) => wireTime(b.last_at) - wireTime(a.last_at))
    .map((item) => {
      const { _haystack, ...rest } = item;
      void _haystack;
      return rest;
    });
}

const extrasHandlers = [
  http.get("/api/conversations", ({ request }) => {
    const denied = managementAuthError();
    if (denied) return denied;
    const url = new URL(request.url);
    const timeframe = url.searchParams.get("timeframe");
    if (timeframe && timeframe !== "all" && !TIMEFRAME_MS[timeframe]) {
      return detail(422, "timeframe must be one of all, 1h, 24h, 7d, 30d");
    }
    const all = conversationWires(url);
    const limit = Number(url.searchParams.get("limit") ?? 25);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const page = all.slice(offset, offset + limit);
    return HttpResponse.json({
      conversations: page,
      total: all.length,
      limit,
      offset,
      has_more: offset + page.length < all.length,
    });
  }),

  http.get("/api/conversations/:sessionKey", ({ params }) => {
    const denied = managementAuthError();
    if (denied) return denied;
    const key = String(params.sessionKey);
    const rows = state.requestLogs.filter((row) => row.session_key === key);
    if (rows.length === 0) return detail(404, "conversation not found");
    const [summary] = conversationWires(new URL("http://localhost/api/conversations")).filter(
      (item) => item.session_key === key,
    );
    const byModel = new Map<string | null, RequestLogWire[]>();
    for (const row of rows) byModel.set(row.model, [...(byModel.get(row.model) ?? []), row]);
    const count = (pick: (row: RequestLogWire) => string | null) => {
      const counts = new Map<string, number>();
      for (const row of rows) {
        const value = pick(row);
        if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      return counts;
    };
    const accountCounts = count((row) => row.account_id);
    const keyCounts = count((row) => row.api_key_id);
    const agents = [...count((row) => row.user_agent)].sort((a, b) => b[1] - a[1]);
    return HttpResponse.json({
      session_key: key,
      first_at: summary.first_at,
      last_at: summary.last_at,
      duration_ms: summary.duration_ms,
      busy_ms: rows.reduce((total, row) => total + row.duration_ms, 0),
      requests: rows.length,
      errors: summary.errors,
      cost_usd: summary.cost_usd,
      account_count: accountCounts.size,
      accounts: summary.accounts.map((account) => ({
        ...account,
        plan_type: rows.find((row) => row.account_id === account.id)?.plan_type ?? null,
        requests: accountCounts.get(account.id) ?? 0,
      })),
      api_keys: summary.api_keys.map((apiKey) => ({ ...apiKey, requests: keyCounts.get(apiKey.id) ?? 0 })),
      dominant_user_agent: agents[0]?.[0] ?? null,
      dominant_user_agent_family: agents[0] ? agents[0][0].split("/", 1)[0] : "(unknown)",
      models: [...byModel].map(([model, group]) => ({
        model,
        requests: group.length,
        errors: group.filter((row) => row.status !== "ok").length,
        duration_ms: group.reduce((total, row) => total + row.duration_ms, 0),
        input_tokens: group.reduce((total, row) => total + row.input_tokens, 0),
        cache_read_input_tokens: group.reduce((total, row) => total + row.cache_read_input_tokens, 0),
        cache_creation_input_tokens: group.reduce((total, row) => total + row.cache_creation_input_tokens, 0),
        output_tokens: group.reduce((total, row) => total + row.output_tokens, 0),
        cost_usd: group.reduce((total, row) => total + row.cost_usd, 0),
      })),
      timeline: [...rows].sort((a, b) => wireTime(b.created_at) - wireTime(a.created_at)),
      timeline_truncated: false,
    });
  }),

  http.get("/api/audit/events", ({ request }) => {
    const denied = managementAuthError();
    if (denied) return denied;
    const params = new URL(request.url).searchParams;
    const timeframe = params.get("timeframe");
    if (timeframe && timeframe !== "all" && !TIMEFRAME_MS[timeframe]) {
      return detail(422, "timeframe must be one of all, 1h, 24h, 7d, 30d");
    }
    const since = timeframe && TIMEFRAME_MS[timeframe] ? Date.now() - TIMEFRAME_MS[timeframe] : null;
    const actions = params.getAll("action");
    const target = (params.get("target") ?? "").trim().toLowerCase();
    const term = (params.get("search") ?? "").trim().toLowerCase();
    const ok = params.get("ok");
    const matched = state.auditEvents.filter((event) => {
      if (since !== null && wireTime(event.created_at) < since) return false;
      if (actions.length && !actions.includes(event.action)) return false;
      if (target && !event.target.toLowerCase().includes(target)) return false;
      if (ok !== null && String(event.ok) !== ok) return false;
      if (term) {
        const haystack = [event.action, event.target, event.detail, event.client_ip, event.actor].join(" ").toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
    const limit = Number(params.get("limit") ?? 50);
    const offset = Number(params.get("offset") ?? 0);
    const page = matched.slice(offset, offset + limit);
    return HttpResponse.json({
      events: page,
      total: matched.length,
      limit,
      offset,
      has_more: offset + page.length < matched.length,
    });
  }),

  http.get("/api/audit/actions", () => {
    const denied = managementAuthError();
    if (denied) return denied;
    const counts = new Map<string, number>();
    for (const event of state.auditEvents) counts.set(event.action, (counts.get(event.action) ?? 0) + 1);
    return HttpResponse.json(
      [...counts].sort((a, b) => a[0].localeCompare(b[0])).map(([action, count]) => ({ action, count })),
    );
  }),

  http.get("/api/health/catalog", () => {
    const denied = managementAuthError();
    if (denied) return denied;
    return HttpResponse.json(state.catalog);
  }),

  http.post("/api/health/sync-models", () => {
    const denied = managementAuthError();
    if (denied) return denied;
    return HttpResponse.json({ "alice-max": 1, console: 3 });
  }),

  http.post("/api/health/probe", () => {
    const denied = managementAuthError();
    if (denied) return denied;
    return HttpResponse.json([
      { account_id: "acc_console", account_name: "console", ok: true, status_code: 200, detail: "", models: 3 },
      { account_id: "acc_broken", account_name: "broken-sub", ok: false, status_code: 401, detail: "invalid x-api-key", models: 0 },
    ]);
  }),

  http.get("/api/sticky-sessions", ({ request }) => {
    const denied = managementAuthError();
    if (denied) return denied;
    const params = new URL(request.url).searchParams;
    const accountId = params.get("account_id");
    const includeExpired = params.get("include_expired") !== "false";
    const term = (params.get("search") ?? "").trim().toLowerCase();
    const all = state.stickyEntries;
    const rows = all.filter(
      (entry) =>
        (!accountId || entry.account_id === accountId) &&
        (includeExpired || !entry.expired) &&
        (!term || entry.key.includes(term)),
    );
    const limit = Number(params.get("limit") ?? 25);
    const offset = Number(params.get("offset") ?? 0);
    const page = rows.slice(offset, offset + limit);
    const counts = new Map<string, { account_name: string | null; entries: number }>();
    for (const entry of all) {
      const current = counts.get(entry.account_id) ?? { account_name: entry.account_name, entries: 0 };
      counts.set(entry.account_id, { ...current, entries: current.entries + 1 });
    }
    return HttpResponse.json({
      entries: page,
      total: rows.length,
      limit,
      offset,
      has_more: offset + page.length < rows.length,
      size: all.length,
      expired_count: all.filter((entry) => entry.expired).length,
      capacity: 10_000,
      enabled: state.settings.sticky_sessions_enabled,
      ttl_seconds: state.settings.sticky_ttl_seconds,
      by_account: [...counts]
        .map(([account_id, value]) => ({ account_id, ...value }))
        .sort((a, b) => b.entries - a.entries || (a.account_name ?? "").localeCompare(b.account_name ?? "")),
    });
  }),

  http.post("/api/sticky-sessions/delete", async ({ request }) => {
    const denied = managementAuthError();
    if (denied) return denied;
    const body = await readJsonObject(request);
    const keys = Array.isArray(body.keys) ? body.keys.map(String) : [];
    if (keys.length === 0) return detail(422, [{ loc: ["body", "keys"], msg: "List should have at least 1 item" }]);
    const before = state.stickyEntries.length;
    state.stickyEntries = state.stickyEntries.filter((entry) => !keys.includes(entry.key));
    return HttpResponse.json({ deleted_count: before - state.stickyEntries.length });
  }),

  http.post("/api/sticky-sessions/delete-account", async ({ request }) => {
    const denied = managementAuthError();
    if (denied) return denied;
    const body = await readJsonObject(request);
    const accountId = typeof body.account_id === "string" ? body.account_id : "";
    if (!accountId) return detail(422, [{ loc: ["body", "account_id"], msg: "Field required" }]);
    const before = state.stickyEntries.length;
    state.stickyEntries = state.stickyEntries.filter((entry) => entry.account_id !== accountId);
    return HttpResponse.json({ deleted_count: before - state.stickyEntries.length });
  }),

  http.post("/api/sticky-sessions/purge", () => {
    const denied = managementAuthError();
    if (denied) return denied;
    const before = state.stickyEntries.length;
    state.stickyEntries = state.stickyEntries.filter((entry) => !entry.expired);
    return HttpResponse.json({ deleted_count: before - state.stickyEntries.length });
  }),

  http.delete("/api/sticky-sessions/:key", ({ params }) => {
    const denied = managementAuthError();
    if (denied) return denied;
    const before = state.stickyEntries.length;
    state.stickyEntries = state.stickyEntries.filter((entry) => entry.key !== params.key);
    if (state.stickyEntries.length === before) return detail(404, "sticky session not found");
    return new HttpResponse(null, { status: 204 });
  }),
];

// ── Step G2: firewall, guest role, automations ──

/** `require_management_auth` for a write route: 401 signed out, 403 for a guest. */
function writeAuthError(): Response | null {
  const denied = managementAuthError();
  if (denied) return denied;
  if (state.authStatus.role === "guest") {
    return detail(403, "read-only guest access cannot change anything", { "x-claude-lb-auth": "read-only" });
  }
  return null;
}

/** Mirrors `firewall.service.normalize` for the shapes the tests use. */
function normalizeNetwork(raw: string): string | null {
  const value = raw.trim();
  const v4 = /^(\d{1,3})(\.\d{1,3}){3}(\/(\d{1,2}))?$/.exec(value);
  if (v4) {
    const [address, prefix] = value.split("/");
    if (address.split(".").some((part) => Number(part) > 255)) return null;
    if (prefix !== undefined && Number(prefix) > 32) return null;
    return prefix === undefined || prefix === "32" ? address : value;
  }
  if (/^[0-9a-f:]+(\/\d{1,3})?$/i.test(value) && value.includes(":")) {
    return value.toLowerCase().replace(/\/128$/, "");
  }
  return null;
}

function coversMockClient(network: string): boolean {
  const ip = state.firewall.clientIp;
  if (network === ip) return true;
  const [base, prefix] = network.split("/");
  if (prefix === undefined || base.includes(":") || ip.includes(":")) return false;
  const toInt = (address: string) => address.split(".").reduce((acc, part) => acc * 256 + Number(part), 0);
  const block = 2 ** (32 - Number(prefix));
  return Math.floor(toInt(base) / block) === Math.floor(toInt(ip) / block);
}

function firewallState() {
  const entries = state.firewall.entries.map((entry) => ({ ...entry, covers_client: coversMockClient(entry.network) }));
  const covered = entries.some((entry) => entry.covers_client);
  return {
    mode: state.firewall.mode,
    entries,
    client_ip: state.firewall.clientIp,
    client_allowed: state.firewall.mode === "allow_all" || covered,
    client_covered: covered,
  };
}

function guestStatusFields() {
  const enabled = state.guest.enabled && state.authStatus.configured;
  return { guest_access_enabled: enabled, guest_password_required: enabled && state.guest.password !== null };
}

let automationSeq = 100;

function automationTargets(accountIds: string[], includePaused: boolean) {
  const accounts = state.accounts.filter((account) =>
    accountIds.length ? accountIds.includes(account.id) : includePaused || !account.paused,
  );
  return accounts.map((account) => ({ id: account.id, name: account.name, plan_type: account.plan_type, paused: account.paused }));
}

function jobFromBody(body: Record<string, unknown>, base: AutomationJobWire): AutomationJobWire | Response {
  const schedule = (body.schedule ?? base.schedule) as Record<string, unknown>;
  const maxTokens = body.max_tokens ?? base.max_tokens;
  if (typeof maxTokens !== "number" || maxTokens < 1 || maxTokens > 1024) {
    return detail(422, "max_tokens: Input should be less than or equal to 1024");
  }
  const days = (schedule.days as string[] | undefined) ?? base.schedule.days;
  if (days.length === 0) return detail(422, "pick at least one weekday");
  const accountIds = (body.account_ids as string[] | undefined) ?? base.account_ids;
  const unknown = accountIds.filter((id) => !state.accounts.some((account) => account.id === id));
  if (unknown.length) return detail(422, `unknown account id(s): ${unknown.join(", ")}`);
  const includePaused = (body.include_paused_accounts as boolean | undefined) ?? base.include_paused_accounts;
  const targets = automationTargets(accountIds, includePaused);
  const api = targets.filter((target) => target.plan_type === "api").length;
  const enabled = (body.enabled as boolean | undefined) ?? base.enabled;
  return {
    ...base,
    name: (body.name as string | undefined) ?? base.name,
    enabled,
    schedule: {
      days,
      time: (schedule.time as string | undefined) ?? base.schedule.time,
      timezone: (schedule.timezone as string | undefined) ?? base.schedule.timezone,
      spread_minutes: (schedule.spread_minutes as number | undefined) ?? base.schedule.spread_minutes,
    },
    model: (body.model as string | undefined) ?? base.model,
    prompt: (body.prompt as string | undefined) ?? base.prompt,
    max_tokens: maxTokens,
    account_ids: accountIds,
    include_paused_accounts: includePaused,
    targets,
    next_run_at: enabled ? base.next_run_at ?? new Date(Date.now() + 3_600_000).toISOString() : null,
    estimate: { ...base.estimate, api_accounts: api, subscription_accounts: targets.length - api, per_run_usd: base.estimate.per_request_usd * api },
  };
}

const g2Handlers = [
  http.post("/api/auth/guest/login", async ({ request }) => {
    const body = await readJsonObject(request);
    if (!state.authStatus.configured) return detail(409, "guest access needs a dashboard password to be set first");
    if (!state.guest.enabled) return detail(403, "guest access is disabled");
    if (state.guest.password !== null && body.password !== state.guest.password) return detail(401, "invalid credentials");
    state.authStatus = { ...state.authStatus, authenticated: true, role: "guest", reason: "", ...guestStatusFields() };
    return HttpResponse.json(state.authStatus);
  }),

  http.get("/api/auth/guest", () => {
    const denied = managementAuthError();
    if (denied) return denied;
    return HttpResponse.json({ enabled: state.guest.enabled, password_set: state.guest.password !== null });
  }),

  http.patch("/api/auth/guest", async ({ request }) => {
    const denied = writeAuthError();
    if (denied) return denied;
    const body = await readJsonObject(request);
    if (body.enabled === true && !state.authStatus.configured) {
      return detail(409, "set a dashboard password before enabling guest access");
    }
    if (typeof body.enabled === "boolean") state.guest.enabled = body.enabled;
    if (typeof body.password === "string") state.guest.password = body.password;
    if (body.clear_password === true) state.guest.password = null;
    state.authStatus = { ...state.authStatus, ...guestStatusFields() };
    return HttpResponse.json({ enabled: state.guest.enabled, password_set: state.guest.password !== null });
  }),

  http.get("/api/firewall", () => managementAuthError() ?? HttpResponse.json(firewallState())),

  http.get("/api/firewall/check", ({ request }) => {
    const denied = managementAuthError();
    if (denied) return denied;
    const raw = new URL(request.url).searchParams.get("network") ?? "";
    const network = normalizeNetwork(raw);
    if (!network) return detail(422, `${raw} is not a valid IPv4/IPv6 address or CIDR range`);
    const covers = coversMockClient(network);
    const current = firewallState();
    return HttpResponse.json({
      network,
      client_ip: state.firewall.clientIp,
      covers_client: covers,
      client_allowed_after: current.client_allowed || covers,
    });
  }),

  http.put("/api/firewall/mode", async ({ request }) => {
    const denied = writeAuthError();
    if (denied) return denied;
    const body = await readJsonObject(request);
    if (body.mode !== "allow_all" && body.mode !== "allowlist") return detail(422, "unknown mode");
    state.firewall.mode = body.mode;
    return HttpResponse.json(firewallState());
  }),

  http.post("/api/firewall/entries", async ({ request }) => {
    const denied = writeAuthError();
    if (denied) return denied;
    const body = await readJsonObject(request);
    const network = normalizeNetwork(String(body.network ?? ""));
    if (!network) return detail(422, `${String(body.network)} is not a valid IPv4/IPv6 address or CIDR range`);
    if (state.firewall.entries.some((entry) => entry.network === network)) {
      return detail(409, `${network} is already on the list`);
    }
    const entry = createFirewallEntryWire({
      id: `fw_${state.firewall.entries.length + 2}`,
      network,
      note: String(body.note ?? ""),
      version: network.includes(":") ? 6 : 4,
      addresses: network.includes("/") ? 2 ** (32 - Number(network.split("/")[1])) : 1,
      covers_client: coversMockClient(network),
      created_at: new Date().toISOString(),
    });
    state.firewall.entries = [...state.firewall.entries, entry];
    return HttpResponse.json(entry, { status: 201 });
  }),

  http.patch("/api/firewall/entries/:entryId", async ({ request, params }) => {
    const denied = writeAuthError();
    if (denied) return denied;
    const body = await readJsonObject(request);
    const entry = state.firewall.entries.find((candidate) => candidate.id === params.entryId);
    if (!entry) return detail(404, "firewall entry not found");
    entry.note = String(body.note ?? "");
    return HttpResponse.json({ ...entry, covers_client: coversMockClient(entry.network) });
  }),

  http.delete("/api/firewall/entries/:entryId", ({ params }) => {
    const denied = writeAuthError();
    if (denied) return denied;
    const before = state.firewall.entries.length;
    state.firewall.entries = state.firewall.entries.filter((entry) => entry.id !== params.entryId);
    if (state.firewall.entries.length === before) return detail(404, "firewall entry not found");
    return new HttpResponse(null, { status: 204 });
  }),

  http.get("/api/automations", () => {
    const denied = managementAuthError();
    if (denied) return denied;
    return HttpResponse.json({
      jobs: state.automationJobs,
      total: state.automationJobs.length,
      max_tokens_cap: 1024,
      max_spread_minutes: 120,
      min_interval_minutes: 5,
    });
  }),

  http.post("/api/automations", async ({ request }) => {
    const denied = writeAuthError();
    if (denied) return denied;
    const body = await readJsonObject(request);
    if (!body.name || !body.model) return detail(422, "name and model are required");
    automationSeq += 1;
    const job = jobFromBody(
      body,
      createAutomationJobWire({ id: `job_${automationSeq}`, enabled: true, account_ids: [], last_cycle: null, next_run_at: null }),
    );
    if (job instanceof Response) return job;
    state.automationJobs = [...state.automationJobs, job];
    return HttpResponse.json(job, { status: 201 });
  }),

  http.get("/api/automations/runs", ({ request }) => {
    const denied = managementAuthError();
    if (denied) return denied;
    const url = new URL(request.url);
    const jobIds = url.searchParams.getAll("job_id");
    const statuses = url.searchParams.getAll("status");
    const trigger = url.searchParams.get("trigger");
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const cycles = state.automationCycles.filter(
      (cycle) =>
        (!jobIds.length || jobIds.includes(cycle.job_id)) &&
        (!statuses.length || cycle.runs.some((run) => statuses.includes(run.status))) &&
        (!trigger || cycle.trigger === trigger),
    );
    const page = cycles.slice(offset, offset + limit);
    return HttpResponse.json({ cycles: page, total: cycles.length, limit, offset, has_more: offset + page.length < cycles.length });
  }),

  http.patch("/api/automations/:jobId", async ({ request, params }) => {
    const denied = writeAuthError();
    if (denied) return denied;
    const job = state.automationJobs.find((candidate) => candidate.id === params.jobId);
    if (!job) return detail(404, "automation not found");
    const body = await readJsonObject(request);
    if (Object.keys(body).length === 0) return detail(422, "nothing to change");
    const updated = jobFromBody(body, job);
    if (updated instanceof Response) return updated;
    state.automationJobs = state.automationJobs.map((candidate) => (candidate.id === job.id ? updated : candidate));
    return HttpResponse.json(updated);
  }),

  http.delete("/api/automations/:jobId", ({ params }) => {
    const denied = writeAuthError();
    if (denied) return denied;
    if (!state.automationJobs.some((job) => job.id === params.jobId)) return detail(404, "automation not found");
    state.automationJobs = state.automationJobs.filter((job) => job.id !== params.jobId);
    state.automationCycles = state.automationCycles.filter((cycle) => cycle.job_id !== params.jobId);
    return new HttpResponse(null, { status: 204 });
  }),

  http.post("/api/automations/:jobId/run", ({ params }) => {
    const denied = writeAuthError();
    if (denied) return denied;
    const job = state.automationJobs.find((candidate) => candidate.id === params.jobId);
    if (!job) return detail(404, "automation not found");
    const cycleKey = `${job.id}:manual:${automationSeq++}`;
    const now = new Date().toISOString();
    const cycle = createAutomationCycleWire(
      job.targets.map((target, index) =>
        createAutomationRunWire({
          id: `${cycleKey}:${index}`,
          job_id: job.id,
          job_name: job.name,
          cycle_key: cycleKey,
          trigger: "manual",
          scheduled_for: now,
          started_at: now,
          finished_at: now,
          account_id: target.id,
          account_name: target.name,
          model: job.model,
        }),
      ),
    );
    state.automationCycles = [cycle, ...state.automationCycles];
    state.automationJobs = state.automationJobs.map((candidate) =>
      candidate.id === job.id ? { ...candidate, last_cycle: cycle } : candidate,
    );
    return HttpResponse.json({ cycle_key: cycleKey, runs: cycle.total }, { status: 202 });
  }),
];

/** Test helpers for the G2 mocks. */
export function setMockGuest(guest: { enabled: boolean; password?: string | null }): void {
  state.guest = { enabled: guest.enabled, password: guest.password ?? null };
  state.authStatus = { ...state.authStatus, ...guestStatusFields() };
}

export function setMockFirewall(overrides: Partial<MockState["firewall"]>): void {
  state.firewall = { ...state.firewall, ...overrides };
}

export function getMockFirewall(): MockState["firewall"] {
  return state.firewall;
}

export function setMockAutomations(jobs: AutomationJobWire[], cycles: AutomationCycleWire[] = []): void {
  state.automationJobs = jobs;
  state.automationCycles = cycles;
}

export function getMockAutomations(): AutomationJobWire[] {
  return state.automationJobs;
}

export const handlers = [
  ...g2Handlers,
  ...extrasHandlers,
  ...claudeLbHandlers,
  ...accountHandlers,
  ...apiKeyHandlers,

  http.get("/api/dashboard/overview", ({ request }) => {
    const authError = managementAuthError();
    if (authError) return authError;
    const timeframe = new URL(request.url).searchParams.get("timeframe") ?? "24h";
    if (!["1h", "24h", "7d", "30d"].includes(timeframe)) {
      return detail(422, "timeframe must be one of 1h, 24h, 7d, 30d");
    }
    return HttpResponse.json(createDashboardOverviewWire(timeframe as "1h" | "24h" | "7d" | "30d"));
  }),

  http.get("/api/dashboard/projections", () => {
    const authError = managementAuthError();
    if (authError) return authError;
    return HttpResponse.json({ ...createDashboardProjectionsWire(), ...state.projections });
  }),

  http.get("/api/usage/trend", ({ request }) => {
    const days = Number(new URL(request.url).searchParams.get("days") ?? 28);
    return HttpResponse.json(createUsageTrendWire(days));
  }),

  http.get("/api/request-logs", ({ request }) => {
    const authError = managementAuthError();
    if (authError) return authError;
    const url = new URL(request.url);
    const unknown = url.searchParams.getAll("status").filter((s) => !(REQUEST_STATUS_ORDER as readonly string[]).includes(s));
    if (unknown.length) return detail(422, `unknown status: ${unknown.join(", ")}`);
    const filtered = filterRequestLogWires(url);
    const limit = Number(url.searchParams.get("limit") ?? 25);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const page = filtered.slice(offset, offset + limit);
    return HttpResponse.json({
      requests: page,
      total: filtered.length,
      limit,
      offset,
      has_more: offset + page.length < filtered.length,
    });
  }),

  http.get("/api/request-logs/options", ({ request }) => {
    const authError = managementAuthError();
    if (authError) return authError;
    const url = new URL(request.url);
    const scoped = new URL(url);
    scoped.search = "";
    const timeframe = url.searchParams.get("timeframe");
    if (timeframe) scoped.searchParams.set("timeframe", timeframe);
    const rows = filterRequestLogWires(scoped);
    const accounts = new Map<string, string>();
    const keys = new Map<string, string>();
    for (const row of rows) {
      if (row.account_id) accounts.set(row.account_id, row.account_name ?? "(deleted)");
      if (row.api_key_id) keys.set(row.api_key_id, row.api_key_name ?? "(deleted)");
    }
    const present = new Set(rows.map((row) => row.status));
    return HttpResponse.json({
      accounts: [...accounts].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
      api_keys: [...keys]
        .map(([id, name]) => ({ id, name, key_hint: `clb-…${id.slice(-4)}` }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      models: [...new Set(rows.map((row) => row.model).filter((m): m is string => !!m))].sort(),
      statuses: REQUEST_STATUS_ORDER.filter((status) => present.has(status)),
    });
  }),

  http.get("/api/reports", ({ request }) => {
    const authError = managementAuthError();
    if (authError) return authError;
    const url = new URL(request.url);
    const rangeError = reportRangeError(url);
    if (rangeError) return rangeError;
    const groupBy = url.searchParams.get("group_by") ?? "day";
    if (!(REPORT_GROUPINGS_WIRE as readonly string[]).includes(groupBy)) {
      return detail(422, `group_by must be one of ${REPORT_GROUPINGS_WIRE.join(", ")}`);
    }
    const report = createReportWire(
      {
        start: url.searchParams.get("start") ?? undefined,
        end: url.searchParams.get("end") ?? undefined,
        groupBy: groupBy as ReportWire["group_by"],
      },
      state.reportOverrides,
    );
    if (url.searchParams.getAll("user_agent").length > 0) report.source = "request_logs";
    return HttpResponse.json(report);
  }),

  http.get("/api/reports/options", ({ request }) => {
    const authError = managementAuthError();
    if (authError) return authError;
    const rangeError = reportRangeError(new URL(request.url));
    if (rangeError) return rangeError;
    return HttpResponse.json(createReportOptionsWire());
  }),

  http.get("/api/request-logs/:requestId", ({ params }) => {
    const authError = managementAuthError();
    if (authError) return authError;
    const row = state.requestLogs.find((entry) => entry.id === params.requestId);
    if (!row) return detail(404, "request log not found");
    const conversation = row.session_key
      ? state.requestLogs.filter((entry) => entry.session_key === row.session_key)
      : [];
    return HttpResponse.json({
      ...row,
      cost_breakdown: {
        input_usd: row.input_tokens * 4e-6,
        cache_write_usd: row.cache_creation_input_tokens * 5e-6,
        cache_read_usd: row.cache_read_input_tokens * 2e-7,
        output_usd: row.output_tokens * 2e-5,
      },
      conversation: row.session_key
        ? {
            requests: conversation.length,
            cost_usd: conversation.reduce((sum, entry) => sum + entry.cost_usd, 0),
            first_at: conversation[conversation.length - 1].created_at,
            last_at: conversation[0].created_at,
          }
        : null,
    });
  }),

  http.get("/api/quota-planner/settings", () =>
    HttpResponse.json(state.quotaPlannerSettings),
  ),

  http.put("/api/quota-planner/settings", async ({ request }) => {
    const payload = await parseJsonBody(
      request,
      QuotaPlannerSettingsPayloadSchema,
    );
    if (!payload) {
      return HttpResponse.json(state.quotaPlannerSettings);
    }
    state.quotaPlannerSettings = createQuotaPlannerSettings({
      ...state.quotaPlannerSettings,
      ...payload,
    });
    return HttpResponse.json(state.quotaPlannerSettings);
  }),

  http.get("/api/quota-planner/decisions", ({ request }) => {
    const url = legacyRequestUrl(request);
    const limit = Number(url.searchParams.get("limit") ?? "50");
    return HttpResponse.json(state.quotaPlannerDecisions.slice(0, limit));
  }),

  http.get("/api/quota-planner/forecast", () =>
    HttpResponse.json(state.quotaPlannerForecast),
  ),

  http.post("/api/quota-planner/warm-now", async ({ request }) => {
    const payload = await parseJsonBody(
      request,
      z.object({
        accountId: z.string().min(1),
        model: z.string().nullable().optional(),
        apiKeyId: z.string().nullable().optional(),
        forceProbe: z.boolean().optional(),
      }),
    );
    const decision = createQuotaPlannerDecision({
      id: `decision_${state.quotaPlannerDecisions.length + 1}`,
      accountId: payload?.accountId ?? null,
      action: "warmup",
      status: "skipped",
      reason: "synthetic_traffic_disabled",
    });
    state.quotaPlannerDecisions = [decision, ...state.quotaPlannerDecisions];
    return HttpResponse.json(
      createQuotaPlannerWarmupActionResponse({
        decisionId: decision.id,
        status: decision.status,
        reason: decision.reason ?? "synthetic_traffic_disabled",
      }),
    );
  }),

  http.post("/api/quota-planner/decisions/:decisionId/cancel", ({ params }) => {
    const decisionId = String(params.decisionId);
    state.quotaPlannerDecisions = state.quotaPlannerDecisions.map((decision) =>
      decision.id === decisionId
        ? { ...decision, status: "canceled", reason: "admin_canceled" }
        : decision,
    );
    return HttpResponse.json(
      createQuotaPlannerWarmupActionResponse({
        decisionId,
        status: "canceled",
        reason: "admin_canceled",
      }),
    );
  }),

];
