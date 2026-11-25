import type { z } from "zod";
import type { AccountSummary } from "@/features/dashboard/legacy-account-schemas";
import { AccountSummarySchema } from "@/features/dashboard/legacy-account-schemas";
import type { ApiKey, ApiKeyCreateResponse } from "@/features/api-keys/schemas";
import {
	ApiKeyCreateResponseSchema,
	ApiKeySchema,
} from "@/features/api-keys/schemas";
import type {
	ApiKeyTrendsResponse,
	ApiKeyUsage7DayResponse,
} from "@/features/apis/schemas";
import {
	ApiKeyTrendsResponseSchema,
	ApiKeyUsage7DayResponseSchema,
} from "@/features/apis/schemas";
import type {
	DashboardOverview,
	DashboardProjections,
	RequestLog,
	RequestLogFilterOptions,
	RequestLogsResponse,
	OverviewTimeframe,
} from "@/features/dashboard/schemas";
import {
	ConversationDetailsSchema,
	ConversationEntrySchema,
	ConversationsResponseSchema,
	ConversationModelStatSchema,
	DEFAULT_OVERVIEW_TIMEFRAME,
	DashboardOverviewSchema,
	DashboardProjectionsSchema,
	RequestLogFilterOptionsSchema,
	RequestLogSchema,
	RequestLogsResponseSchema,
} from "@/features/dashboard/schemas";
import type {
	QuotaPlannerDecision,
	QuotaPlannerForecast,
	QuotaPlannerSettings,
} from "@/features/quota-planner/schemas";
import {
	QuotaPlannerDecisionSchema,
	QuotaPlannerForecastSchema,
	QuotaPlannerSettingsSchema,
	QuotaPlannerWarmupActionResponseSchema,
} from "@/features/quota-planner/schemas";

// Backward-compatible type aliases
export type RequestLogEntry = RequestLog;
export type ConversationEntry = z.infer<typeof ConversationEntrySchema>;
export type ConversationsResponse = z.infer<typeof ConversationsResponseSchema>;
export type ConversationDetails = z.infer<typeof ConversationDetailsSchema>;
export type ConversationModelStat = z.infer<typeof ConversationModelStatSchema>;
export type { QuotaPlannerDecision, QuotaPlannerForecast, QuotaPlannerSettings };
export type QuotaPlannerWarmupActionResponse = z.infer<typeof QuotaPlannerWarmupActionResponseSchema>;

export type {
	AccountSummary,
	DashboardOverview,
	DashboardProjections,
	RequestLogsResponse,
	RequestLogFilterOptions,
	ApiKey,
	ApiKeyCreateResponse,
	ApiKeyTrendsResponse,
	ApiKeyUsage7DayResponse,
};

const BASE_TIME = new Date("2026-01-01T12:00:00Z");

function offsetIso(minutes: number): string {
	return new Date(BASE_TIME.getTime() + minutes * 60_000).toISOString();
}

export function createAccountSummary(
	overrides: Partial<AccountSummary> = {},
): AccountSummary {
	return AccountSummarySchema.parse({
		accountId: "acc_primary",
		chatgptAccountId: "chatgpt_acc_primary",
		email: "primary@example.com",
		alias: null,
		displayName: "primary@example.com",
		planType: "plus",
		routingPolicy: "normal",
		status: "active",
		securityWorkAuthorized: false,
		usage: {
			primaryRemainingPercent: 82,
			secondaryRemainingPercent: 67,
			monthlyRemainingPercent: null,
		},
		resetAtPrimary: offsetIso(60),
		resetAtSecondary: offsetIso(24 * 60),
		resetAtMonthly: null,
		windowMinutesPrimary: 300,
		windowMinutesSecondary: 10_080,
		windowMinutesMonthly: null,
		capacityCreditsPrimary: 225,
		remainingCreditsPrimary: 184.5,
		capacityCreditsSecondary: 7_560,
		remainingCreditsSecondary: 5_065.2,
		capacityCreditsMonthly: null,
		remainingCreditsMonthly: null,
		creditsHas: true,
		creditsUnlimited: false,
		creditsBalance: 932,
		auth: {
			access: { expiresAt: offsetIso(30), state: null },
			refresh: { state: "stored" },
			idToken: { state: "parsed" },
		},
		limitWarmupEnabled: false,
		limitWarmup: null,
		...overrides,
	});
}

