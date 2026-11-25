const BASE_TIME = new Date("2026-01-01T12:00:00Z");

function offsetIso(minutes: number): string {
	return new Date(BASE_TIME.getTime() + minutes * 60_000).toISOString();
}

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
	role: "admin" | "guest";
	guest_access_enabled: boolean;
	guest_password_required: boolean;
};

export function createAuthStatus(overrides: Partial<AuthStatusWire> = {}): AuthStatusWire {
	return {
		configured: true,
		totp_enabled: false,
		authenticated: true,
		reason: "",
		auth_enabled: true,
		role: "admin",
		guest_access_enabled: false,
		guest_password_required: false,
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

// ── Dashboard (claude-lb wire shapes, snake_case) ──

export type MetricsWire = {
	requests: number;
	errors: number;
	error_rate: number;
	top_error: string | null;
	top_error_count: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
	total_tokens: number;
	cost_usd: number;
	cache_savings_usd: number;
	cache_hit_rate: number;
	conversations: number;
	avg_duration_ms: number | null;
	avg_ttft_ms: number | null;
};

export function createMetricsWire(overrides: Partial<MetricsWire> = {}): MetricsWire {
	return {
		requests: 1200,
		errors: 18,
		error_rate: 0.015,
		top_error: "Overloaded",
		top_error_count: 12,
		input_tokens: 540_000,
		output_tokens: 960_000,
		cache_read_input_tokens: 14_000_000,
		cache_creation_input_tokens: 2_100_000,
		total_tokens: 17_600_000,
		cost_usd: 84.21,
		cache_savings_usd: 51.3,
		cache_hit_rate: 0.84,
		conversations: 140,
		avg_duration_ms: 2400,
		avg_ttft_ms: 610,
		...overrides,
	};
}

const OVERVIEW_FRAMES = {
	"1h": { window_minutes: 60, bucket_seconds: 300, bucket_count: 12 },
	"24h": { window_minutes: 1440, bucket_seconds: 3600, bucket_count: 24 },
	"7d": { window_minutes: 10_080, bucket_seconds: 21_600, bucket_count: 28 },
	"30d": { window_minutes: 43_200, bucket_seconds: 86_400, bucket_count: 30 },
} as const;

export function createDashboardOverviewWire(
	timeframe: keyof typeof OVERVIEW_FRAMES = "24h",
	overrides: Record<string, unknown> = {},
) {
	const frame = OVERVIEW_FRAMES[timeframe];
	const since = new Date(BASE_TIME.getTime() - frame.window_minutes * 60_000);
	return {
		generated_at: BASE_TIME.toISOString(),
		timeframe: { key: timeframe, ...frame },
		since: since.toISOString(),
		current: createMetricsWire(),
		previous: createMetricsWire({
			requests: 1000,
			errors: 30,
			error_rate: 0.03,
			cost_usd: 90,
			cache_hit_rate: 0.8,
			conversations: 120,
		}),
		can_compare: true,
		trends: Array.from({ length: frame.bucket_count }, (_, i) => ({
			t: new Date(since.getTime() + i * frame.bucket_seconds * 1000).toISOString(),
			requests: 40 + i,
			tokens: 600_000 + i * 1000,
			cost_usd: 3 + i * 0.1,
			cache_savings_usd: 2 + i * 0.05,
			cache_hit_rate: 0.84,
			error_rate: i % 5 === 0 ? 0.05 : 0,
			conversations: 6,
		})),
		by_model: [
			{
				model: "claude-opus-5-5",
				requests: 700,
				errors: 10,
				error_rate: 0.014,
				input_tokens: 300_000,
				output_tokens: 500_000,
				cache_read_input_tokens: 9_000_000,
				cache_creation_input_tokens: 1_200_000,
				total_tokens: 11_000_000,
				cost_usd: 60.5,
				cache_savings_usd: 34.2,
				cache_hit_rate: 0.86,
			},
			{
				model: "claude-haiku-5-5",
				requests: 500,
				errors: 0,
				error_rate: 0,
				input_tokens: 240_000,
				output_tokens: 460_000,
				cache_read_input_tokens: 5_000_000,
				cache_creation_input_tokens: 900_000,
				total_tokens: 6_600_000,
				cost_usd: 23.71,
				cache_savings_usd: 17.1,
				cache_hit_rate: 0.81,
			},
		],
		meta: {
			version: "0.6.1",
			accounts_total: 3,
			accounts_available: 2,
			pool_remaining_percent: 71.4,
			routing_strategy: "capacity_weighted",
			sticky_sessions_enabled: true,
			request_log_retention_days: 30,
			last_request_at: offsetIso(-1),
		},
		...overrides,
	};
}

export function createWindowCapacityWire(window: "primary" | "secondary", overrides: Record<string, unknown> = {}) {
	const primary = window === "primary";
	return {
		capacity_credits: 500,
		remaining_credits: primary ? 290 : 160,
		remaining_percent: primary ? 58 : 32,
		safe_used_percent: primary ? 40 : 55,
		risk: primary ? 0.42 : 0.83,
		risk_level: primary ? "safe" : "danger",
		burn_rate_credits_per_hour: primary ? 24 : 6.5,
		projected_exhaustion_at: offsetIso(primary ? 12 * 60 : 24 * 60),
		next_reset_at: offsetIso(primary ? 90 : 3 * 24 * 60),
		accounts: [
			{
				account_id: "acc_alice",
				account_name: "alice-max",
				plan_type: "max_5x",
				capacity_credits: 500,
				used_percent: primary ? 42 : 68,
				remaining_credits: primary ? 290 : 160,
				reset_at: offsetIso(primary ? 90 : 3 * 24 * 60),
				window_minutes: primary ? 300 : 10_080,
				safe_used_percent: primary ? 40 : 55,
				risk: primary ? 0.42 : 0.83,
				risk_level: primary ? "safe" : "danger",
				burn_rate_credits_per_hour: primary ? 24 : 6.5,
				observed_at: offsetIso(-2),
			},
		],
		...overrides,
	};
}

export function createWeeklyPaceWire(overrides: Record<string, unknown> = {}) {
	return {
		total_full_credits: 500,
		total_actual_remaining_credits: 160,
		total_expected_remaining_credits: 225,
		actual_used_percent: 68,
		scheduled_used_percent: 55,
		delta_percent: 13,
		smoothed_delta_percent: 13,
		schedule_gap_credits: 65,
		smoothed_schedule_gap_credits: 65,
		smoothing_minutes: 30,
		projected_shortfall_credits: 140,
		projected_depletion_hours: 24.5,
		projected_minimum_remaining_credits: 0,
		forecast_burn_rate_credits_per_hour: 6.5,
		scheduled_burn_rate_credits_per_hour: 2.98,
		pace_multiplier: 2.2,
		pause_for_break_even_hours: 21.5,
		throttle_to_percent: 45.8,
		reduce_by_percent: 54.2,
		pro_account_equivalent: 1.4,
		pro_accounts_to_cover: 2,
		status: "danger",
		account_count: 1,
		stale_account_count: 0,
		inactive_account_count: 0,
		confidence: "high",
		...overrides,
	};
}

export function createDashboardProjectionsWire(overrides: Record<string, unknown> = {}) {
	return {
		generated_at: BASE_TIME.toISOString(),
		subscription_accounts: 1,
		primary: createWindowCapacityWire("primary"),
		secondary: createWindowCapacityWire("secondary"),
		weekly_pace: createWeeklyPaceWire(),
		api_accounts: [
			{
				account_id: "acc_console",
				account_name: "console-key",
				enabled: true,
				available: true,
				spend_usd: 4.2,
				spend_cap_usd: 10,
				cap_used_percent: 42,
			},
		],
		...overrides,
	};
}

export function createUsageTrendWire(days = 28) {
	return Array.from({ length: days }, (_, i) => ({
		day: new Date(BASE_TIME.getTime() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10),
		requests: 100 + i * 3,
		errors: 1,
		input_tokens: 40_000,
		output_tokens: 80_000,
		cache_read_input_tokens: 900_000,
		cost_usd: 5 + i * 0.25,
	}));
}

export type RequestLogWire = {
	id: string;
	created_at: string;
	account_id: string | null;
	account_name: string | null;
	plan_type: string | null;
	api_key_id: string | null;
	api_key_name: string | null;
	path: string;
	model: string | null;
	status_code: number;
	status: string;
	streaming: boolean;
	duration_ms: number;
	ttft_ms: number | null;
	attempts: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
	total_tokens: number;
	cost_usd: number;
	cache_savings_usd: number;
	error: string | null;
	session_key: string | null;
	user_agent: string | null;
	client_ip: string | null;
};

export function createRequestLogWire(overrides: Partial<RequestLogWire> = {}): RequestLogWire {
	return {
		id: "req_0001",
		created_at: offsetIso(-1).replace("Z", ""),
		account_id: "acc_alice",
		account_name: "alice-max",
		plan_type: "max_5x",
		api_key_id: "key_team",
		api_key_name: "claude-code-team",
		path: "/v1/messages",
		model: "claude-opus-5-5",
		status_code: 200,
		status: "ok",
		streaming: true,
		duration_ms: 2140,
		ttft_ms: 480,
		attempts: 1,
		input_tokens: 420,
		output_tokens: 880,
		cache_read_input_tokens: 18_000,
		cache_creation_input_tokens: 0,
		total_tokens: 19_300,
		cost_usd: 0.0222,
		cache_savings_usd: 0.0684,
		error: null,
		session_key: "a".repeat(64),
		user_agent: "claude-cli/2.1.3 (external, cli)",
		client_ip: "10.0.0.7",
		...overrides,
	};
}

export function createDefaultRequestLogWires(): RequestLogWire[] {
	return [
		createRequestLogWire(),
		createRequestLogWire({
			id: "req_0002",
			created_at: offsetIso(-2).replace("Z", ""),
			account_id: "acc_console",
			account_name: "console-key",
			plan_type: "api",
			api_key_id: "key_ci",
			api_key_name: "ci-review-bot",
			model: "claude-haiku-5-5",
			status_code: 529,
			status: "overloaded",
			streaming: false,
			ttft_ms: null,
			attempts: 3,
			cost_usd: 0,
			cache_savings_usd: 0,
			cache_read_input_tokens: 0,
			total_tokens: 0,
			input_tokens: 0,
			output_tokens: 0,
			error: "Overloaded",
			session_key: "b".repeat(64),
			user_agent: "ci-review-bot/1.4",
		}),
		createRequestLogWire({
			id: "req_0003",
			created_at: offsetIso(-3).replace("Z", ""),
			status: "rate_limited",
			status_code: 429,
			error: "rate limited by upstream",
			cost_usd: 0,
			cache_savings_usd: 0,
		}),
	];
}

// ── Reports (claude-lb `/api/reports`) ──

export type ReportTotalsWire = {
	requests: number;
	errors: number;
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens: number;
	cache_read_input_tokens: number;
	total_tokens: number;
	cost_usd: number;
	cache_savings_usd: number;
};

export type ReportDistributionWire = {
	key: string | null;
	label: string;
	cost_usd: number;
	total_tokens: number;
	requests: number;
};

export type ReportBreakdownRowWire = ReportTotalsWire & { key: string | null; label: string; cache_hit_rate: number };

export type ReportWire = {
	start: string;
	end: string;
	days: number;
	group_by: "day" | "account" | "api_key" | "model" | "user_agent";
	source: "rollups" | "request_logs";
	coverage: { retention_days: number; logs_from: string; logs_truncated: boolean };
	summary: {
		total_cost_usd: number;
		avg_cost_per_day: number;
		requests: number;
		avg_requests_per_day: number;
		errors: number;
		error_rate: number;
		aborted: number;
		accounts_used: number;
		conversations: number;
		input_tokens: number;
		output_tokens: number;
		cache_read_input_tokens: number;
		cache_creation_input_tokens: number;
		total_tokens: number;
		cache_savings_usd: number;
		cache_hit_rate: number;
		median_ttft_ms: number | null;
		median_tps: number | null;
	};
	previous: {
		start: string;
		end: string;
		can_compare: boolean;
		total_cost_usd: number;
		requests: number;
		total_tokens: number;
		errors: number;
		cache_savings_usd: number;
	};
	daily: Array<
		ReportTotalsWire & {
			day: string;
			aborted: number;
			conversations: number;
			median_ttft_ms: number | null;
			median_tps: number | null;
		}
	>;
	by_model: ReportDistributionWire[];
	by_user_agent: ReportDistributionWire[];
	breakdown: ReportBreakdownRowWire[];
	breakdown_total: ReportTotalsWire & { cache_hit_rate: number };
};

function isoDay(day: string, offset: number): string {
	const date = new Date(`${day}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + offset);
	return date.toISOString().slice(0, 10);
}

function totals(scale: number): ReportTotalsWire {
	return {
		requests: 100 * scale,
		errors: 2 * scale,
		input_tokens: 40_000 * scale,
		output_tokens: 80_000 * scale,
		cache_creation_input_tokens: 10_000 * scale,
		cache_read_input_tokens: 900_000 * scale,
		total_tokens: 1_030_000 * scale,
		cost_usd: 5 * scale,
		cache_savings_usd: 2.43 * scale,
	};
}

const REPORT_GROUP_ROWS: Record<ReportWire["group_by"], Array<[string | null, string]>> = {
	day: [],
	account: [
		["acc_alice", "alice-max"],
		["acc_console", "console-key"],
	],
	api_key: [
		["key_team", "claude-code-team"],
		[null, "(unattributed)"],
	],
	model: [
		["claude-opus-5-5", "claude-opus-5-5"],
		["claude-sonnet-4-5", "claude-sonnet-4-5"],
	],
	user_agent: [
		["claude-cli", "claude-cli"],
		["(unknown)", "(unknown)"],
	],
};

/** A report shaped like the backend's, for `start..end` (inclusive) grouped by `groupBy`. */
export function createReportWire(
	options: { start?: string; end?: string; groupBy?: ReportWire["group_by"] } = {},
	overrides: Partial<ReportWire> = {},
): ReportWire {
	const end = options.end ?? "2026-01-07";
	const start = options.start ?? isoDay(end, -6);
	const groupBy = options.groupBy ?? "day";
	const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
	const daily = Array.from({ length: days }, (_, i) => ({
		...totals(1),
		day: isoDay(start, i),
		aborted: 1,
		conversations: 12,
		median_ttft_ms: 480 + i * 10,
		median_tps: 62.5,
	}));
	const sum = totals(days);
	const breakdown: ReportBreakdownRowWire[] =
		groupBy === "day"
			? daily.map((point) => ({ ...totals(1), key: point.day, label: point.day, cache_hit_rate: 0.9524 }))
			: REPORT_GROUP_ROWS[groupBy].map(([key, label], index) => ({
					...totals(days * (index === 0 ? 0.75 : 0.25)),
					key,
					label,
					cache_hit_rate: 0.9524,
				}));
	return {
		start,
		end,
		days,
		group_by: groupBy,
		source: "rollups",
		coverage: { retention_days: 30, logs_from: start, logs_truncated: false },
		summary: {
			total_cost_usd: sum.cost_usd,
			avg_cost_per_day: 5,
			requests: sum.requests,
			avg_requests_per_day: 100,
			errors: sum.errors,
			error_rate: 0.02,
			aborted: days,
			accounts_used: 2,
			conversations: 12 * days,
			input_tokens: sum.input_tokens,
			output_tokens: sum.output_tokens,
			cache_read_input_tokens: sum.cache_read_input_tokens,
			cache_creation_input_tokens: sum.cache_creation_input_tokens,
			total_tokens: sum.total_tokens,
			cache_savings_usd: sum.cache_savings_usd,
			cache_hit_rate: 0.9524,
			median_ttft_ms: 510,
			median_tps: 62.5,
		},
		previous: {
			start: isoDay(start, -days),
			end: isoDay(start, -1),
			can_compare: true,
			total_cost_usd: sum.cost_usd / 2,
			requests: sum.requests,
			total_tokens: sum.total_tokens * 2,
			errors: 0,
			cache_savings_usd: 0,
		},
		daily,
		by_model: [
			{ key: "claude-opus-5-5", label: "claude-opus-5-5", cost_usd: sum.cost_usd * 0.8, total_tokens: 600_000, requests: 40 },
			{ key: "claude-sonnet-4-5", label: "claude-sonnet-4-5", cost_usd: sum.cost_usd * 0.2, total_tokens: 900_000, requests: 160 },
		],
		by_user_agent: [
			{ key: "claude-cli", label: "claude-cli", cost_usd: sum.cost_usd * 0.9, total_tokens: 1_000_000, requests: 180 },
			{ key: "(unknown)", label: "(unknown)", cost_usd: sum.cost_usd * 0.1, total_tokens: 30_000, requests: 20 },
		],
		breakdown,
		breakdown_total: { ...sum, cache_hit_rate: 0.9524 },
		...overrides,
	};
}

export function createReportOptionsWire() {
	return {
		accounts: [
			{ id: "acc_alice", name: "alice-max" },
			{ id: "acc_console", name: "console-key" },
		],
		api_keys: [{ id: "key_team", name: "claude-code-team", key_hint: "clb-…team" }],
		models: ["claude-opus-5-5", "claude-sonnet-4-5"],
		user_agents: ["(unknown)", "claude-cli"],
	};
}

// ── API keys (claude-lb `/api/keys`, snake_case wire shapes) ──

export type LimitUsageWire = {
	id: string;
	source: "rule" | "legacy";
	metric: "requests" | "total_tokens" | "input_tokens" | "output_tokens" | "cost_usd";
	window: "5h" | "7d" | "daily" | "weekly" | "monthly" | "custom";
	window_seconds: number;
	max_value: number;
	model_filter: string | null;
	current_value: number;
	remaining: number;
	used_percent: number;
	window_start: string;
	resets_at: string | null;
};

export type ApiKeyWire = {
	id: string;
	name: string;
	key_hint: string;
	enabled: boolean;
	status: "active" | "disabled" | "expired";
	expires_at: string | null;
	max_requests_per_window: number | null;
	max_tokens_per_window: number | null;
	max_cost_usd_per_window: number | null;
	window_seconds: number;
	pinned_account_id: string | null;
	allowed_models: string[] | null;
	enforced_model: string | null;
	assigned_account_ids: string[] | null;
	limits: LimitUsageWire[];
	total_requests: number;
	total_cost_usd: number;
	total_tokens: number;
	lifetime_requests: number;
	lifetime_cost_usd: number;
	last_used_at: string | null;
	created_at: string;
};

export const MOCK_WINDOW_SECONDS: Record<LimitUsageWire["window"], number> = {
	"5h": 18_000,
	"7d": 604_800,
	daily: 86_400,
	weekly: 604_800,
	monthly: 2_678_400,
	custom: 3_600,
};

export function createLimitUsageWire(overrides: Partial<LimitUsageWire> = {}): LimitUsageWire {
	const base: LimitUsageWire = {
		id: "rule_1",
		source: "rule",
		metric: "cost_usd",
		window: "daily",
		window_seconds: 86_400,
		max_value: 10,
		model_filter: null,
		current_value: 2.5,
		remaining: 7.5,
		used_percent: 25,
		window_start: hoursFromNow(-6),
		resets_at: hoursFromNow(18),
	};
	const merged = { ...base, ...overrides };
	const used = merged.max_value > 0 ? Math.min(100, (merged.current_value / merged.max_value) * 100) : 0;
	return {
		...merged,
		remaining: overrides.remaining ?? Math.max(0, merged.max_value - merged.current_value),
		used_percent: overrides.used_percent ?? used,
	};
}

export function createApiKeyWire(overrides: Partial<ApiKeyWire> = {}): ApiKeyWire {
	return {
		id: "key_1",
		name: "claude-code-team",
		key_hint: "a1b2c3",
		enabled: true,
		status: "active",
		expires_at: null,
		max_requests_per_window: null,
		max_tokens_per_window: null,
		max_cost_usd_per_window: null,
		window_seconds: 3600,
		pinned_account_id: null,
		allowed_models: ["claude-sonnet-5"],
		enforced_model: null,
		assigned_account_ids: ["acc_max"],
		limits: [
			createLimitUsageWire(),
			createLimitUsageWire({
				id: "rule_2",
				metric: "requests",
				window: "5h",
				window_seconds: 18_000,
				max_value: 100,
				current_value: 92,
				resets_at: hoursFromNow(1.5),
			}),
		],
		total_requests: 150,
		total_cost_usd: 1.23,
		total_tokens: 50_000,
		lifetime_requests: 150,
		lifetime_cost_usd: 1.23,
		last_used_at: hoursFromNow(-0.1),
		created_at: hoursFromNow(-24 * 10),
		...overrides,
	};
}

export function createDefaultApiKeyWires(): ApiKeyWire[] {
	return [
		createApiKeyWire(),
		createApiKeyWire({
			id: "key_2",
			name: "ci-review-bot",
			key_hint: "d4e5f6",
			enabled: false,
			status: "disabled",
			allowed_models: null,
			assigned_account_ids: null,
			max_cost_usd_per_window: 25,
			limits: [
				createLimitUsageWire({
					id: "legacy-cost_usd",
					source: "legacy",
					metric: "cost_usd",
					window: "custom",
					window_seconds: 3600,
					max_value: 25,
					current_value: 0,
					resets_at: null,
				}),
			],
			total_requests: 42,
			total_cost_usd: 0.42,
			total_tokens: 12_500,
			lifetime_requests: 42,
			lifetime_cost_usd: 0.42,
			last_used_at: null,
		}),
	];
}

export function createKeyTrendsWire(keyId: string, days = 7) {
	const today = new Date();
	const usage = Array.from({ length: days }, (_, i) => {
		const day = new Date(today.getTime() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
		const requests = 10 + i * 3;
		return {
			day,
			requests,
			errors: i % 3 === 0 ? 1 : 0,
			input_tokens: requests * 900,
			output_tokens: requests * 300,
			cache_read_input_tokens: requests * 4000,
			cache_creation_input_tokens: requests * 100,
			total_tokens: requests * 5300,
			cost_usd: +(requests * 0.03).toFixed(2),
		};
	});
	const sum = (field: keyof (typeof usage)[number]) =>
		usage.reduce((total, day) => total + (day[field] as number), 0);
	return {
		key_id: keyId,
		days,
		usage,
		totals: {
			requests: sum("requests"),
			errors: sum("errors"),
			input_tokens: sum("input_tokens"),
			output_tokens: sum("output_tokens"),
			cache_read_input_tokens: sum("cache_read_input_tokens"),
			cache_creation_input_tokens: sum("cache_creation_input_tokens"),
			total_tokens: sum("total_tokens"),
			cost_usd: +sum("cost_usd").toFixed(2),
		},
		by_account: [
			{ account_id: "acc_max", account_name: "alice-max", plan_type: "max_5x", deleted: false, requests: 80, total_tokens: 400_000, cost_usd: 3.1 },
			{ account_id: "acc_gone", account_name: null, plan_type: null, deleted: true, requests: 9, total_tokens: 20_000, cost_usd: 0.4 },
		],
		by_model: [{ model: "claude-sonnet-5", requests: 89, total_tokens: 420_000, cost_usd: 3.5 }],
	};
}

export function createKeysOverviewWire(keys: ApiKeyWire[]) {
	const statuses = keys.map((key) => key.status);
	return {
		total: keys.length,
		active: statuses.filter((s) => s === "active").length,
		disabled: statuses.filter((s) => s === "disabled").length,
		expired: statuses.filter((s) => s === "expired").length,
		idle: keys.filter((key) => key.status === "active" && key.last_used_at === null).length,
		used_last_7d: keys.filter((key) => key.last_used_at !== null).length,
		lifetime_requests: keys.reduce((sum, key) => sum + key.lifetime_requests, 0),
		lifetime_cost_usd: keys.reduce((sum, key) => sum + key.lifetime_cost_usd, 0),
		lifetime_tokens: keys.reduce((sum, key) => sum + key.total_tokens, 0),
		by_key: keys
			.map((key) => ({
				id: key.id,
				name: key.name,
				key_hint: key.key_hint,
				requests: key.lifetime_requests,
				total_tokens: key.total_tokens,
				cost_usd: key.lifetime_cost_usd,
			}))
			.sort((a, b) => b.cost_usd - a.cost_usd),
	};
}

export function createCatalogModelWires() {
	return ["claude-haiku-5", "claude-opus-5", "claude-sonnet-5"].map((model_id) => ({
		model_id,
		display_name: model_id,
		accounts: 2,
		max_input_tokens: 200_000,
		max_output_tokens: 64_000,
		synced_at: hoursFromNow(-1),
	}));
}

// ── Audit log (claude-lb `/api/audit/events`, `/api/audit/actions`) ──

export type AuditEventWire = {
	id: string;
	created_at: string;
	action: string;
	target: string;
	detail: string;
	actor: string;
	client_ip: string;
	ok: boolean;
};

export function createAuditEventWire(overrides: Partial<AuditEventWire> = {}): AuditEventWire {
	return {
		id: "evt_0001",
		created_at: hoursFromNow(-1).replace("Z", ""),
		action: "account.created",
		target: "alice-max",
		detail: "provider=oauth plan=max_5x",
		actor: "dashboard",
		client_ip: "127.0.0.1",
		ok: true,
		...overrides,
	};
}

/** Newest first, like the backend. */
export function createDefaultAuditEventWires(): AuditEventWire[] {
	return [
		createAuditEventWire({
			id: "evt_0004",
			created_at: hoursFromNow(-0.1).replace("Z", ""),
			action: "auth.login",
			target: "",
			detail: "invalid password",
			client_ip: "203.0.113.9",
			ok: false,
		}),
		createAuditEventWire({
			id: "evt_0003",
			created_at: hoursFromNow(-0.5).replace("Z", ""),
			action: "settings.updated",
			target: "",
			detail: "routing_strategy",
		}),
		createAuditEventWire({
			id: "evt_0002",
			created_at: hoursFromNow(-0.8).replace("Z", ""),
			action: "api_key.created",
			target: "claude-code-team",
			detail: "clb-…team",
		}),
		createAuditEventWire(),
		createAuditEventWire({
			id: "evt_0000",
			created_at: hoursFromNow(-72).replace("Z", ""),
			action: "custom.unknown_action",
			target: "legacy",
			detail: "",
		}),
	];
}

// ── Model catalog page (claude-lb `GET /api/health/catalog`) ──

function priceWire(input: number, output: number, cacheRead = input * 0.1) {
	return {
		input,
		output,
		cache_read: cacheRead,
		cache_write_5m: input * 1.25,
		cache_write_1h: input * 2,
		long_context_threshold: null,
		long_context: null,
	};
}

export function createCatalogWire() {
	const synced = hoursFromNow(-1).replace("Z", "");
	return {
		models: [
			{
				model_id: "claude-haiku-5-5-20260101",
				display_name: "Claude Haiku 5.5",
				accounts: [
					{ id: "acc_max", name: "alice-max" },
					{ id: "acc_console", name: "console" },
				],
				max_input_tokens: 200_000,
				max_output_tokens: 64_000,
				synced_at: synced,
				price: {
					...priceWire(0.1, 0.5),
					long_context_threshold: 100_000,
					long_context: priceWire(0.5, 2.5),
				},
				price_key: "claude-haiku-5-5",
			},
			{
				model_id: "claude-opus-5-5",
				display_name: "Claude Opus 5.5",
				accounts: [{ id: "acc_console", name: "console" }],
				max_input_tokens: 1_000_000,
				max_output_tokens: 128_000,
				synced_at: synced,
				price: priceWire(4, 20, 0.2),
				price_key: "claude-opus-5-5",
			},
			{
				model_id: "claude-experimental-1",
				display_name: "",
				accounts: [{ id: "acc_console", name: "console" }],
				max_input_tokens: null,
				max_output_tokens: null,
				synced_at: synced,
				price: null,
				price_key: null,
			},
		],
		prices: [
			{ model: "claude-opus-5-5", price: priceWire(4, 20, 0.2) },
			{ model: "claude-sonnet-5-5", price: priceWire(2, 10, 0.1) },
			{ model: "claude-haiku-5-5", price: { ...priceWire(0.1, 0.5), long_context_threshold: 100_000, long_context: priceWire(0.5, 2.5) } },
		],
		blocks: [
			{
				account_id: "acc_max",
				account_name: "alice-max",
				plan_type: "max_5x",
				model: "claude-sonnet-5-5",
				until: hoursFromNow(6).replace("Z", ""),
			},
		],
		accounts: [
			{ id: "acc_max", name: "alice-max", plan_type: "max_5x", enabled: true, paused: false, models: 1, models_synced_at: synced },
			{ id: "acc_console", name: "console", plan_type: "api", enabled: true, paused: false, models: 3, models_synced_at: synced },
			{ id: "acc_paused", name: "backup-key", plan_type: "api", enabled: false, paused: true, models: 0, models_synced_at: null },
		],
		last_synced_at: synced,
	};
}

// ── Sticky sessions (claude-lb `GET /api/sticky-sessions`) ──

export type StickyEntryWire = {
	key: string;
	account_id: string;
	account_name: string | null;
	expires_at: string;
	remaining_seconds: number;
	expired: boolean;
};

export function createStickyEntryWire(overrides: Partial<StickyEntryWire> = {}): StickyEntryWire {
	return {
		key: "a".repeat(64),
		account_id: "acc_max",
		account_name: "alice-max",
		expires_at: new Date(Date.now() + 600_000).toISOString(),
		remaining_seconds: 600,
		expired: false,
		...overrides,
	};
}

/** Most recently used first, like the backend. */
export function createDefaultStickyEntryWires(): StickyEntryWire[] {
	return [
		createStickyEntryWire(),
		createStickyEntryWire({ key: "b".repeat(64), account_id: "acc_console", account_name: "console" }),
		createStickyEntryWire({ key: "c".repeat(64), remaining_seconds: 120 }),
		createStickyEntryWire({
			key: "d".repeat(64),
			account_id: "acc_console",
			account_name: "console",
			expires_at: new Date(Date.now() - 60_000).toISOString(),
			remaining_seconds: 0,
			expired: true,
		}),
	];
}

/** `FirewallEntryOut` from `claude_lb.modules.firewall.api`. */
export type FirewallEntryWire = {
	id: string;
	network: string;
	note: string;
	version: number;
	addresses: number;
	covers_client: boolean;
	created_at: string;
};

export function createFirewallEntryWire(overrides: Partial<FirewallEntryWire> = {}): FirewallEntryWire {
	return {
		id: "fw_1",
		network: "10.0.0.0/8",
		note: "office",
		version: 4,
		addresses: 16_777_216,
		covers_client: false,
		created_at: hoursFromNow(-24).replace("Z", ""),
		...overrides,
	};
}

/** `RunOut` from `claude_lb.modules.automations.api`. */
export type AutomationRunWire = {
	id: string;
	job_id: string;
	job_name: string;
	cycle_key: string;
	trigger: "scheduled" | "manual";
	status: "pending" | "running" | "success" | "failed" | "skipped";
	scheduled_for: string;
	started_at: string | null;
	finished_at: string | null;
	account_id: string | null;
	account_name: string;
	model: string;
	http_status: number | null;
	input_tokens: number;
	output_tokens: number;
	cost_usd: number;
	duration_ms: number | null;
	error: string | null;
};

export type AutomationCycleWire = {
	cycle_key: string;
	job_id: string;
	job_name: string;
	trigger: "scheduled" | "manual";
	status: "pending" | "running" | "success" | "partial" | "failed" | "skipped";
	scheduled_for: string;
	finished_at: string | null;
	total: number;
	succeeded: number;
	failed: number;
	skipped: number;
	pending: number;
	input_tokens: number;
	output_tokens: number;
	cost_usd: number;
	runs: AutomationRunWire[];
};

export type AutomationJobWire = {
	id: string;
	name: string;
	enabled: boolean;
	schedule: { days: string[]; time: string; timezone: string; spread_minutes: number };
	model: string;
	prompt: string;
	max_tokens: number;
	account_ids: string[];
	include_paused_accounts: boolean;
	targets: Array<{ id: string; name: string; plan_type: string; paused: boolean }>;
	missing_account_ids: string[];
	next_run_at: string | null;
	last_cycle: AutomationCycleWire | null;
	estimate: {
		prompt_tokens: number;
		per_request_usd: number;
		api_accounts: number;
		subscription_accounts: number;
		per_run_usd: number;
	};
	created_at: string;
	updated_at: string;
};

export function createAutomationRunWire(overrides: Partial<AutomationRunWire> = {}): AutomationRunWire {
	return {
		id: "run_1",
		job_id: "job_1",
		job_name: "Morning window",
		cycle_key: "job_1:2026-11-26T07:00@Asia/Seoul",
		trigger: "scheduled",
		status: "success",
		scheduled_for: hoursFromNow(-3).replace("Z", ""),
		started_at: hoursFromNow(-3).replace("Z", ""),
		finished_at: hoursFromNow(-3).replace("Z", ""),
		account_id: "acc_max",
		account_name: "alice-max",
		model: "claude-haiku-4-5",
		http_status: 200,
		input_tokens: 12,
		output_tokens: 4,
		cost_usd: 0,
		duration_ms: 820,
		error: null,
		...overrides,
	};
}

/** Builds a cycle with the same aggregation rules as the backend's `_cycle_out`. */
export function createAutomationCycleWire(runs: AutomationRunWire[]): AutomationCycleWire {
	const statuses = runs.map((run) => run.status);
	const ok = statuses.filter((status) => status === "success").length;
	const failed = statuses.filter((status) => status === "failed").length;
	const skipped = statuses.filter((status) => status === "skipped").length;
	const pending = statuses.filter((status) => status === "pending" || status === "running").length;
	const status: AutomationCycleWire["status"] = pending
		? "running"
		: ok && (failed || skipped)
			? "partial"
			: ok
				? "success"
				: failed
					? "failed"
					: "skipped";
	const first = runs[0];
	return {
		cycle_key: first.cycle_key,
		job_id: first.job_id,
		job_name: first.job_name,
		trigger: first.trigger,
		status,
		scheduled_for: first.scheduled_for,
		finished_at: pending ? null : first.finished_at,
		total: runs.length,
		succeeded: ok,
		failed,
		skipped,
		pending,
		input_tokens: runs.reduce((sum, run) => sum + run.input_tokens, 0),
		output_tokens: runs.reduce((sum, run) => sum + run.output_tokens, 0),
		cost_usd: runs.reduce((sum, run) => sum + run.cost_usd, 0),
		runs,
	};
}

export function createAutomationJobWire(overrides: Partial<AutomationJobWire> = {}): AutomationJobWire {
	return {
		id: "job_1",
		name: "Morning window",
		enabled: true,
		schedule: { days: ["mon", "tue", "wed", "thu", "fri"], time: "07:00", timezone: "Asia/Seoul", spread_minutes: 0 },
		model: "claude-haiku-4-5",
		prompt: "Reply with OK.",
		max_tokens: 16,
		account_ids: ["acc_max", "acc_console"],
		include_paused_accounts: false,
		targets: [
			{ id: "acc_max", name: "alice-max", plan_type: "max_5x", paused: false },
			{ id: "acc_console", name: "console", plan_type: "api", paused: false },
		],
		missing_account_ids: [],
		next_run_at: hoursFromNow(20).replace("Z", ""),
		last_cycle: null,
		estimate: { prompt_tokens: 12, per_request_usd: 0.0001, api_accounts: 1, subscription_accounts: 1, per_run_usd: 0.0001 },
		created_at: hoursFromNow(-48).replace("Z", ""),
		updated_at: hoursFromNow(-48).replace("Z", ""),
		...overrides,
	};
}

/** One job with a partially failed scheduled cycle. */
export function createDefaultAutomationWires(): { jobs: AutomationJobWire[]; cycles: AutomationCycleWire[] } {
	const cycle = createAutomationCycleWire([
		createAutomationRunWire(),
		createAutomationRunWire({
			id: "run_2",
			account_id: "acc_console",
			account_name: "console",
			status: "failed",
			http_status: 400,
			cost_usd: 0,
			error: "max_tokens: too small",
		}),
	]);
	return { jobs: [createAutomationJobWire({ last_cycle: cycle })], cycles: [cycle] };
}
