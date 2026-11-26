# Changelog

All notable changes to claude-lb. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may change behaviour).

## [Unreleased]

## [0.7.0] — 2026-11-26

### Added
- **Subscription pooling** (`codex-lb` parity):
  - Plan tiers (`free`, `pro`, `max`, `max_5x`, `max_20x`, `team`, `enterprise`, `api`) with capacity credits and per-account `routing_policy` (`burn_first`, `normal`, `preserve`).
  - Dual-window (`5h` primary / `7d` secondary) quota parsing from `anthropic-ratelimit-unified-*` headers, `rate_limited` / `quota_exceeded` tracking, overage override, and automatic reset recovery.
  - Subscription-aware routing strategies: `relative_availability`, `usage_weighted`, `reset_drain`, and `sequential_drain`.
  - `QuotaHistory` time-series snapshots with EWMA burn-rate and depletion-risk classification (`safe`, `warning`, `danger`, `critical`).
  - `POST /api/accounts/import`, `POST /api/accounts/{id}/reset-quota`, `GET /api/usage/quota`, `GET /api/usage/quota/{id}/history`, `claude-lb account import`, Prometheus quota metrics, and live dashboard/demo support.
  - Documentation in [docs/subscription-pooling.md](docs/subscription-pooling.md).
- **Per-account spend cap** (`spend_cap_usd`): stop routing to an account once its estimated spend reaches the cap. `claude-lb account add --spend-cap-usd`, `claude-lb account set-spend-cap <name> [usd]`, and `spend_cap_usd` on the accounts API.
- **`claude-lb account add-subscription <name>`**: one command to add a Claude subscription. It runs Claude Code's own `claude setup-token` in a throwaway config directory (existing logins and sessions are untouched), reads the token from its output, runs a tiny quota probe, and shows current 5h/7d usage.
- **Native Claude Code transport**: subscription accounts run the requested model through an isolated Claude Code process, then return Messages-compatible JSON or buffered SSE. Client tools round-trip as `tool_use` / `tool_result`, built-in tools remain disabled, tokens stay out of process arguments, and failures continue through the normal account failover path. Existing accounts can switch with `claude-lb account set-transport NAME claude_code`.
- **Multi-model routing for subscriptions**: runtime traffic learns per-account availability. A temporarily unavailable account-model route is sent elsewhere for 12 hours while the account keeps serving its other models. Shown in `account list` and as `blocked_models` on the accounts API; `POST /api/accounts/{id}/reset-quota` clears it.
- **New dashboard** (React + Vite, derived from the codex-lb frontend, MIT © 2025 Soju06 — see
  `frontend/LICENSE`). Replaces the single-file dashboard. The build is committed under
  `claude_lb/modules/dashboard/static/`, so running claude-lb still needs no Node; any non-API GET
  falls back to the SPA so client routes survive a reload. English and Korean (Simplified Chinese
  partial), light/dark, phone width. Pages: Dashboard (metrics with deltas and sparklines, 5h/7d
  capacity donuts, weekly pace, API-key spend, account cards, usage by model, cost trend, request
  log with filters and details, conversations view), Reports, Accounts, APIs, Settings, and under
  Advanced: Audit log, Model catalog, Sticky sessions, Automations.
- **Dashboard APIs**: `GET /api/dashboard/overview` and `/projections` (capacity, safe line, burn
  rate, weekly pace); `GET /api/request-logs` (+ `/options`, `/{id}` with cost breakdown);
  `GET /api/conversations` (+ `/{session_key}`); `GET /api/reports` (+ `/options`; previous-period
  comparison, median TTFT/TPS, user-agent distribution); `GET /api/audit/events` (+ `/actions`);
  `GET /api/health/catalog` (models with prices and learned temporary reroutes); `/api/sticky-sessions`
  (browse, delete, purge); `GET /health/ready`; `auth_enabled` on `/api/auth/status`.
- **Request log columns** `ttft_ms`, `session_key` (the prompt-cache conversation key), `user_agent`
  and `client_ip`, added to existing databases on startup.
- **Accounts**: pause/resume (`PATCH enabled`, kept across health probes), rename, probe one account
  (`POST /api/accounts/{id}/probe`), retry temporary model reroutes (`DELETE /api/accounts/{id}/model-blocks`),
  hourly 5h/7d and daily usage trends (`GET /api/accounts/{id}/trends`), delete with history.
- **API key rules**: model allowlist (403 `permission_error` for other models), enforced model
  (rewrites `model`), assigned accounts (routes only to those, never spills), and any number of
  limit rules — requests, total / input / output tokens or USD over 5h, 7d, daily, weekly,
  monthly (UTC) or custom rolling windows, optionally per model — answered with 429 and
  `retry-after`. Existing single budgets keep working and show up as rules. Plus expiry,
  `POST /api/keys/{id}/regenerate`, `GET /api/keys/overview`, `GET /api/keys/{id}/trends`, and a
  partial-update `PATCH /api/keys/{id}` with a JSON body.