export function createDefaultAccounts(): AccountSummary[] {
	return [
		createAccountSummary(),
		createAccountSummary({
			accountId: "acc_secondary",
			email: "secondary@example.com",
			displayName: "secondary@example.com",
			status: "paused",
			usage: {
				primaryRemainingPercent: 45,
				secondaryRemainingPercent: 12,
			},
		}),
	];
}

function createTrendPoints(
	baseValue: number,
	count = 28,
	bucketSeconds = 6 * 3600,
): Array<{ t: string; v: number }> {
	return Array.from({ length: count }, (_, i) => ({
		t: new Date(BASE_TIME.getTime() - (count - i) * bucketSeconds * 1000).toISOString(),
		v: Math.max(0, baseValue + Math.sin(i) * baseValue * 0.3),
	}));
}

function createOverviewTimeframe(
	key: OverviewTimeframe = DEFAULT_OVERVIEW_TIMEFRAME,
) {
	switch (key) {
		case "1d":
			return {
				key,
				windowMinutes: 1_440,
				bucketSeconds: 3_600,
				bucketCount: 24,
			};
		case "30d":
			return {
				key,
				windowMinutes: 43_200,
				bucketSeconds: 86_400,
				bucketCount: 30,
			};
		case "7d":
		default:
			return {
				key: "7d" as const,
				windowMinutes: 10_080,
				bucketSeconds: 21_600,
				bucketCount: 28,
			};
	}
}

export function createDashboardOverview(
	overrides: Partial<DashboardOverview> = {},
): DashboardOverview {
	const timeframe = overrides.timeframe ?? createOverviewTimeframe();
	const accounts = overrides.accounts ?? createDefaultAccounts();
	const response = {
		lastSyncAt: offsetIso(-5),
		timeframe,
		accounts,
		summary: {
			primaryWindow: {
				remainingPercent: 63.5,
				capacityCredits: 225,
				remainingCredits: 142.875,
				resetAt: offsetIso(60),
				windowMinutes: 300,
			},
			secondaryWindow: {
				remainingPercent: 55.2,
				capacityCredits: 7560,
				remainingCredits: 4173.12,
				resetAt: offsetIso(24 * 60),
				windowMinutes: 10_080,
			},
			cost: {
				currency: "USD",
				totalUsd: 1.82,
			},
			metrics: {
				requests: 228,
				tokens: 45_000,
				cachedInputTokens: 8_200,
				errorRate: 0.028,
				errorCount: 6,
				topError: "rate_limit_exceeded",
				conversationRequests: 0,
			},
		},
		windows: {
			primary: {
				windowKey: "primary",
				windowMinutes: 300,
				accounts: accounts.map((account) => ({
					accountId: account.accountId,
					remainingPercentAvg: account.usage?.primaryRemainingPercent ?? 0,
					capacityCredits: 225,
					remainingCredits:
						((account.usage?.primaryRemainingPercent ?? 0) / 100) * 225,
				})),
			},
			secondary: {
				windowKey: "secondary",
				windowMinutes: 10_080,
				accounts: accounts.map((account) => ({
					accountId: account.accountId,
					remainingPercentAvg: account.usage?.secondaryRemainingPercent ?? 0,
					capacityCredits: account.capacityCreditsSecondary ?? 7560,
					remainingCredits:
						account.remainingCreditsSecondary ??
						((account.usage?.secondaryRemainingPercent ?? 0) / 100) *
							(account.capacityCreditsSecondary ?? 7560),
				})),
			},
		},
		trends: {
			requests: createTrendPoints(8, timeframe.bucketCount, timeframe.bucketSeconds),
			tokens: createTrendPoints(1600, timeframe.bucketCount, timeframe.bucketSeconds),
			cost: createTrendPoints(0.065, timeframe.bucketCount, timeframe.bucketSeconds),
			errorRate: createTrendPoints(0.03, timeframe.bucketCount, timeframe.bucketSeconds),
			conversations: createTrendPoints(1, timeframe.bucketCount, timeframe.bucketSeconds),
		},
		depletionPrimary: {
			risk: 0.55,
			riskLevel: "warning" as const,
			burnRate: 1.1,
			safeUsagePercent: 72.0,
			projectedExhaustionAt: null,
			secondsUntilExhaustion: null,
		},
		depletionSecondary: {
			risk: 0.65,
			riskLevel: "warning" as const,
			burnRate: 1.4,
			safeUsagePercent: 58.0,
			projectedExhaustionAt: null,
			secondsUntilExhaustion: null,
		},
		...overrides,
	};
	return DashboardOverviewSchema.parse(response);
}

