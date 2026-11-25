import { HttpResponse, http } from "msw";
import { z } from "zod";

import { camelizeKeys, snakeToCamel } from "@/lib/casing";

import {
  LIMIT_TYPES,
  LIMIT_WINDOWS,
  TRAFFIC_CLASSES,
} from "@/features/api-keys/schemas";
import {
  type AccountSummary,
  type ApiKey,
  type ConversationDetails,
  type ConversationEntry,
  createApiKey,
  createApiKeyCreateResponse,
  createApiKeyTrends,
  createApiKeyUsage7Day,
  createConversationDetails,
  createConversationsResponse,
  createAuthStatus,
  createDashboardOverview,
  createDashboardProjections,
  createRuntimeSettings,
  createDefaultAccounts,
  createDefaultAccountWires,
  createAccountWire,
  createAccountTrendsWire,
  createPoolQuotaWire,
  type AccountWire,
  createDefaultApiKeys,
  createDefaultConversations,
  createDefaultRequestLogs,
  createQuotaPlannerDecision,
  createQuotaPlannerForecast,
  createQuotaPlannerSettings,
  createQuotaPlannerWarmupActionResponse,
  createRequestLogFilterOptions,
  createRequestLogsResponse,
  type AuthStatusWire,
  MOCK_BOOTSTRAP_TOKEN,
  MOCK_DASHBOARD_PASSWORD,
  MOCK_TOTP_CODE,
  ROUTING_STRATEGIES_WIRE,
  type RuntimeSettingsWire,
  type QuotaPlannerDecision,
  type QuotaPlannerForecast,
  type QuotaPlannerSettings,
  type RequestLogEntry,
} from "@/test/mocks/factories";

const MODEL_OPTION_DELIMITER = ":::";
const STATUS_ORDER = ["ok", "cancelled", "rate_limit", "quota", "error"] as const;

// ── Zod schemas for mock request bodies ──

const ApiKeyCreatePayloadSchema = z.looseObject({
  name: z.string().optional(),
  trafficClass: z.enum(TRAFFIC_CLASSES).optional(),
  transportPolicyOverride: z.enum(["smart", "always_http", "always_websocket"]).nullable().optional(),
  assignedAccountIds: z.array(z.string()).optional(),
  assignedSourceIds: z.array(z.string()).optional(),
});

const FirewallIpCreatePayloadSchema = z.looseObject({
  ipAddress: z.string().optional(),
});

const ApiKeyUpdatePayloadSchema = z.looseObject({
  name: z.string().optional(),
  allowedModels: z.array(z.string()).nullable().optional(),
  trafficClass: z.enum(TRAFFIC_CLASSES).optional(),
  transportPolicyOverride: z.enum(["smart", "always_http", "always_websocket"]).nullable().optional(),
  isActive: z.boolean().optional(),
  assignedAccountIds: z.array(z.string()).optional(),
  assignedSourceIds: z.array(z.string()).optional(),
  resetUsage: z.boolean().optional(),
  limits: z
    .array(
      z.object({
        limitType: z.enum(LIMIT_TYPES),
        limitWindow: z.enum(LIMIT_WINDOWS),
        maxValue: z.number(),
        modelFilter: z.string().nullable().optional(),
      }),
    )
    .optional(),
});

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
  /** LEGACY codex-lb account summaries for `/api/dashboard/overview` (until Step D). */
  legacyAccounts: AccountSummary[];
  requestLogs: RequestLogEntry[];
  conversations: ConversationEntry[];
  conversationDetails: ConversationDetails[];
  authStatus: AuthStatusWire;
  /** Password the mock auth endpoints accept once `authStatus.configured` is true. */
  password: string | null;
  totpEnabled: boolean;
  totpPending: boolean;
  settings: RuntimeSettingsWire;
  quotaPlannerSettings: QuotaPlannerSettings;
  quotaPlannerDecisions: QuotaPlannerDecision[];
  quotaPlannerForecast: QuotaPlannerForecast;
  apiKeys: ApiKey[];
  firewallEntries: Array<{ ipAddress: string; createdAt: string }>;
  stickySessions: Array<{
    key: string;
    displayName: string;
    kind: "codex_session" | "sticky_thread" | "prompt_cache";
    createdAt: string;
    updatedAt: string;
    expiresAt: string | null;
    isStale: boolean;
  }>;
};