- **Reports**: multi-value account / API key / model / user-agent filters and `user_agent` grouping
  on `/api/usage/report(.csv)`; the CSV gains `cache_savings_usd` (before `cost_usd`); ranges are
  capped at 366 days.
- **IP firewall** for the proxy (`/api/firewall`): allow-all or allowlist of addresses / CIDR
  ranges. Proxy only — the dashboard and `/api` are never firewalled; no loopback exemption;
  `X-Forwarded-For` is ignored.
- **Read-only guest role**: optional guest sign-in (with its own optional password) that can read
  every page but change nothing (403 on writes) and never sees client IP addresses.
- **Automations**: scheduled prompts per account (weekdays, time, IANA timezone, random spread,
  model, prompt, `max_tokens` ≤ 1024), e.g. to start a 5-hour window before work. Each slot fires
  once (idempotent across restarts and workers) within 15 minutes of its time; "Run now" with a
  5-minute cooldown; run history per cycle; requests carry the user agent
  `claude-lb-automation/<version>` and are accounted like any other.

### Fixed
- A Console `400` "credit balance is too low" / "reached your specified API usage limits" now disables that account and fails over, instead of being returned to the caller.
- Sticky-session fresh picks now respect `routing_policy` tiers. Previously a new conversation could land on a `preserve` account while a `burn_first` one still had room.
- Disabling an account from the dashboard no longer undoes itself: the background health probe
  used to re-enable any disabled account whose probe passed. Operator pauses are now left alone.
- Request-log pruning used the environment default instead of the retention set in the dashboard,
  and ran only at startup. It now uses the runtime setting and runs every 6 hours.
- In `claude-lb demo`, the simulated upstream's `GET /v1/models` was answered by the dashboard's
  SPA fallback, so model sync and probes found no models.

### Changed
- The legacy single-file dashboard (`modules/dashboard/index.html`) is gone. Without a frontend
  build, `/` answers 503 with the build command (`cd frontend && npm ci && npm run build`).
- `POST /api/settings/reset` resets only runtime settings; it no longer touches the firewall mode
  or guest access.

### Security
- **Message batches no longer bypass API-key model policy.** `POST /v1/messages/batches` names a
  model per entry (`requests[*].params.model`); every entry must now pass the key's allowlist
  (403 `permission_error`), and an enforced model rewrites each entry. Keys with token or cost
  limits (rules or the legacy budget) get 403 for batches: their usage happens upstream, later,
  and claude-lb cannot meter it. Request-count limits still allow batches.
- **Model-bearing bodies are read strictly for keys with a model policy** (allowlist, enforced
  model, or a model-filtered limit): a compressed body (`Content-Encoding`), a byte-order mark,
  duplicate keys, a non-string `model` or a malformed batch is refused with 400 instead of being
  relayed unchecked. Applies to `/v1/messages`, `/v1/messages/count_tokens`, `/v1/complete` and
  batch creation. Proxy paths with empty or dot segments (`/v1/messages/./batches`) are 404.
- **Out-of-credit detection** now needs `error.type == "invalid_request_error"` and a message that
  is exactly one of Anthropic's wordings. Before, any 400 whose message merely *contained* the
  phrase disabled the account — and upstream echoes client field names, so a client could switch
  the pool off.