export function createDashboardProjections(
	overrides: Partial<DashboardProjections> = {},
): DashboardProjections {
	return DashboardProjectionsSchema.parse({
		depletionPrimary: {
			risk: 0.55,
			riskLevel: "warning" as const,
			burnRate: 1.1,
			safeUsagePercent: 72.0,
			projectedExhaustionAt: null,
			secondsUntilExhaustion: null,
		},
		depletionSecondary: {
			risk: 0.65,
			riskLevel: "warning" as const,
			burnRate: 1.4,
			safeUsagePercent: 58.0,
			projectedExhaustionAt: null,
			secondsUntilExhaustion: null,
		},
		weeklyCreditPace: null,
		...overrides,
	});
}

export function createRequestLogEntry(
	overrides: Partial<RequestLogEntry> = {},
): RequestLogEntry {
	return RequestLogSchema.parse({
		requestedAt: offsetIso(-1),
		accountId: "acc_primary",
		apiKeyId: "key_1",
		apiKeyName: "Primary Key",
		requestId: "req_1",
		requestKind: "normal",
		model: "gpt-5.1",
		source: null,
		transport: "http",
		useragent: null,
		useragentGroup: null,
		clientIp: null,
		conversationId: null,
		serviceTier: null,
		requestedServiceTier: null,
		actualServiceTier: null,
		status: "ok",
		errorCode: null,
		errorMessage: null,
		tokens: 1800,
		inputTokens: 1200,
		outputTokens: 600,
		cachedInputTokens: 320,
		reasoningEffort: null,
		costUsd: 0.0132,
		costBreakdown: {
			inputUsd: 0.0054,
			cachedInputUsd: 0.0012,
			outputUsd: 0.0066,
			totalUsd: 0.0132,
		},
		latencyMs: 920,
		...overrides,
	});
}

export function createDefaultRequestLogs(): RequestLogEntry[] {
	return [
		createRequestLogEntry(),
		createRequestLogEntry({
			requestId: "req_2",
			accountId: "acc_secondary",
			apiKeyId: "key_2",
			apiKeyName: "Secondary Key",
			status: "rate_limit",
			errorCode: "rate_limit_exceeded",
			errorMessage: "Rate limit reached",
			tokens: 0,
			cachedInputTokens: null,
			costUsd: 0,
			requestedAt: offsetIso(-2),
		}),
		createRequestLogEntry({
			requestId: "req_3",
			apiKeyId: null,
			apiKeyName: null,
			status: "quota",
			errorCode: "insufficient_quota",
			errorMessage: "Quota exceeded",
			tokens: 0,
			cachedInputTokens: null,
			costUsd: 0,
			requestedAt: offsetIso(-3),
		}),
	];
}