function createInitialState(): MockState {
  return {
    accounts: createDefaultAccountWires(),
    legacyAccounts: createDefaultAccounts(),
    requestLogs: createDefaultRequestLogs(),
    conversations: createDefaultConversations(),
    conversationDetails: [
      createConversationDetails({ conversationId: "conv_abc" }),
      createConversationDetails({
        conversationId: "conv_def",
        accountCount: 1,
        dominantUseragentGroup: "codex",
      }),
    ],
    authStatus: createAuthStatus(),
    password: MOCK_DASHBOARD_PASSWORD,
    totpEnabled: false,
    totpPending: false,
    settings: createRuntimeSettings(),
    quotaPlannerSettings: createQuotaPlannerSettings(),
    quotaPlannerDecisions: [createQuotaPlannerDecision()],
    quotaPlannerForecast: createQuotaPlannerForecast(),
    apiKeys: createDefaultApiKeys(),
    firewallEntries: [],
    stickySessions: [],
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

function parseDateValue(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function filterRequestLogs(
  url: URL,
  options?: { includeStatuses?: boolean; ignoreApiKeyIds?: boolean },
): RequestLogEntry[] {
  const includeStatuses = options?.includeStatuses ?? true;
  const ignoreApiKeyIds = options?.ignoreApiKeyIds ?? false;
  const accountIds = new Set(url.searchParams.getAll("accountId"));
  const apiKeyIds = new Set(url.searchParams.getAll("apiKeyId"));
  const statuses = new Set(
    url.searchParams.getAll("status").map((value) => value.toLowerCase()),
  );
  const models = new Set(url.searchParams.getAll("model"));
  const reasoningEfforts = new Set(url.searchParams.getAll("reasoningEffort"));
  const modelOptions = new Set(url.searchParams.getAll("modelOption"));
  const search = (url.searchParams.get("search") || "").trim().toLowerCase();
  const since = parseDateValue(url.searchParams.get("since"));
  const until = parseDateValue(url.searchParams.get("until"));

  return state.requestLogs.filter((entry) => {
    if (
      accountIds.size > 0 &&
      (!entry.accountId || !accountIds.has(entry.accountId))
    ) {
      return false;
    }
    if (
      !ignoreApiKeyIds &&
      apiKeyIds.size > 0 &&
      (!entry.apiKeyId || !apiKeyIds.has(entry.apiKeyId))
    ) {
      return false;
    }

    if (
      includeStatuses &&
      statuses.size > 0 &&
      !statuses.has("all") &&
      !statuses.has(entry.status)
    ) {
      return false;
    }

    if (models.size > 0 && !models.has(entry.model)) {
      return false;
    }

    if (reasoningEfforts.size > 0) {
      const effort = entry.reasoningEffort ?? "";
      if (!reasoningEfforts.has(effort)) {
        return false;
      }
    }

    if (modelOptions.size > 0) {
      const key = `${entry.model}${MODEL_OPTION_DELIMITER}${entry.reasoningEffort ?? ""}`;
      const matchNoEffort = modelOptions.has(entry.model);
      if (!modelOptions.has(key) && !matchNoEffort) {
        return false;
      }
    }

    const timestamp = new Date(entry.requestedAt).getTime();
    if (since !== null && timestamp < since) {
      return false;
    }
    if (until !== null && timestamp > until) {
      return false;
    }

    if (search.length > 0) {
      const haystack = [
        entry.accountId,
        entry.apiKeyId,
        entry.apiKeyName,
        entry.requestId,
        entry.model,
        entry.reasoningEffort,
        entry.errorCode,
        entry.errorMessage,
        entry.status,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(search)) {
        return false;
      }
    }

    return true;
  });
}

function requestLogOptionsFromEntries(
  entries: RequestLogEntry[],
  apiKeyEntries: RequestLogEntry[] = entries,
) {
  const accountIds = [
    ...new Set(
      entries
        .map((entry) => entry.accountId)
        .filter((id): id is string => id != null),
    ),
  ].sort();

  const modelMap = new Map<
    string,
    { model: string; reasoningEffort: string | null }
  >();
  for (const entry of entries) {
    const key = `${entry.model}${MODEL_OPTION_DELIMITER}${entry.reasoningEffort ?? ""}`;
    if (!modelMap.has(key)) {
      modelMap.set(key, {
        model: entry.model,
        reasoningEffort: entry.reasoningEffort ?? null,
      });
    }
  }
  const modelOptionsList = [...modelMap.values()].sort((a, b) => {
    if (a.model !== b.model) {
      return a.model.localeCompare(b.model);
    }
    return (a.reasoningEffort ?? "").localeCompare(b.reasoningEffort ?? "");
  });

  const apiKeyMap = new Map<
    string,
    { id: string; name: string; keyPrefix: string | null }
  >();
  for (const entry of apiKeyEntries) {
    if (!entry.apiKeyId) continue;
    const apiKey = findApiKey(entry.apiKeyId);
    apiKeyMap.set(entry.apiKeyId, {
      id: entry.apiKeyId,
      name: apiKey?.name ?? entry.apiKeyName ?? entry.apiKeyId,
      keyPrefix: apiKey?.keyPrefix ?? null,
    });
  }
  const apiKeys = [...apiKeyMap.values()].sort((a, b) => {
    if (a.name !== b.name) {
      return a.name.localeCompare(b.name);
    }
    return (a.keyPrefix ?? "").localeCompare(b.keyPrefix ?? "");
  });

  const presentStatuses = new Set(entries.map((entry) => entry.status));
  const statuses = STATUS_ORDER.filter((status) => presentStatuses.has(status));

  return createRequestLogFilterOptions({
    accountIds,
    modelOptions: modelOptionsList,
    apiKeys,
    statuses: [...statuses],
  });
}

function findApiKey(keyId: string): ApiKey | undefined {
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
    state.authStatus = { ...state.authStatus, authenticated: true, reason: "", totp_enabled: state.totpEnabled };
    return HttpResponse.json(state.authStatus);
  }),

  http.post("/api/auth/logout", () => {
    // Loopback without a password stays trusted after logout, as on the real server.
    state.authStatus = { ...state.authStatus, authenticated: !state.authStatus.configured };
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
    state.authStatus = { ...state.authStatus, authenticated: !state.authStatus.configured };
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

export const handlers = [
  ...claudeLbHandlers,
  ...accountHandlers,

  http.get("/api/dashboard/overview", () => {
    return HttpResponse.json(
      createDashboardOverview({
        accounts: state.legacyAccounts,
      }),
    );
  }),

  http.get("/api/dashboard/projections", () => {
    return HttpResponse.json(createDashboardProjections());
  }),

  http.get("/api/request-logs", ({ request }) => {
    const url = legacyRequestUrl(request);
    const filtered = filterRequestLogs(url);
    const total = filtered.length;
    const limitRaw = Number(url.searchParams.get("limit") ?? 50);
    const offsetRaw = Number(url.searchParams.get("offset") ?? 0);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 50;
    const offset =
      Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
    const requests = filtered.slice(offset, offset + limit);
    return HttpResponse.json(
      createRequestLogsResponse(requests, total, offset + limit < total),
    );
  }),

  http.get("/api/request-logs/options", ({ request }) => {
    const url = legacyRequestUrl(request);
    const filtered = filterRequestLogs(url, {
      includeStatuses: false,
    });
    const apiKeyFiltered = filterRequestLogs(url, {
      includeStatuses: false,
      ignoreApiKeyIds: true,
    });
    return HttpResponse.json(
      requestLogOptionsFromEntries(filtered, apiKeyFiltered),
    );
  }),

  http.get("/api/conversations", ({ request }) => {
    const url = legacyRequestUrl(request);
    const search = (url.searchParams.get("search") || "").trim().toLowerCase();
    const filtered = state.conversations.filter((entry) => {
      if (search.length === 0) {
        return true;
      }
      return entry.conversationId.toLowerCase().includes(search);
    });
    const total = filtered.length;
    const limitRaw = Number(url.searchParams.get("limit") ?? 50);
    const offsetRaw = Number(url.searchParams.get("offset") ?? 0);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 50;
    const offset =
      Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
    const conversations = filtered.slice(offset, offset + limit);
    return HttpResponse.json(
      createConversationsResponse(conversations, total, offset + limit < total),
    );
  }),

  http.get("/api/conversations/:conversationId", ({ params }) => {
    const rawId = decodeURIComponent(String(params.conversationId));
    const trimmed = rawId.trim();
    if (!trimmed) {
      return HttpResponse.json(
        { error: { code: "not_found", message: "Conversation not found" } },
        { status: 404 },
      );
    }
    const details = state.conversationDetails.find(
      (item) => item.conversationId === trimmed,
    );
    if (!details) {
      return HttpResponse.json(
        { error: { code: "not_found", message: "Conversation not found" } },
        { status: 404 },
      );
    }
    return HttpResponse.json(details);
  }),

  http.get("/api/firewall/ips", () => {
    return HttpResponse.json({
      mode:
        state.firewallEntries.length === 0 ? "allow_all" : "allowlist_active",
      entries: state.firewallEntries,
    });
  }),

  http.post("/api/firewall/ips", async ({ request }) => {
    const payload = await parseJsonBody(request, FirewallIpCreatePayloadSchema);
    const ipAddress = String(payload?.ipAddress || "").trim();
    if (!ipAddress) {
      return HttpResponse.json(
        { error: { code: "invalid_ip", message: "IP address is required" } },
        { status: 400 },
      );
    }
    if (state.firewallEntries.some((entry) => entry.ipAddress === ipAddress)) {
      return HttpResponse.json(
        { error: { code: "ip_exists", message: "IP address already exists" } },
        { status: 409 },
      );
    }
    const created = { ipAddress, createdAt: new Date().toISOString() };
    state.firewallEntries = [...state.firewallEntries, created];
    return HttpResponse.json(created);
  }),

  http.delete("/api/firewall/ips/:ipAddress", ({ params }) => {
    const ipAddress = decodeURIComponent(String(params.ipAddress));
    const exists = state.firewallEntries.some(
      (entry) => entry.ipAddress === ipAddress,
    );
    if (!exists) {
      return HttpResponse.json(
        { error: { code: "ip_not_found", message: "IP address not found" } },
        { status: 404 },
      );
    }
    state.firewallEntries = state.firewallEntries.filter(
      (entry) => entry.ipAddress !== ipAddress,
    );
    return HttpResponse.json({ status: "deleted" });
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

  http.get("/api/sticky-sessions", ({ request }) => {
    const url = legacyRequestUrl(request);
    const staleOnly = url.searchParams.get("staleOnly") === "true";
    const accountQuery = (url.searchParams.get("accountQuery") ?? "")
      .trim()
      .toLowerCase();
    const keyQuery = (url.searchParams.get("keyQuery") ?? "")
      .trim()
      .toLowerCase();
    const sortBy = url.searchParams.get("sortBy") ?? "updated_at";
    const sortDir = url.searchParams.get("sortDir") ?? "desc";
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "10");
    const filteredEntries = state.stickySessions
      .filter((entry) => {
        if (staleOnly && !(entry.kind === "prompt_cache" && entry.isStale)) {
          return false;
        }
        if (
          accountQuery &&
          !entry.displayName.toLowerCase().includes(accountQuery)
        ) {
          return false;
        }
        if (keyQuery && !entry.key.toLowerCase().includes(keyQuery)) {
          return false;
        }
        return true;
      })
      .sort((left, right) => {
        const direction = sortDir === "asc" ? 1 : -1;
        if (sortBy === "account") {
          return left.displayName.localeCompare(right.displayName) * direction;
        }
        if (sortBy === "key") {
          return left.key.localeCompare(right.key) * direction;
        }
        const leftTime = Date.parse(
          sortBy === "created_at" ? left.createdAt : left.updatedAt,
        );
        const rightTime = Date.parse(
          sortBy === "created_at" ? right.createdAt : right.updatedAt,
        );
        if (leftTime !== rightTime) {
          return (leftTime - rightTime) * direction;
        }
        return left.key.localeCompare(right.key);
      });
    const entries = filteredEntries.slice(offset, offset + limit);
    const stalePromptCacheCount = state.stickySessions.filter(
      (entry) => entry.kind === "prompt_cache" && entry.isStale,
    ).length;
    return HttpResponse.json({
      entries,
      stalePromptCacheCount,
      total: filteredEntries.length,
      hasMore: offset + entries.length < filteredEntries.length,
    });
  }),
  http.post("/api/sticky-sessions/delete", async ({ request }) => {
    const payload = (await parseJsonBody(
      request,
      z.object({
        sessions: z
          .array(
            z.object({
              key: z.string().min(1),
              kind: z.enum(["codex_session", "sticky_thread", "prompt_cache"]),
            }),
          )
          .min(1)
          .max(500)
          .refine(
            (sessions) =>
              new Set(
                sessions.map((session) => `${session.kind}:${session.key}`),
              ).size === sessions.length,
            "Duplicate sticky session targets are not allowed",
          ),
      }),
    )) ?? { sessions: [] };
    const targets = new Set(
      payload.sessions.map((session) => `${session.kind}:${session.key}`),
    );
    const deleted = state.stickySessions
      .filter((entry) => targets.has(`${entry.kind}:${entry.key}`))
      .map((entry) => ({ key: entry.key, kind: entry.kind }));
    const deletedTargets = new Set(
      deleted.map((entry) => `${entry.kind}:${entry.key}`),
    );
    state.stickySessions = state.stickySessions.filter(
      (entry) => !targets.has(`${entry.kind}:${entry.key}`),
    );
    return HttpResponse.json({
      deletedCount: deleted.length,
      deleted,
      failed: payload.sessions
        .filter(
          (session) => !deletedTargets.has(`${session.kind}:${session.key}`),
        )
        .map((session) => ({
          key: session.key,
          kind: session.kind,
          reason: "not_found",
        })),
    });
  }),

  http.post("/api/sticky-sessions/delete-filtered", async ({ request }) => {
    const payload = (await parseJsonBody(
      request,
      z.object({
        staleOnly: z.boolean().default(false),
        accountQuery: z.string().default(""),
        keyQuery: z.string().default(""),
      }),
    )) ?? {
      staleOnly: false,
      accountQuery: "",
      keyQuery: "",
    };
    const accountQuery = payload.accountQuery.trim().toLowerCase();
    const keyQuery = payload.keyQuery.trim().toLowerCase();
    const matched = state.stickySessions.filter((entry) => {
      if (
        payload.staleOnly &&
        !(entry.kind === "prompt_cache" && entry.isStale)
      ) {
        return false;
      }
      if (
        accountQuery &&
        !entry.displayName.toLowerCase().includes(accountQuery)
      ) {
        return false;
      }
      if (keyQuery && !entry.key.toLowerCase().includes(keyQuery)) {
        return false;
      }
      return true;
    });
    const targets = new Set(
      matched.map((entry) => `${entry.kind}:${entry.key}`),
    );
    state.stickySessions = state.stickySessions.filter(
      (entry) => !targets.has(`${entry.kind}:${entry.key}`),
    );
    return HttpResponse.json({ deletedCount: matched.length });
  }),

  http.post("/api/sticky-sessions/purge", async ({ request }) => {
    const payload = (await parseJsonBody(
      request,
      z.object({ staleOnly: z.boolean().default(true) }),
    )) ?? {
      staleOnly: true,
    };
    if (payload.staleOnly) {
      const before = state.stickySessions.length;
      state.stickySessions = state.stickySessions.filter(
        (entry) => !entry.isStale,
      );
      return HttpResponse.json({
        deletedCount: before - state.stickySessions.length,
      });
    }
    const deletedCount = state.stickySessions.length;
    state.stickySessions = [];
    return HttpResponse.json({ deletedCount });
  }),

  http.get("/api/models", () => {
    return HttpResponse.json({
      models: [
        { id: "gpt-5.1", name: "GPT 5.1" },
        { id: "gpt-5.1-codex-mini", name: "GPT 5.1 Codex Mini" },
        { id: "gpt-4o-mini", name: "GPT 4o Mini" },
      ],
    });
  }),

  http.get("/api/api-keys/", () => {
    return HttpResponse.json(state.apiKeys);
  }),

  http.post("/api/api-keys/", async ({ request }) => {
    const payload = await parseJsonBody(request, ApiKeyCreatePayloadSchema);
    const sequence = state.apiKeys.length + 1;
    const created = createApiKeyCreateResponse({
      ...createApiKey({
        id: `key_${sequence}`,
        name: payload?.name ?? `API Key ${sequence}`,
        accountAssignmentScopeEnabled:
          (payload?.assignedAccountIds?.length ?? 0) > 0,
        sourceAssignmentScopeEnabled:
          (payload?.assignedSourceIds?.length ?? 0) > 0,
        assignedAccountIds: payload?.assignedAccountIds ?? [],
        assignedSourceIds: payload?.assignedSourceIds ?? [],
        trafficClass: payload?.trafficClass ?? "foreground",
      }),
      key: `sk-test-generated-${sequence}`,
    });
    state.apiKeys = [...state.apiKeys, createApiKey(created)];
    return HttpResponse.json(created);
  }),

  http.patch("/api/api-keys/:keyId", async ({ params, request }) => {
    const keyId = String(params.keyId);
    const existing = findApiKey(keyId);
    if (!existing) {
      return HttpResponse.json(
        { error: { code: "not_found", message: "API key not found" } },
        { status: 404 },
      );
    }
    const payload = await parseJsonBody(request, ApiKeyUpdatePayloadSchema);
    if (!payload) {
      return HttpResponse.json(existing);
    }

    // Build override with converted limits (create format → response format)
    const overrides: Partial<ApiKey> = {
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(payload.allowedModels !== undefined
        ? { allowedModels: payload.allowedModels }
        : {}),
      ...(payload.isActive !== undefined ? { isActive: payload.isActive } : {}),
      ...(payload.trafficClass !== undefined
        ? { trafficClass: payload.trafficClass }
        : {}),
      ...(payload.assignedAccountIds !== undefined
        ? {
            accountAssignmentScopeEnabled:
              payload.assignedAccountIds.length > 0,
          }
        : {}),
      ...(payload.assignedAccountIds !== undefined
        ? { assignedAccountIds: payload.assignedAccountIds }
        : {}),
      ...(payload.assignedSourceIds !== undefined
        ? {
            sourceAssignmentScopeEnabled:
              payload.assignedSourceIds.length > 0,
            assignedSourceIds: payload.assignedSourceIds,
          }
        : {}),
    };

    if (payload.limits) {
      overrides.limits = payload.limits.map((l, idx) => ({
        id: idx + 100,
        limitType: l.limitType,
        limitWindow: l.limitWindow,
        maxValue: l.maxValue,
        currentValue: 0,
        modelFilter: l.modelFilter ?? null,
        resetAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      }));
    }

    const updated = createApiKey({
      ...existing,
      ...overrides,
      id: keyId,
    });
    state.apiKeys = state.apiKeys.map((item) =>
      item.id === keyId ? updated : item,
    );
    return HttpResponse.json(updated);
  }),

  http.delete("/api/api-keys/:keyId", ({ params }) => {
    const keyId = String(params.keyId);
    const exists = state.apiKeys.some((item) => item.id === keyId);
    if (!exists) {
      return HttpResponse.json(
        { error: { code: "not_found", message: "API key not found" } },
        { status: 404 },
      );
    }
    state.apiKeys = state.apiKeys.filter((item) => item.id !== keyId);
    return new HttpResponse(null, { status: 204 });
  }),

  http.post("/api/api-keys/:keyId/regenerate", ({ params }) => {
    const keyId = String(params.keyId);
    const existing = findApiKey(keyId);
    if (!existing) {
      return HttpResponse.json(
        { error: { code: "not_found", message: "API key not found" } },
        { status: 404 },
      );
    }
    const regenerated = createApiKeyCreateResponse({
      ...existing,
      key: `sk-test-regenerated-${keyId}`,
    });
    state.apiKeys = state.apiKeys.map((item) =>
      item.id === keyId ? createApiKey(regenerated) : item,
    );
    return HttpResponse.json(regenerated);
  }),

  http.get("/api/api-keys/:keyId/trends", ({ params }) => {
    const keyId = String(params.keyId);
    const existing = findApiKey(keyId);
    if (!existing) {
      return HttpResponse.json(
        { error: { code: "not_found", message: "API key not found" } },
        { status: 404 },
      );
    }
    return HttpResponse.json(createApiKeyTrends({ keyId }));
  }),

  http.get("/api/api-keys/:keyId/usage-7d", ({ params }) => {
    const keyId = String(params.keyId);
    const existing = findApiKey(keyId);
    if (!existing) {
      return HttpResponse.json(
        { error: { code: "not_found", message: "API key not found" } },
        { status: 404 },
      );
    }
    return HttpResponse.json(createApiKeyUsage7Day({ keyId }));
  }),
];