- **"No account available" (503)** tells API-key holders only categories ("1 at spend cap,
  1 disabled"); account names, cap amounts and disabled reasons go to the server log (INFO).
- **Automations**: disabling a job, changing its schedule, or dropping an account from its targets
  cancels runs that were planned but not sent (a spread can hold them for two hours), and every run
  re-checks the job right before sending. A run forced through a paused account still respects the
  spend cap, temporarily unavailable models and breaker-disabled accounts. One job with a broken schedule or
  timezone no longer fails the whole scheduler tick, and long error text is clipped to the column.
- **Guests** no longer see firewall addresses: entries show `hidden` (no note), firewall audit
  events have no target/detail, and searching the audit log cannot confirm an address.
- The firewall rule cache is dropped after a change commits (it was dropped before, so a request in
  between could cache the old rules for the TTL).
- Model-filtered limits and allowlists treat an alias and its dated snapshot / `-latest` form as the
  same model in both directions (`claude-opus-4-1` ⇄ `claude-opus-4-1-20250805`).

## [0.6.1] — 2026-11-25

### Fixed
- `claude-lb demo` inside the Docker image bound to the container's loopback, so a published
  port could not reach it. It now binds 0.0.0.0 in Docker (and takes `--host`); off loopback, its
  dashboard needs no sign-in, since it holds only simulated data.

## [0.6.0] — 2026-11-25

### Added
- **`claude-lb demo`**: the real server, a simulated upstream, and live synthetic traffic.
  It needs no API key, runs on a throwaway data directory, and sends nothing off the machine.
- **Cache savings**: the usage summary and dashboard show the cache hit rate and the dollars
  prompt caching saved, priced per model, overall and by model and account.
- **`claude-lb setup claude-code`**: issues a key and prints the environment variables and the
  `settings.json` block that route Claude Code through claude-lb.

### Fixed — correctness
- **Connection-pool deadlock.** Key auth held a request-scoped DB connection for the whole
  response while the proxy opened more. About 15 concurrent requests exhausted the pool, and all
  of them failed after 30 s.
- **Aborted streams were never logged.** A client that hung up mid-stream (Esc in Claude Code)
  left no usage row. Its input tokens were billed upstream but never counted against spend or
  budgets.
- **A 403 disabled healthy accounts.** One request for a model the org lacks could switch off
  `max_attempts` accounts. A 403 now fails over without disabling anything.
- **Budget overshoot under concurrency.** A cap of 3 requests served 10 of 10 in a burst. Admitted
  requests now hold an in-flight slot until they are logged.
- **Pricing.** Point releases were billed at their family's rate: Opus 5.5 +25%,
  Sonnet 5 / 5.5 +50%, Fable 5.2 +25%. Haiku 5.5 was recorded as $0. Cache reads are now priced
  per model, 1-hour cache writes bill at 2×, Haiku 5.5's >100K-token tier is applied, and
  Bedrock region prefixes resolve.
- **Postgres.** Counters lost concurrent updates. Schema upgrade emitted `DEFAULT 1/0` for
  booleans, which aborted startup. Lifetime token counters overflowed at 2.1 billion; they are
  now `BIGINT` and existing columns are widened on startup.
- Model-catalog routing now matches an alias to its dated snapshot and never drops a key's
  pinned account.

### Fixed — security
- **DNS rebinding.** Before a password exists, loopback access to the management plane now
  also requires a loopback `Host` header.
- **Cross-site writes.** State-changing `/api` requests with a foreign `Origin` or
  `Sec-Fetch-Site: cross-site` are refused.
- Login throttling: 5 failures per 5 min per client, 50 in total. scrypt runs off the event loop.
- TOTP codes are single-use. Starting a new enrollment no longer switches the live factor off.
- The dashboard cookie is no longer forwarded upstream, and CSV exports neutralize
  formula-like cells.

### Changed
- `/v1/organizations` (Admin API) is no longer proxied.
- The per-key token cap counts cache-creation and cache-read tokens.
- The Python package is now `claude_lb` rather than `app`, so it no longer collides with other
  projects' `app` package. The `claude-lb` command is unchanged.
- The Docker image installs from `uv.lock` and is published for amd64 and arm64.
- `claude-lb --version`.

## [0.5.0] — 2026-08-10
- Cost reports over a date range, grouped by day, account, API key, or model, with CSV export.
- Rollups gained the API-key dimension (`POST /api/usage/rollups/backfill` to attribute history).
- Schema upgrades: missing columns are added in place on startup. 0.1–0.4 failed with
  `no such column` after an upgrade.
- Dashboard: disabled accounts no longer show a healthy-looking headroom bar.

## [0.4.0] — 2026-08-10
- Browser login for bearer accounts: Authorization Code + PKCE (S256), constant-time `state`
  check, RFC 8252 loopback redirect, and `--manual` for headless hosts.

## [0.3.0] — 2026-08-10
- Bring-your-own-credential accounts: a bearer token plus optional RFC 6749 refresh, with
  early refresh, rotation, single-flight, 401 self-healing, and a breaker.
- The dashboard gate fails closed once a password has been observed.

## [0.2.0] — 2026-08-10
- Prompt-cache-aware sticky sessions, keyed on the cacheable prefix.
- Runtime settings, changed from the dashboard without a restart.
- Dashboard auth (password + TOTP) and an append-only audit log.
- Self-healing health probes, model-aware routing, daily rollups, and Prometheus `/metrics`.

## [0.1.0] — 2026-08-10
- Initial release: key pooling, rate-limit-aware routing, failover, `clb_` client keys with
  budgets, usage and cost tracking, SSE passthrough, and the dashboard.

[Unreleased]: https://github.com/softkleenex/claude-lb/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/softkleenex/claude-lb/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/softkleenex/claude-lb/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/softkleenex/claude-lb/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/softkleenex/claude-lb/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/softkleenex/claude-lb/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/softkleenex/claude-lb/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/softkleenex/claude-lb/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/softkleenex/claude-lb/releases/tag/v0.1.0