export function createRequestLogsResponse(
	requests: RequestLogEntry[],
	total: number,
	hasMore: boolean,
): RequestLogsResponse {
	return RequestLogsResponseSchema.parse({
		requests,
		total,
		hasMore,
	});
}

export function createRequestLogFilterOptions(
	overrides: Partial<RequestLogFilterOptions> = {},
): RequestLogFilterOptions {
	return RequestLogFilterOptionsSchema.parse({
		accountIds: ["acc_primary", "acc_secondary"],
		modelOptions: [
			{ model: "gpt-5.1", reasoningEffort: null },
			{ model: "gpt-5.1", reasoningEffort: "high" },
		],
		apiKeys: [
			{ id: "key_1", name: "Default key", keyPrefix: "sk-test" },
			{ id: "key_2", name: "Read only key", keyPrefix: "sk-second" },
		],
		statuses: ["ok", "rate_limit", "quota"],
		...overrides,
	});
}

export function createQuotaPlannerSettings(
	overrides: Partial<QuotaPlannerSettings> = {},
): QuotaPlannerSettings {
	return QuotaPlannerSettingsSchema.parse({
		mode: "shadow",
		timezone: "UTC",
		workingDays: [0, 1, 2, 3, 4],
		workingHoursStart: "09:00",
		workingHoursEnd: "18:00",
		prewarmEnabled: true,
		prewarmLeadMinutes: 300,
		maxWarmupsPerDay: 3,
		maxWarmupCreditsPerDay: 0,
		minExpectedGain: 1,
		forecastQuantile: "p75",
		allowSyntheticTraffic: false,
		warmupModelPreference: null,
		dryRun: true,
		...overrides,
	});
}

export function createQuotaPlannerDecision(
	overrides: Partial<QuotaPlannerDecision> = {},
): QuotaPlannerDecision {
	return QuotaPlannerDecisionSchema.parse({
		id: "decision_1",
		createdAt: new Date().toISOString(),
		mode: "shadow",
		accountId: "acc_primary",
		action: "reserve",
		scheduledAt: new Date().toISOString(),
		executedAt: null,
		score: 12.5,
		reason: "forecast_phase_alignment",
		status: "skipped",
		idempotencyKey: "mock-decision-1",
		...overrides,
	});
}

export function createQuotaPlannerForecast(
	overrides: Partial<QuotaPlannerForecast> = {},
): QuotaPlannerForecast {
	return QuotaPlannerForecastSchema.parse({
		generatedAt: new Date().toISOString(),
		horizonHours: 36,
		slotSeconds: 900,
		totalDemandUnits: 48,
		peakSlotStart: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
		peakDemandUnits: 8,
		simulation: {
			loss: 4,
			unmetDemand: 3,
			wastedCapacity: 1,
			coldStartPenalty: 0,
			synchronizationPenalty: 0,
			forecastUnits: 48,
			servedUnits: 45,
		},
		slots: [],
		...overrides,
	});
}

export function createQuotaPlannerWarmupActionResponse(
	overrides: Partial<QuotaPlannerWarmupActionResponse> = {},
): QuotaPlannerWarmupActionResponse {
	return QuotaPlannerWarmupActionResponseSchema.parse({
		decisionId: "decision_1",
		status: "skipped",
		reason: "synthetic_traffic_disabled",
		requestId: null,
		executedAt: null,
		...overrides,
	});
}

export function createApiKey(overrides: Partial<ApiKey> = {}): ApiKey {
	return ApiKeySchema.parse({
		id: "key_1",
		name: "Default key",
		keyPrefix: "sk-test",
		allowedModels: ["gpt-5.1"],
		applyToCodexModel: false,
		transportPolicyOverride: null,
		expiresAt: null,
		isActive: true,
		accountAssignmentScopeEnabled: false,
		sourceAssignmentScopeEnabled: false,
		assignedAccountIds: [],
		assignedSourceIds: [],
		createdAt: offsetIso(-60),
		lastUsedAt: offsetIso(-5),
		usageSummary: {
			requestCount: 150,
			totalTokens: 50_000,
			cachedInputTokens: 10_000,
			totalCostUsd: 1.23,
		},
		limits: [
			{
				id: 1,
				limitType: "total_tokens",
				limitWindow: "weekly",
				maxValue: 1_000_000,
				currentValue: 125_000,
				modelFilter: null,
				resetAt: offsetIso(7 * 24 * 60),
			},
		],
		...overrides,
	});
}

export function createApiKeyCreateResponse(
	overrides: Partial<ApiKeyCreateResponse> = {},
): ApiKeyCreateResponse {
	return ApiKeyCreateResponseSchema.parse({
		...createApiKey(),
		key: "sk-test-generated-secret",
		...overrides,
	});
}

export function createDefaultApiKeys(): ApiKey[] {
	return [
		createApiKey(),
		createApiKey({
			id: "key_2",
			name: "Read only key",
			keyPrefix: "sk-second",
			allowedModels: ["gpt-4o-mini"],
			isActive: false,
			expiresAt: null,
			lastUsedAt: null,
			usageSummary: {
				requestCount: 42,
				totalTokens: 12_500,
				cachedInputTokens: 2_200,
				totalCostUsd: 0.42,
			},
			limits: [],
		}),
	];
}

function createApiKeyTrendPoints(count = 28): Array<{ t: string; v: number }> {
	return Array.from({ length: count }, (_, i) => ({
		t: new Date(BASE_TIME.getTime() - (count - i) * 6 * 3600_000).toISOString(),
		v: 10_000 + Math.round(Math.sin(i) * 5_000),
	}));
}

export function createApiKeyTrends(
	overrides: Partial<ApiKeyTrendsResponse> = {},
): ApiKeyTrendsResponse {
	return ApiKeyTrendsResponseSchema.parse({
		keyId: "key_1",
		cost: createApiKeyTrendPoints().map((p) => ({
			...p,
			v: +(p.v * 0.001).toFixed(4),
		})),
		tokens: createApiKeyTrendPoints(),
		...overrides,
	});
}

export function createApiKeyUsage7Day(
	overrides: Partial<ApiKeyUsage7DayResponse> = {},
): ApiKeyUsage7DayResponse {
	return ApiKeyUsage7DayResponseSchema.parse({
		keyId: "key_1",
		totalTokens: 280_000,
		cachedInputTokens: 45_000,
		totalRequests: 350,
		totalCostUsd: 2.47,
		...overrides,
	});
}

export function createConversationEntry(
	overrides: Partial<ConversationEntry> = {},
): ConversationEntry {
	return ConversationEntrySchema.parse({
		conversationId: "conv_abc",
		firstRequest: offsetIso(-2),
		lastRequest: offsetIso(-1),
		requestCount: 1,
		representativeAccount: "acc_primary",
		remainingAccountCount: 1,
		apiKeyId: "key_1",
		apiKeyName: "Primary Key",
		representativeModel: "gpt-5.1",
		remainingModelCount: 1,
		totalTokens: 1800,
		cachedInputTokens: 320,
		totalCostUsd: 0.0132,
		...overrides,
	});
}

export function createDefaultConversations(): ConversationEntry[] {
	return [
		createConversationEntry(),
		createConversationEntry({
			conversationId: "conv_def",
			lastRequest: offsetIso(-2),
			representativeAccount: "acc_secondary",
			remainingAccountCount: 0,
			apiKeyId: "key_2",
			apiKeyName: "Secondary Key",
			representativeModel: "gpt-5.1-codex",
			remainingModelCount: 0,
			totalTokens: 4200,
			cachedInputTokens: 0,
			totalCostUsd: 0.04,
		}),
	];
}

export function createConversationsResponse(
	conversations: ConversationEntry[],
	total: number,
	hasMore: boolean,
): ConversationsResponse {
	return ConversationsResponseSchema.parse({
		conversations,
		total,
		hasMore,
	});
}

export function createConversationModelStat(
	overrides: Partial<ConversationModelStat> = {},
): ConversationModelStat {
	return ConversationModelStatSchema.parse({
		modelEffort: { model: "gpt-5.1", reasoningEffort: "high" },
		reqs: 4,
		totalElapsedTime: 1200,
		totalInputTokens: 1000,
		cachedInputTokens: 200,
		totalOutputTokens: 300,
		totalCostUsd: 0.05,
		...overrides,
	});
}

export function createConversationDetails(
	overrides: Partial<ConversationDetails> = {},
): ConversationDetails {
	return ConversationDetailsSchema.parse({
		conversationId: "conv_abc",
		start: offsetIso(-10),
		latest: offsetIso(-1),
		accountCount: 2,
		totalElapsedTime: 4200,
		dominantUseragentGroup: "opencode",
		modelStats: [
			createConversationModelStat(),
			createConversationModelStat({
				modelEffort: { model: "gpt-5.1", reasoningEffort: null },
				reqs: 2,
				totalElapsedTime: 600,
				totalInputTokens: 500,
				cachedInputTokens: 0,
				totalOutputTokens: 100,
				totalCostUsd: 0.02,
			}),
		],
		...overrides,
	});
}

// ── claude-lb wire shapes (snake_case, exactly as the FastAPI backend sends them) ──
// Handlers for claude-lb endpoints return these raw; the api-client camelizes them.

export const MOCK_DASHBOARD_PASSWORD = "correct-horse-battery";
export const MOCK_BOOTSTRAP_TOKEN = "bootstrap-token-from-log";
export const MOCK_TOTP_CODE = "123456";

/** `GET /api/auth/status` (`AuthStatusOut`). */
export type AuthStatusWire = {
	configured: boolean;
	totp_enabled: boolean;
	authenticated: boolean;
	reason: string;
	auth_enabled: boolean;
};

export function createAuthStatus(overrides: Partial<AuthStatusWire> = {}): AuthStatusWire {
	return {
		configured: true,
		totp_enabled: false,
		authenticated: true,
		reason: "",
		auth_enabled: true,
		...overrides,
	};
}

/** `RuntimeSettings` from `claude_lb.modules.settings.service`. */
export type RuntimeSettingsWire = {
	routing_strategy: string;
	max_attempts: number;
	sticky_sessions_enabled: boolean;
	sticky_ttl_seconds: number;
	health_probe_enabled: boolean;
	health_probe_interval_seconds: number;
	model_sync_enabled: boolean;
	model_sync_interval_seconds: number;
	request_log_retention_days: number;
};

export const ROUTING_STRATEGIES_WIRE = [
	"capacity_weighted",
	"relative_availability",
	"usage_weighted",
	"reset_drain",
	"sequential_drain",
	"round_robin",
	"least_used",
	"fill_first",
	"single_account",
];

export function createRuntimeSettings(overrides: Partial<RuntimeSettingsWire> = {}): RuntimeSettingsWire {
	return {
		routing_strategy: "capacity_weighted",
		max_attempts: 3,
		sticky_sessions_enabled: true,
		sticky_ttl_seconds: 900,
		health_probe_enabled: true,
		health_probe_interval_seconds: 120,
		model_sync_enabled: true,
		model_sync_interval_seconds: 3600,
		request_log_retention_days: 30,
		...overrides,
	};
}

/** `GET/PATCH /api/settings` envelope. */
export function createSettingsEnvelope(overrides: Partial<RuntimeSettingsWire> = {}) {
	return { settings: createRuntimeSettings(overrides), available_strategies: [...ROUTING_STRATEGIES_WIRE] };
}

// ---------------------------------------------------------------------------
// claude-lb accounts (`/api/accounts`, `/api/usage/quota`) — snake_case wire shapes.
// ---------------------------------------------------------------------------

export type AccountWire = {
	id: string;
	name: string;
	provider: string;
	credential_hint: string;
	base_url: string | null;
	weight: number;
	priority: number;
	enabled: boolean;
	available: boolean;
	headroom: number;
	plan_type: string;
	routing_policy: string;
	capacity_credits: number | null;
	spend_cap_usd: number | null;
	blocked_models: string[];
	model_blocks: Array<{ model: string; until: string }>;
	paused: boolean;
	spend_cap_reached: boolean;
	consecutive_failures: number;
	effective_capacity: number;
	primary_used_percent: number | null;
	primary_reset_at: string | null;
	secondary_used_percent: number | null;
	secondary_reset_at: string | null;
	unified_status: string | null;
	overage_status: string | null;
	quota_status: string;
	quota_observed_at: string | null;
	disabled_reason: string | null;
	cooldown_until: string | null;
	rl_requests_limit: number | null;
	rl_requests_remaining: number | null;
	rl_tokens_limit: number | null;
	rl_tokens_remaining: number | null;
	rl_reset_at: string | null;
	total_requests: number;
	total_input_tokens: number;
	total_output_tokens: number;
	total_cost_usd: number;
	last_used_at: string | null;
	last_probe_at: string | null;
	last_probe_ok: boolean | null;
	last_probe_detail: string;
	models_synced_at: string | null;
	auth_scheme: string;
	credential_expires_at: string | null;
	last_refresh_at: string | null;
	refresh_failures: number;
	created_at: string;
};

const PLAN_CAPACITY: Record<string, number> = {
	free: 10,
	pro: 100,
	api: 100,
	team: 150,
	enterprise: 300,
	max: 500,
	max_5x: 500,
	max_20x: 2000,
};

function hoursFromNow(hours: number): string {
	return new Date(Date.now() + hours * 3_600_000).toISOString();
}

/** A Console API-key account as `GET /api/accounts` returns it. */
export function createAccountWire(overrides: Partial<AccountWire> = {}): AccountWire {
	const planType = overrides.plan_type ?? "api";
	return {
		id: "acc_console",
		name: "console",
		provider: "anthropic_api_key",
		credential_hint: "sk-ant-…a1b2",
		base_url: null,
		weight: 1,
		priority: 0,
		enabled: true,
		available: true,
		headroom: 0.92,
		plan_type: planType,
		routing_policy: "normal",
		capacity_credits: null,
		spend_cap_usd: null,
		blocked_models: [],
		model_blocks: [],
		paused: false,
		spend_cap_reached: false,
		consecutive_failures: 0,
		effective_capacity: PLAN_CAPACITY[planType] ?? 100,
		primary_used_percent: null,
		primary_reset_at: null,
		secondary_used_percent: null,
		secondary_reset_at: null,
		unified_status: null,
		overage_status: null,
		quota_status: "active",
		quota_observed_at: null,
		disabled_reason: null,
		cooldown_until: null,
		rl_requests_limit: 4000,
		rl_requests_remaining: 3680,
		rl_tokens_limit: 2_000_000,
		rl_tokens_remaining: 1_900_000,
		rl_reset_at: hoursFromNow(0.02),
		total_requests: 1234,
		total_input_tokens: 456_000,
		total_output_tokens: 78_900,
		total_cost_usd: 3.21,
		last_used_at: hoursFromNow(-0.1),
		last_probe_at: null,
		last_probe_ok: null,
		last_probe_detail: "",
		models_synced_at: null,
		auth_scheme: "x-api-key",
		credential_expires_at: null,
		last_refresh_at: null,
		refresh_failures: 0,
		created_at: "2026-11-01T09:00:00",
		...overrides,
	};
}

/** A Claude Max 5x subscription account with live 5h/7d utilization. */
export function createSubscriptionAccountWire(overrides: Partial<AccountWire> = {}): AccountWire {
	return createAccountWire({
		id: "acc_max",
		name: "alice-max",
		provider: "oauth",
		credential_hint: "sk-ant-oat01-…z9y8",
		plan_type: "max_5x",
		routing_policy: "burn_first",
		effective_capacity: 500,
		auth_scheme: "bearer",
		primary_used_percent: 42,
		primary_reset_at: hoursFromNow(2),
		secondary_used_percent: 18,
		secondary_reset_at: hoursFromNow(80),
		unified_status: "allowed",
		overage_status: "rejected",
		quota_observed_at: hoursFromNow(-0.05),
		rl_requests_limit: null,
		rl_requests_remaining: null,
		rl_tokens_limit: null,
		rl_tokens_remaining: null,
		rl_reset_at: null,
		credential_expires_at: hoursFromNow(24 * 300),
		...overrides,
	});
}

export function createDefaultAccountWires(): AccountWire[] {
	return [
		createSubscriptionAccountWire({
			blocked_models: ["claude-sonnet-5"],
			model_blocks: [{ model: "claude-sonnet-5", until: hoursFromNow(11) }],
		}),
		createAccountWire({ spend_cap_usd: 10 }),
		createAccountWire({
			id: "acc_paused",
			name: "backup-key",
			enabled: false,
			available: false,
			paused: true,
			disabled_reason: "paused by operator",
			routing_policy: "preserve",
			total_requests: 0,
			total_cost_usd: 0,
		}),
	];
}

export function createAccountTrendsWire(accountId: string, days = 7) {
	const today = new Date();
	const usage = Array.from({ length: days }, (_, index) => {
		const day = new Date(today.getTime() - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10);
		const requests = index === days - 1 ? 12 : index * 3;
		return {
			day,
			requests,
			errors: index === days - 1 ? 1 : 0,
			input_tokens: requests * 1000,
			output_tokens: requests * 200,
			cost_usd: +(requests * 0.01).toFixed(6),
		};
	});
	const quota = Array.from({ length: 6 }, (_, index) => ({
		t: new Date(Date.now() - (6 - index) * 3_600_000).toISOString(),
		primary_used_percent: 10 + index * 5,
		secondary_used_percent: 12 + index,
	}));
	const sum = (key: "requests" | "errors" | "input_tokens" | "output_tokens" | "cost_usd") =>
		usage.reduce((total, day) => total + day[key], 0);
	return {
		account_id: accountId,
		days,
		quota,
		usage,
		totals: {
			requests: sum("requests"),
			errors: sum("errors"),
			input_tokens: sum("input_tokens"),
			output_tokens: sum("output_tokens"),
			cost_usd: +sum("cost_usd").toFixed(6),
		},
	};
}

export function createPoolQuotaWire(accounts: AccountWire[]) {
	return {
		total_accounts: accounts.length,
		available_accounts: accounts.filter((account) => account.available).length,
		total_capacity_credits: accounts.reduce((total, account) => total + account.effective_capacity, 0),
		remaining_capacity_credits: 0,
		pool_remaining_percent: 100,
		accounts: accounts.map((account) => ({
			account_id: account.id,
			account_name: account.name,
			plan_type: account.plan_type,
			routing_policy: account.routing_policy,
			effective_capacity: account.effective_capacity,
			available: account.available,
			quota_status: account.quota_status,
			primary_used_percent: account.primary_used_percent,
			primary_reset_at: account.primary_reset_at,
			secondary_used_percent: account.secondary_used_percent,
			secondary_reset_at: account.secondary_reset_at,
			unified_status: account.unified_status,
			overage_status: account.overage_status,
			depletion_risk: account.plan_type === "api" ? 0 : 0.65,
			risk_level: account.plan_type === "api" ? "safe" : "warning",
		})),
	};
}
