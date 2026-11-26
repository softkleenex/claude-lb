# Dashboard rebuild (React) — plan & progress

Goal: replace the single-file vanilla dashboard (`claude_lb/modules/dashboard/index.html`)
with a React app whose features are a **superset of codex-lb's dashboard** plus everything
claude-lb already had (audit log, cache savings, grouped cost report + CSV, model catalog,
spend caps, subscription 5h/7d quota, and learned per-model availability).

Decisions (user, 2026-11-26): React + Vite stack like codex-lb; build everything in one go.
Base: codex-lb `frontend/` (MIT, © 2025 Soju06) copied and adapted — keep its LICENSE notice.

## Conventions
- Source: `frontend/` (npm, not bun). Build output: `claude_lb/modules/dashboard/static/`
  (committed, so `uv run claude-lb serve` works without Node).
- FastAPI serves `static/` with SPA fallback to `index.html`; `/api`, `/v1`, `/health`, `/metrics` win.
- Codex-only concepts are dropped: reasoning effort, service tier, warm-up/limit warm-up,
  reset credits, WebSocket transport, Trusted Access for Cyber, auth.json export,
  device-code OAuth, upstream proxy pools, model sources (OpenAI-compatible upstreams).
- Every step: `uv run ruff check claude_lb tests && uv run pytest -q`, `npm run build`
  (+ `npm test` where tests exist), then commit on the current branch. **Never push.**

## Steps
- [x] A. Scaffold: copy frontend, npm, outDir, SPA serving, branding, prune codex-only features, compiles
- [x] B. Auth gate + shell (nav, status bar, theme, i18n ko/en, privacy blur) + Settings page
- [x] C. Accounts page (+ backend: pause/resume, per-account probe, trends from QuotaHistory, rename)
- [x] D. Dashboard overview + request logs + request details (+ backend: overview/deltas/sparklines, log filters/pagination/options)
- [x] E. Reports page (+ backend: date range, multi-filters, TTFT/TPS)
- [x] F. API keys page (+ backend: regenerate, expiry, allowed models, multi-rule limits, trends)
- [x] G. Extras: conversations, audit log page, model catalog page, firewall, sticky sessions browser, guest role, automations (scheduled prompts per account, e.g. start a 5h window early; codex-lb parity)
  - [x] G1. conversations, audit log page, model catalog page, sticky sessions browser
  - [x] G2. firewall, guest role, automations
- [x] H. Remove old index.html, docs/README/CHANGELOG, final full verification

## Log

### 2026-11-26 — Step A (scaffold)
**Done**
- `frontend/` copied from codex-lb (excluding node_modules, bun.lock, screenshots/, browser-smoke/).
  `frontend/LICENSE` keeps codex-lb's MIT notice with a derivation header; `frontend/README.md` rewritten for npm.
- npm instead of bun: scripts `dev`, `build` (`tsc -b && vite build`), `test`, `test:coverage`, `lint`, `typecheck`,
  `preview`. Dropped `react-doctor`, `@playwright/test`, `@typescript/native` (typescript ~6.0.3 is used directly).
  **jsdom is pinned to exactly 30.0.1**: 30.1.x breaks `toHaveStyle({background})` assertions and MSW requests
  (`Cannot read properties of undefined (reading '_buffer')`).
- `vite.config.ts`: outDir `../claude_lb/modules/dashboard/static` (emptyOutDir), dev proxy target
  `http://localhost:2456` (override with `API_PROXY_TARGET`) for `/api`, `/v1`, `/health`, `/metrics`.
- Branding: "Claude LB" (title, header, `auth.appTitle`), localStorage keys `claude-lb-*`, env names `CLAUDE_LB_*`
  in locale strings, GitHub links → softkleenex/claude-lb. `CodexLogo` → `AppLogo`
  (`src/components/brand/app-logo.tsx`, same glyph). Primary/ring/sidebar-primary = terracotta
  `oklch(.58 .14 40)` light / `oklch(.72 .12 45)` dark; light neutrals re-hued 264→60 (warm grey); rest of the
  token system unchanged. Favicon stroke recoloured.
- Removed: `features/model-sources/`, `features/conversation-archive/`, telemetry consent dialog + telemetry
  settings card + payload preview, upstream-proxy settings card + proxy endpoint/pool dialogs, and their tests
  (`__integration__/telemetry-consent-flow.test.tsx`, telemetry/upstream-proxy component tests, the source-scope
  tests in `api-key-edit-dialog.test.tsx`, archive-panel assertions in `recent-requests-table.test.tsx`), MSW
  model-source handlers/factories. The model-source multi-select was removed from the API-key create/edit dialogs
  (the `selectedSourceIds`/`clearSourceScope` draft fields still exist in the draft code — clean up in Step F).
- Backend: `claude_lb/modules/dashboard/api.py` serves the SPA. `/` and any non-reserved GET/HEAD path →
  `static/index.html` with `Cache-Control: no-cache`; real files in `static/` are served directly
  (`/assets/*` with `max-age=31536000, immutable`, others 1h); a missing `/assets/*` file is 404 (never HTML);
  path traversal is refused. Reserved first segments (`api`, `v1`, `health`, `metrics`, `docs`, `redoc`,
  `openapi.json`) are excluded by a custom route class (`_SpaRoute.matches` → `Match.NONE`) so they keep normal
  404/**405** behaviour. Without `static/index.html` the legacy `index.html` is served. The dashboard router is now
  registered last in `create_app()`. `STATIC_DIR` is a module global (tests monkeypatch it).
- Wheel packaging: hatch `packages = ["claude_lb"]` already includes `static/` (verified with `uv build`: 82 files).
  `frontend/node_modules/` added to `.gitignore` and `.dockerignore`.
- Tests: new `tests/test_dashboard_spa.py` (5 tests); `test_auth` title assertion accepts either dashboard.

**Results**: `npm run build` OK; `npm test` 136 files / 1102 tests pass; `npm run lint` clean;
`ruff check` clean; `pytest` 430 passed. Smoke on :2461: `/` and `/accounts` → new index (no-cache),
`/assets/index-*.js` → immutable, `/health` OK, `/api/auth/status` JSON, `/api/nope` 404 JSON, GET `/api/auth/login`
405, `/metrics` and `/docs` 200. In a browser the shell renders (header, nav, status bar, terracotta theme);
pages show "Response schema mismatch" because they still call codex-lb endpoints — expected until Steps B–G.

**Known issues / kept for later steps**
- All pages still talk to codex-lb's API shape. Auth gate calls `/api/dashboard-auth/*` (404 here; the gate currently
  falls through to the app). Remaining codex-only code still present: reasoning effort, service tier, warm-up /
  limit warm-up, reset credits (`reset-credit-settings`), websocket transport, auth.json export, device-code OAuth,
  `useUpstreamProxyAdmin` + account proxy binding (still used by `accounts-page.tsx`), telemetry API/hooks/schemas in
  `features/settings/{api,hooks/use-settings,schemas}.ts` (no UI uses them), quota-planner, automations (kept as is).
- Vite warns that the lazy recharts chunk (`es6-*.js`, ~660 kB) exceeds 600 kB; inherited from codex-lb.
- `npm install` warns that msw/@swc/core postinstall scripts are not in `allowScripts`; builds/tests work regardless.
- `npm audit` reports 4 moderate advisories in dev dependencies (not investigated).

**Notes for next agents**
- Layout: `src/App.tsx` (routes, lazy pages), `src/components/{layout,ui,brand}` (shell, shadcn/radix ui),
  `src/features/<area>/{api.ts,schemas.ts,hooks/,components/}`, `src/hooks` (theme, privacy, time/date format,
  dashboard prefs — all zustand + localStorage), `src/i18n` (en, ko, zh-CN JSON; keys flat like
  `"settings.page.title"`), `src/test` (vitest setup, `mocks/handlers.ts` MSW handlers + `factories.ts`,
  `mocks/handler-coverage.test.ts` asserts every handler is listed — update both when adding endpoints).
- API calls: `src/lib/api-client.ts` exports `get/post/put/patch/del(url, ZodSchema | null, options)`. It uses
  `fetch` with `credentials: "same-origin"`, validates responses with zod (`safeParse`; mismatch → `ApiError`
  "Response schema mismatch" + console.error with the zod diff), maps error bodies to `ApiError{status, code,
  message}`, and calls a global unauthorized handler on 401 (`setUnauthorizedHandler`, wired by the auth store).
  codex-lb's API is camelCase JSON; claude-lb's is snake_case — either add camelCase aliases on the backend or
  transform in each `features/*/schemas.ts` (zod `.transform`). Decide once in Step B and apply consistently.
- React Query (`src/lib/query-client.ts`) for data; query keys like `["settings","detail"]`.
- Auth: codex-lb frontend uses `/api/dashboard-auth/{session,password/setup,password/login,password/change,
  password,guest/*,totp/*,logout}` returning an `AuthSession` (passwordRequired, authenticated, role, totp…), see
  `features/auth/{api,schemas}.ts` and `hooks/use-auth.ts` (zustand store). claude-lb exposes `/api/auth/status`
  (`{configured, totp_enabled, authenticated, reason}`), `POST /api/auth/login`, `POST /api/auth/logout`,
  `POST /api/auth/password`, `POST /api/auth/totp/enroll`, `POST /api/auth/totp/confirm`, `DELETE /api/auth/totp`,
  `POST /api/auth/sessions/revoke-all`; remote first-time setup needs the `x-claude-lb-bootstrap` header.
  No guest role yet (Step G). Step B must rewrite `features/auth/api.ts` + schemas against these.
- Run the backend for dev with `CLAUDE_LB_DATA_DIR=<tmp> uv run claude-lb serve --port 2456` to avoid touching the
  real DB; port 2457 belongs to an unrelated process.

### 2026-11-26 — Step B (auth gate, shell, settings)
**Done**
- **Casing converter** (`src/lib/casing.ts`, wired in `src/lib/api-client.ts`): every response body is camelized
  (snake_case → camelCase, keys only, deep, arrays walked) *before* zod validation; every JSON request body and every
  query-string key is snakified. Opt out per call with `{ rawKeys: true }` (keys are data: header maps, model-keyed
  maps, codex auth.json export). Error bodies stay raw in `ApiError.payload`. `post/put/patch(url, null, …)` now
  exist for 204 endpoints. FastAPI errors are parsed: `{"detail": "msg"}` → `ApiError{status, code: "http_<status>",
  message}`; 422 lists → `"field: msg; …"`. Tests: `src/lib/casing.test.ts`, `src/lib/api-client.test.ts`.
- **Auth** (`features/auth`): rewritten against `/api/auth/*`. Store (`hooks/use-auth.ts`) derives
  `passwordRequired` (=configured), `authenticated`, `totpEnabled`, `authEnabled`, `bootstrapRequired` (remote, no
  password), `insecure` (signed in with no password or auth disabled), `role` (always `admin`), `canWrite`
  (=authenticated). Gate states: spinner → signed in (app) / loopback-no-password (app + `InsecureModeBanner` with a
  "Set password" dialog) / remote-no-password (`BootstrapSetupScreen`: password + confirm + bootstrap token, sent as
  `x-claude-lb-bootstrap`) / password set (two-step `LoginForm`: password, then TOTP step when `totp_enabled`; one
  `POST /login {password, totp_code}`) / status request failed (retry card). Any 401 from another call flips the store
  to signed-out and re-reads status. 401 on login shows the i18n key `auth.login.invalidCredentials`.
- **Backend**: `AuthStatusOut.auth_enabled` (false when `CLAUDE_LB_DASHBOARD_AUTH_ENABLED=false`); `GET /health/ready`
  (SELECT 1, 503 on DB failure; both health endpoints return `version`); **bug fix**: request-log pruning used the env
  retention instead of the runtime (dashboard-editable) setting and ran only at startup — now uses the runtime value
  and the scheduler runs a third loop (`retention`, every 6 h). +4 pytest tests.
- **Shell**: header nav Dashboard/Reports/Accounts/APIs/Settings; Advanced dropdown is driven by
  `ADVANCED_NAV_ITEMS` and hidden while empty (Automations removed from nav and routes — no backend; unknown routes
  redirect to /dashboard; `/firewall` redirect removed). New `ThemeToggle` (Light/Dark/System) in header and mobile
  sheet; language menu (en/zh-CN/ko); privacy blur; Sign out only when a password exists. Accounts badge = number of
  available accounts (red at 0, hidden with no accounts) from `features/accounts/pool-status.ts` (minimal loose schema
  over `GET /api/accounts`, query key `["accounts","pool-status"]`). Status bar: readiness from `/health/ready`,
  version from `/health`, routing label = strategy (+ "Sticky sessions" unless `single_account`), usage-sync =
  newest `quota_observed_at` (fresh within 2× probe interval + 60 s, min 5 min; "Not yet observed"; hidden with no
  accounts). Update check removed (`features/runtime` deleted). `src/utils/server-date.ts` parses naive SQLite
  timestamps as UTC — use it for every claude-lb datetime.
- **Settings** (`features/settings`): `GET/PATCH /api/settings`, `POST /api/settings/reset`. Cards: Appearance
  (unchanged, browser-local), Routing (strategy select over `available_strategies`, per-strategy guide for all 9 with
  "Current" marker, max attempts, sticky toggle + TTL), Background jobs (probe/model-sync toggles + intervals),
  Data retention (request-log days), Dashboard password (set / change with current password / sign out everywhere),
  TOTP (enroll → client-side QR via `qrcode-generator` rendered as an SVG path in `src/components/qr-code.tsx`,
  secret shown, confirm; disable), Reset to defaults (confirm dialog). PATCH sends only the changed key; the response
  envelope is written straight into the query cache. Reusable `SettingsCard`/`SettingsRow`/`SwitchSettingRow`/
  `NumberSettingRow` (bounded integer input with its own Save; remount via `key` when the server value changes) in
  `settings-card.tsx`; bounds in `SETTINGS_LIMITS` mirror `RuntimeSettings`.
- Removed (codex-only or no backend): settings payload/advanced group/deeplink, import, reset-credit, guest-access,
  session-TTL, codex data-retention, codex routing card, password remove/verify dialogs, TOTP login dialog, telemetry
  and runtime-version APIs. Upstream-proxy schemas/api/hook moved to `features/accounts/upstream-proxy-legacy.ts`
  (accounts page still uses it — delete in Step C). Accounts page reset-credit badge flags are hard-coded `true`
  (LEGACY comment) until Step C. Firewall, sticky-session and quota-planner feature folders are kept but not rendered.
- Tests rewritten: auth api/schemas/store/gate/login-form, settings page/hook/password/TOTP, header, status bar,
  auth-flow integration. Deleted: api-keys-flow and firewall-flow integration tests (exercised removed Settings
  sections), two automations navigation tests. Legacy tests that inspect raw requests now expect snake_case.

**Results**: `npm test` 127 files / 996 tests pass; `npm run lint` clean; `npm run build` OK; `ruff` clean;
`pytest` 434 passed. Browser smoke on :2461 (fresh data dir, loopback): insecure banner shown → set password from
banner → banner gone, Sign out appears; routing strategy changed to Least used, persisted across reload, status bar
"Least used + Sticky sessions"; TOTP enrolled with the rendered QR and a real code; signed out → two-step sign-in with
TOTP worked; wrong password/code shows the translated error; language switch to 한국어 and theme switch to Dark from the
header work. Console: only the expected 401s from the deliberate wrong sign-ins.

**Known issues**
- Remote bootstrap screen verified by tests only (browser smoke ran on loopback).
- Server error messages other than the login 401 (e.g. "current password is incorrect", 422 details) are shown in
  English as the backend sends them.
- `GET /api/accounts` MSW handler still returns codex-lb's `{accounts: [...]}` shape, so in tests the pool-status query
  fails schema validation (badge/usage-sync hidden; dev console noise). Fix when Step C rewrites the accounts handler.
- Dashboard/Reports/Accounts/APIs pages still call codex-lb endpoints (unchanged from Step A).
- zh-CN has no translations for the new keys (falls back to English).
- `SettingsSkeleton` still draws an Appearance placeholder although Appearance renders immediately.

**Notes for next agents**
- Casing: write zod schemas in camelCase for claude-lb's snake_case JSON and pass camelCase bodies/query keys —
  the client converts. Use `{ rawKeys: true }` whenever object *keys* are data. Never camelize values.
- MSW: handlers for claude-lb endpoints live in `claudeLbHandlers` at the top of `src/test/mocks/handlers.ts` and must
  mirror the real FastAPI behaviour: snake_case JSON from wire factories (`createAuthStatus`, `createRuntimeSettings`,
  `createSettingsEnvelope` in `factories.ts`, typed `*Wire`), `{"detail": …}` errors, 204 with no body, 401 via
  `managementAuthError()`. Read request bodies raw (`readJsonObject`). Tests tweak state with `setMockAuth({...})`
  and read it with `getMockSettings()`; `resetMockState()` runs after each test. The remaining codex-lb handlers use
  `legacyJson()`/`legacyRequestUrl()` (camelize incoming requests) — when you port an endpoint, move it into
  `claudeLbHandlers` and drop the legacy helper for it. Update `handler-coverage.test.ts` with every handler change.
  Tests that render `App` or depend on `canWrite` must make sure the auth store is signed in
  (`useAuthStore.setState(useAuthStore.getInitialState())` + default mock = signed in, or set `canWrite: true`).
- i18n: flat dotted keys (`area.section.item`), en + ko written together; Korean uses natural product terms
  (계정, 구독, API 키, 라우팅, 세션 고정) and polite -습니다/-세요 endings, no English mixed in except proper nouns.
  Plurals use i18next `_one`/`_other` (ko needs only `_other`). Store-level errors may hold an i18n key; render with
  `t(error)` (unknown text passes through).
- Settings cards: build new ones from `settings-card.tsx`; save with `onSave(partialPatch)`.


### 2026-11-26 — Step C (accounts page)
**Done**
- **Backend** (`claude_lb/modules/accounts/api.py`, `health/service.py`, `proxy/{load_balancer,model_blocks}.py`):
  - Pause semantics: `PATCH enabled=false` now sets `disabled_reason = "paused by operator"` (`PAUSED_REASON`,
    `is_paused()` in `load_balancer`). **Bug fix**: the background health probe used to re-enable *any* disabled account
    whose `/v1/models` call passed, so an operator's "Disable" silently undid itself on the next tick; paused accounts
    are now skipped by `_needs_probe` and never re-enabled by a probe. `PATCH enabled=true` still clears the breaker
    (confirmed + tested). Breaker-disabled accounts (401/403) are still probed and recovered as before.
  - `PATCH name` renames (409 on a taken name, 422 on empty).
  - `AccountOut` gained `paused`, `spend_cap_reached`, `consecutive_failures`, `model_blocks: [{model, until}]`
    (`blocked_models` kept).
  - `POST /api/accounts/{id}/probe` → `{probe: {ok, status_code, detail, models}, account}` via new
    `health.service.probe_one` (any state; does not reset 5h/7d quota status; paused stays paused; audited).
  - `DELETE /api/accounts/{id}/model-blocks[?model=]` (404 if that model is not blocked).
  - `GET /api/accounts/{id}/trends?days=7` → `{quota: [{t, primary_used_percent, secondary_used_percent}]` (hourly
    max from `QuotaHistory`), `usage: [{day, requests, errors, input_tokens, output_tokens, cost_usd}]` (zero-filled,
    from `UsageDaily` rollups), `totals}`.
  - `DELETE /api/accounts/{id}?delete_history=true` also deletes the account's request logs and daily rollups; quota
    snapshots are always removed (SQLite does not enforce the FK cascade).
  - Tests: new `tests/test_accounts_api.py` (22 tests).
- **Frontend** `features/accounts` rewritten on claude-lb shapes: `schemas.ts` (`AccountSchema` etc.), `api.ts`,
  `status.ts` (derived status: available / cooling_down / rate_limited / quota_exceeded / spend_cap / paused /
  disabled, `statusLiftsAt`, helpers), `sorting.ts` (name / reset soonest / most remaining + search/status filter),
  `hooks/use-accounts.ts` (`useAccounts`, `usePoolQuota`, `useAccountTrends`, `useAccountMutations` → `create`,
  `importCredentials`, `update`, `remove`, `probe`, `resetQuota`, `clearBlocks`, `busy`), `lib/time.ts` (`useNow`,
  `formatAbsolute`, `formatUntil`, `formatAgo`, direction-free `formatDuration`), `lib/subscription-command.ts`.
  Components: `account-list`, `account-list-item`, `account-badges` (status/plan/policy/provider/risk),
  `account-quota-bars` (`UsageBar` = *used* % bar, `AccountQuotaBars` = 5h/7d or rate-limit headroom),
  `account-detail` (name edit, badges, status + reason + countdown, Pause/Resume, Probe now with inline result, Reset
  quota state (confirm), Delete (confirm + "also delete history")), `account-model-blocks` ("MODEL is temporarily
  unavailable on X — routed to other accounts until T", per-model / all "Try again"), `account-usage-panel` (5h/7d with
  absolute reset + countdown, unified/overage status, rl_* headroom, all-time + last-7-days totals, credential type /
  hint / expiry / refresh failures / base URL), `account-trend-chart` (hourly 5h/7d area chart for subscriptions +
  daily requests bar chart), `account-settings-card` (plan, policy — save on change; weight, priority, spend cap with
  "$spent / $cap" bar, Remove cap), `add-account-dialog` (tabs: API key / Subscription = exact
  `uv run claude-lb account add-subscription <name> --plan-type … --routing-policy … --transport claude_code` with copy button + paste an
  `sk-ant-oat…` token → `POST /api/accounts {provider: oauth, auth_scheme: bearer}` / Import file → `POST
  /api/accounts/import`, sent with `rawKeys` so the credential bundle's keys are not snakified). No OAuth flow or
  client id anywhere. Depletion risk badge from `GET /api/usage/quota`.
- Removed codex-only code: `upstream-proxy-legacy.ts`, proxy binding, auth export, OAuth/device-code dialog +
  `use-oauth`, reset-credit dialog, warm-up/Trusted Access/alias UI, Windows OAuth help, `query-invalidation.ts`, the
  hard-coded reset-credit flags, and **the whole `features/automations` folder** (codex scheduled warm-up prompts; no
  backend, not routed since Step B) with its integration test and MSW handlers. Dashboard page: resume uses
  `update({enabled: true})`; warm-up toggle and reset-credit dialog removed. The codex `AccountSummary` schema the
  legacy dashboard overview still parses lives in `features/dashboard/legacy-account-schemas.ts` until Step D.
- Consumers ported to the new `Account`: api-keys `AccountMultiSelect` (name, plan, status badge, 5h/7d "left"
  chips; hides disabled, paused only with `allowPausedAccounts`) and the Reports account filter (`id`/`name`).
- **MSW**: `GET /api/accounts` now returns claude-lb's JSON array of snake_case accounts. New `accountHandlers`
  mirror the backend (create/import/patch/delete/probe/reset-quota/model-blocks/trends + `GET /api/usage/quota`);
  wire factories `createAccountWire`, `createSubscriptionAccountWire`, `createDefaultAccountWires` (alice-max Max 5x
  burn_first with a sonnet block, console API key with $10 cap, paused backup-key), `createAccountTrendsWire`,
  `createPoolQuotaWire`; helpers `setMockAccounts()` / `getMockAccounts()`. A mock account whose name contains
  "broken" fails probes with 401. Legacy overview data is `state.legacyAccounts`.
- i18n: ~210 new `accounts.*` keys in en + ko (zh-CN falls back to en); 283 dead `accounts.*`/`automations.*` keys
  removed from all three locales (keys still referenced by the legacy dashboard kept). The APIs page got its own
  `apis.list.adjustFilters`.

**Results**: `npm test` 107 files / 859 tests pass; `npm run lint` clean; `npm run build` OK; `ruff` clean;
`pytest` 456 passed (+22). Browser (demo on :2461, fresh data dir, Korean UI then English + dark mode): list with
search/filter/sort, 5h/7d bars, plan/policy/risk badges and provider icons; detail with countdowns, usage, credential,
hourly quota + daily request charts; probe → "점검 통과" inline + toast; spend cap 3 → "$5.39 / $3.00" red bar,
status "Spend cap reached", nav badge 3→2, Remove cap restores it; policy → Preserve; Pause → paused (`disabled_reason`
"paused by operator") → Resume clears it; added an API key (plan api, x-api-key, cap 1.5) and a pasted `sk-ant-oat…`
token (oauth/bearer/pro). Console: no errors (only Chrome "form field should have an id or name" issues).

**Known issues**
- The legacy Dashboard account cards still offer "warm-up" / "reset credit" actions that now do nothing (Step D
  replaces those cards).
- A probe is `GET /v1/models`; it validates the credential but says nothing about 5h/7d quota (by design).
- Server error messages (e.g. duplicate name) are shown in English as the backend sends them.
- Chrome flags a few inputs without `id`/`name` (search box, file input) — cosmetic.
- `features/dashboard/legacy-account-schemas.ts`, `components/status-badge.tsx`, `mini-quota-bar.tsx` and
  `utils/account-status.ts` remain only for the legacy dashboard.

**Notes for next agents (Step D)**
- Reuse for the Dashboard accounts section: `AccountListItem` (pass no `onSelect` for a static card, or `onSelect`
  to navigate to `/accounts?selected=<id>`), `AccountQuotaBars`, `UsageBar`, `AccountStatusBadge` / `PlanBadge` /
  `RoutingPolicyBadge` / `ProviderIcon` / `RiskBadge`, `useAccounts()` (`["accounts","list"]`), `usePoolQuota()`
  (`["usage","quota"]`, has pool totals too), `accountStatus()` and `useNow()` for countdowns. Mutations invalidate
  `["dashboard"]`, so a Dashboard query under that prefix refreshes after account edits.
- Selection is the `?selected=` search param. Dates from claude-lb: always `parseServerDate` / `lib/time.ts`.


### 2026-11-26 — Step D (dashboard overview, pacing, request logs)
**Done**
- **RequestLog columns** (nullable, added to old DBs by `db/schema.py` reconcile; index
  `ix_request_logs_session_created`): `ttft_ms` (first streamed byte, measured from request arrival in
  `wrap_stream_for_accounting`; null for buffered responses), `session_key` (the sticky-routing conversation hash
  `proxy.sticky.session_key(body, api_key_id)`, now computed once in `proxy/api.py` for *every* request and passed into
  `ProxyService.forward(session_key=…)` so sticky routing reuses it), `user_agent`, `client_ip`
  (`auth.dependencies.client_ip`). `record_request` / `wrap_stream_for_accounting` take them as optional kwargs.
  Demo seed rows and demo traffic carry them too; the demo gained a 4th account (`claude-pro`, plan `pro`).
- **`GET /api/dashboard/overview?timeframe=1h|24h|7d|30d`** (`modules/dashboard/{data_api,overview,timeframes}.py`):
  `current` and `previous` (equal preceding window) metrics — requests, errors, error_rate, top_error(+count),
  input/output/cache read/cache write/total tokens, cost, cache_savings_usd, cache_hit_rate, conversations (distinct
  session_key), avg_duration_ms, avg_ttft_ms — `can_compare` (= previous window had traffic), `trends` (fixed buckets:
  1h→12×5 min, 24h→24×1 h, 7d→28×6 h, 30d→30×1 d; per bucket requests/tokens/cost/savings/hit rate/error rate/
  conversations), `by_model` (same totals per model) and `meta` (version, accounts total/available, pool remaining %
  as `/api/usage/quota` computes it, routing strategy, sticky flag, log retention days, last request). Bucketing is
  done in SQL with a dialect switch (`julianday` on SQLite, `extract(epoch)`+`floor` on Postgres). Reads request logs, so a window longer than retention is truncated (UI says so).
- **`GET /api/dashboard/projections`**: `primary`/`secondary` window capacity over *enabled subscription* accounts
  (`plan_type != "api"`; paused/disabled excluded): capacity/remaining credits, remaining %, capacity-weighted safe line
  (elapsed share of each window) and risk, risk level, EWMA burn rate (credits/h), projected exhaustion, next reset,
  per-account rows (used %, remaining, reset, safe line, risk, burn, observed_at; unobserved accounts count as full).
  `weekly_pace` = port of codex-lb `weekly_pace.py` in `modules/dashboard/pace.py` (schedule gap, 30-min smoothed
  delta, forecast simulation over resets, shortfall, pause-for-break-even hours, throttle %, Pro accounts to cover with
  Pro = 100 credits, status behind/on_track/ahead/danger, confidence). Difference: idle accounts are not dropped as
  stale (claude-lb only observes quota on traffic) — staleness (>6 h since `quota_observed_at`) only lowers confidence.
  `api_accounts` = API-key accounts' lifetime spend vs `spend_cap_usd`. `quota.py` gained public `ewma_rate`,
  `window_risk`, `history_samples` (refactor, behaviour unchanged).
- **Request logs** (`modules/request_logs/{api,service}.py`): `GET /api/request-logs?limit&offset&search&timeframe|since
  &until&account_id*&api_key_id*&model*&status*&session_key` → `{requests, total, limit, offset, has_more}`; rows carry
  account name/plan, API key name, status category, ttft, cache tokens, total tokens, cost, per-row cache savings,
  error, session key, UA, IP. Status categories (`STATUS_CATEGORIES`): ok, aborted (2xx with an error, e.g. client
  hung up), rate_limited (429), overloaded (529), auth_error (401/403), client_error, server_error (5xx/0). Search is a
  LIKE (escaped) over id, model, error, session key, UA, IP, path, account name, key name. `GET /api/request-logs/options
  [?timeframe]` → accounts, api_keys (with key_hint), models, statuses present. `GET /api/request-logs/{id}` adds
  `cost_breakdown` (new `pricing.cost_breakdown_usd`; cache writes priced at the 5-min rate) and a `conversation`
  summary. `/api/usage/requests` unchanged.
- **Frontend `features/dashboard`** rewritten on these shapes: `schemas.ts`, `api.ts`, `utils.ts` (`buildStats`,
  `formatUsd`, `compareValues` %, `comparePoints` pp, `formatMs`, `formatHours`, `toIso` for naive UTC),
  `hooks/use-dashboard.ts` (overview/projections/cost-trend/detail; 30 s refetch, paused while the tab is hidden via
  React Query `refetchIntervalInBackground: false`), `hooks/use-request-logs.ts` (filters in the URL: `search`,
  `timeframe`, `accountId`, `apiKeyId`, `model`, `status`, `session`, `limit`, `offset`; overview window is `window`).
  Components: header meta line + window select + refresh; `StatsGrid` (6 cards: requests, tokens, cost, cache
  savings + hit rate, error rate + top error, active conversations; sparklines + deltas); `CapacityDonuts`
  (`usage-donuts.tsx`, 5h/7d, a segment per account, remaining in the centre, safe-line tick, risk badge, footer with
  safe line/next reset/burn/runs-out; hidden without subscription accounts); `WeeklyCreditsPaceCard`; `ApiSpendCard`;
  `account-section.tsx` (`AccountCards` reusing Step C `AccountListItem` + `AccountList` sortable table, summary line,
  quick actions pause/resume, probe, open in Accounts; view mode + sort persisted, sort key `…-account-list-sort:v2`);
  `UsageByModelTable` (requests, tokens, cache hit, saved, cost); `CostTrendChart` (28-day `/api/usage/trend`
  rollups); `RecentRequestsTable` (columns time, account, plan, API key, model, status, latency, TTFT, tokens incl.
  cached, cost incl. saved, attempts, details; plan/attempts hidden by default; chooser + resizable widths persisted
  under `claude-lb-dashboard-request-log-columns:v2`; row click opens details); `RequestFilters` (300 ms debounced
  search, timeframe all/1h/24h/7d/30d, multi-selects, conversation badge, reset); `RequestDetailsDialog` (fetches
  `/api/request-logs/{id}`; copy buttons for id/account/key/model/IP/UA/conversation key/error; token + cost table;
  "show this conversation's requests" sets the `session` filter); `RequestStatusBadge`. `DonutChart` gained
  `headerAction`/`footer` props and `min-w-0` (mobile overflow fix).
- **Removed**: `legacy-account-schemas.ts`, `account-credit-display`, codex account-card/cards/list/summary-line,
  conversations view/table/details/hooks/timeframe select, dashboard view selector, `components/status-badge.tsx`,
  `REQUEST_STATUS_LABELS`, `formatModelLabel` (reasoning effort/service tier), `formatConversationDuration`, the old
  dashboard tests and `__integration__/dashboard-flow.test.tsx`, MSW conversation handlers and legacy dashboard
  factories. Reports page reads `apiKeys[].keyHint` from the new options endpoint.
- **i18n**: all `dashboard.*` keys replaced (en 212, ko 198 — ko has no `_one`), 128 old keys removed per locale;
  zh-CN keeps 72 old translations whose key and placeholders still match, the rest falls back to English.
- **MSW**: new wire factories `createDashboardOverviewWire`, `createDashboardProjectionsWire`, `createWindowCapacityWire`,
  `createWeeklyPaceWire`, `createUsageTrendWire`, `createRequestLogWire`, `createDefaultRequestLogWires`; handlers for
  overview (422 on bad timeframe), projections, `/api/usage/trend`, request logs (filters mirror the backend on the
  snake_case query), options, detail; helpers `setMockRequestLogs()`, `setMockProjections()`.

**Results**: `pytest` 496 passed (+40, `tests/test_dashboard_api.py`: recorded columns incl. streaming TTFT and
exhausted requests, schema reconcile of an old `request_logs` table, overview totals/deltas/buckets for all four
timeframes, projections + weekly pace, request-log paging/filters/search/options/detail, status categories); `ruff`
clean; `npm test` 89 files / 597 tests pass (new: `dashboard-page.test.tsx` 12, `utils.test.ts`,
`weekly-credits-pace-card.test.tsx`, `use-request-logs.test.ts`, `api.test.ts`); `npm run lint` clean; `npm run build` OK.
Browser (demo on :2461, fresh data dir): all widgets render with data (6 stat cards with sparklines, deltas on the 1h
window, 5h/7d donuts with 2 subscription segments + safe-line tick at "warning", weekly pace, API key spend, 4 account
cards → list view, model table, 28-day cost chart, 904 request rows); `?status=overloaded&timeframe=24h` → 9 rows all
Overloaded 529; `?search=prod-eu` → 180 rows, Next page → 26–50 of 180; details dialog with copy buttons, "show this
conversation" → `?session=…`, 2 rows; probe quick action → toast; Korean + dark mode at 390 px: no horizontal page
scroll (scrollWidth 390); no console errors or warnings.

**Known issues**
- Overview/sparklines read request logs only; windows longer than `request_log_retention_days` are truncated (a note
  is shown). The cost chart uses rollups and is not.
- Burn rate often reads "Idle": the EWMA restarts whenever utilization drops (window reset or the demo's cycling fake
  utilization), so short-lived histories give no rate. Weekly pace then says "not enough recent readings".
- Cost breakdown prices all cache writes at the 5-min rate (the 1-h share is not logged); the total is authoritative.
- `formatHours` drops minutes once a duration exceeds a day ("1d" for 24.5 h).
- zh-CN lacks most new dashboard strings (English fallback).

**Notes for next agents (Step E Reports)**
- Reuse `modules/request_logs/service.py` (`LogFilters`, `_apply`, `status_category`, `STATUS_CATEGORIES`) for report
  filters, and the new RequestLog columns (`ttft_ms`, `duration_ms` → TPS = output_tokens / (duration − ttft),
  `session_key`, `user_agent`, `client_ip`). Bucketing helper `_bucket_index(dialect, since, seconds)` in
  `modules/dashboard/overview.py` works for any bucket size.
- Frontend: `getRequestLogOptions` (dashboard api) now returns `{accounts, apiKeys{id,name,keyHint}, models, statuses}`;
  `MultiSelectFilter`, `PaginationControls`, `TimeframeSelect`, `CostTrendChart`, `UsageByModelTable`,
  `RequestStatusBadge`, `formatUsd`/`formatMs` are reusable. Reports page still calls codex-lb `/api/reports*`.


### 2026-11-27 — Step E (reports page)
**Done**
- **Backend**
  - `modules/usage/reports.py` rebuilt on "facts" (aggregated day x account x key x model [x UA family] cells):
    `ReportFilters` (multi-value accounts / API keys / models / user-agent families), `load_facts` (rollups, or request
    logs when a UA filter/grouping needs them — day bucket via Step D `_bucket_index`, portable), `group_facts`,
    `user_agent_family` (product token before the first `/`, `(unknown)` for none) + its SQL twin
    `user_agent_condition`, `log_conditions`, `day_bounds`. Groupings: day / account / api_key / model / **user_agent**.
    Range validation adds a **366-day maximum**. Rows carry `total_tokens` and `cache_savings_usd` (priced per model).
  - `GET /api/usage/report` and `/api/usage/report.csv` accept `account_id*`, `api_key_id*`, `model*`, `user_agent*`;
    JSON gained `source`; CSV gained `cache_savings_usd` **before** `cost_usd` (cost stays last for existing sheets).
    Existing tests/behaviour unchanged.
  - New `modules/reports/{service,api}.py`: **`GET /api/reports?start&end&group_by&account_id*&api_key_id*&model*&user_agent*`**
    → `{start, end, days, group_by, source, coverage{retention_days, logs_from, logs_truncated}, summary{total cost,
    avg/day, requests, avg/day, errors, error_rate, aborted, accounts_used, conversations, input/output/cache read/
    cache write/total tokens, cache_savings_usd, cache_hit_rate, median_ttft_ms, median_tps}, previous{same-length
    preceding window: cost, requests, tokens, errors, savings, can_compare}, daily[zero-filled: totals + aborted,
    conversations, median_ttft_ms, median_tps], by_model, by_user_agent, breakdown, breakdown_total}`.
    Spend/tokens/requests/errors come from rollups (not truncated by retention); aborted, conversations, TTFT/TPS
    medians and UA distribution come from request logs (medians computed in Python over the window's streamed rows;
    TPS = output / ((duration − ttft)/1000)). A UA filter moves the whole report to logs (`source=request_logs`).
    `logs_from` = day after the retention cutoff (or `start`), `logs_truncated` when the range starts on/before the cutoff.
    **`GET /api/reports/options?start&end`** → all live accounts/keys plus deleted ones seen in rollups, models in range,
    UA families in range. Both are management-guarded; bad input → 422.
  - Tests: new `tests/test_reports_page.py` (21).
- **Frontend `features/reports`** rewritten on these shapes: `schemas.ts`, `api.ts` (`reportQuery` shared by JSON and
  the CSV URL `reportCsvUrl`), `date.ts` (UTC days — rollups are UTC; `dateRangeProblem` → invalid/reversed/tooLong),
  `compare.ts`, `hooks/use-reports.ts` (URL state: `preset` (7/30/90, default 30 = no param) or fixed `start`+`end`,
  `groupBy`, repeated `accountId`/`apiKeyId`/`model`/`userAgent`; 60 s refetch paused in background; options query),
  `hooks/use-report-chart-visibility.ts` (7 charts, key `claude-lb-reports-visible-charts:v2`). Components:
  `ReportsFilters` (presets, two UTC date inputs with inline error, 4 multi-selects, clear, group-by select, chart
  chooser), `ReportsSummaryCards` (cost, requests + accounts used, tokens in/out/cache, cache savings + hit rate,
  errors + error rate + aborted, conversations; ▲/▼ vs previous window), generic `DailyTrendChart` (areas for sums,
  lines with gaps for medians) used for cost+savings, tokens (stacked in/cache read/cache write/out), requests+errors,
  median TTFT, median TPS; `DistributionDonut` (model / user agent, cost/tokens/requests toggle, stacks on mobile);
  `BreakdownTable` (sortable, totals footer, savings + hit rate, "Export CSV" = server CSV with the same filters);
  retention notice (+ per-chart note) and a "user-agent filter reads logs" notice; `group-label.ts` translates
  `(unattributed)` / `(deleted: …)` / `(unknown)`.
- **Removed**: codex reports leftovers — timezone handling, `daily-series.ts`, queue-wait chart, reasoning tokens,
  `daily-detail-table` (client CSV), per-file chart components, model/useragent donuts, `distribution-metric-format`,
  their tests and `__integration__/reports-date-range-flow.test.tsx`.
- **i18n**: all `reports.*` keys replaced — en 91, ko 89 (no `_one`), 61 old keys removed per locale; zh-CN keeps 11
  still-valid translations (rest falls back to English).
- **MSW**: `createReportWire({start,end,groupBy}, overrides)`, `createReportOptionsWire()`, handlers for `/api/reports`
  (422s mirror `normalize_range`/group_by) and `/api/reports/options`, `setMockReport(overrides)`; coverage test updated.

**Results**: `pytest` 517 passed (+21); `ruff` clean; `npm test` 82 files / 494 tests pass (reports: 7 files / 31 tests —
`reports-page.test.tsx` 9, `breakdown-table.test.tsx` 3, `date`, `compare`, `api`, `use-reports`, chart visibility);
`npm run lint` clean; `npm run build` OK. Browser (demo on :2461, fresh data dir, Korean UI): 90d preset → 6 cards,
cost/tokens/requests area charts with data from 10-27 on, TTFT/TPS lines on the 2 days that have streamed logs,
both donuts, 28-row day breakdown + totals, retention notice ("2026-10-27부터"); group by API key → 4 rows incl.
"(귀속 없음)", URL `?preset=90&groupBy=api_key`; CSV link fetch → 200, `attachment; filename="claude-lb-api_key-…csv"`,
TOTAL row; UA filter `claude-cli` → logs-only notice, totals $8.01; `?start=2026-11-20&end=2026-11-10` → inline error,
no `/api/reports` request; editing the start date → fixed range in the URL, preset un-pressed; dark + 390 px: no
horizontal scroll (scrollWidth 390), donut legends readable; no console messages.

**Known issues**
- Dates are UTC days (rollups are keyed by UTC date); the UI says "UTC 기준/UTC days". No per-browser timezone like codex-lb.
- A UA filter or UA grouping makes totals retention-limited (notice shown).
- Medians load every streamed row in the window into Python (bounded by retention); fine for demo scale, could be heavy
  for very busy instances with long retention.
- `breakdown_total` for non-UA groupings equals the summary; log-based error counts can differ slightly from rollup
  errors for the same window (different sources).
- The CSV link stays enabled while the date range is invalid (the server would answer 422).
- zh-CN lacks most new report strings.

**Notes for next agents**
- Reuse `usage.reports.ReportFilters`/`load_facts`/`group_facts` for any per-key/per-account rollup aggregation
  (Step F API-key trends can use `load_facts(..., ReportFilters(api_key_ids=[id]))`).
- `/api/reports/options` lists all live accounts/keys; `MultiSelectFilter` already shows stale selected values.
- `DailyTrendChart` takes any `DailyPoint` keys; `ReportChartCard` has `note`, `legend`, `autoHeight`.



### 2026-11-27 — Step F (API keys page)
**Done**
- **Backend** (`modules/api_keys/{api,service,limits}.py`, `db/models.py`, `dependencies.py`, `proxy/{api,service}.py`):
  - `ApiKey` gained nullable `allowed_models_json`, `enforced_model`, `assigned_account_ids_json` (added to old DBs by
    the schema reconcile; `allowed_models` / `assigned_account_ids` properties parse them, unreadable JSON fails
    *closed* as `[]`). New table `api_key_limit_rules` (`metric`, `window`, `window_seconds`, `max_value`,
    `model_filter`, `position`), `ApiKey.limit_rules` relationship (selectin, delete-orphan, so deleting a key removes
    its rules on SQLite too).
  - **Limit rules** (`limits.py`): metrics `requests | total_tokens | input_tokens | output_tokens | cost_usd` (input =
    input + cache read + cache write, total = input + output — same counting as the original budget); windows `5h`,
    `7d`, `custom` (rolling, `window_seconds` 60 s … 366 d) and `daily | weekly | monthly` (UTC calendar, week starts
    Monday). Optional `model_filter` = exact id or family prefix (`claude-sonnet-4-5` matches
    `claude-sonnet-4-5-20250929`; same matching as the allowlist). Usage is counted from request logs, one SQL query per
    distinct (window start, model filter). `resets_at`: calendar → next boundary; rolling → oldest counted request +
    window ("frees up at"), null when nothing is counted. The **original single budget** (`max_*_per_window` +
    `window_seconds`) is kept and evaluated as up to three `legacy` rules (`id: legacy-<metric>`, window `5h`/`7d` when
    the seconds match, else `custom`); `PATCH {limits: [...]}` replaces all rules **and clears the legacy fields** (the
    UI loads legacy rules into the editor, so nothing is lost). CLI `key create` / `setup claude-code` still write the
    legacy fields.
  - **Admission** (`service.admit(session, key, model)`): the dependency now peeks the body's `model` (Starlette caches
    the body). Effective model = enforced model (if the request names a model) else requested; allowlist → 403
    `permission_error` "this API key is not allowed to use model 'x' (allowed: …)" (requests without a model —
    `/v1/models`, files — pass); then only the rules whose filter matches the model are checked under the per-key lock;
    request rules count in-flight slots (slots now remember their model so filtered request rules count only matching
    in-flight requests), token/cost rules count logged usage only (unchanged trade-off). 429 `rate_limit_error`
    "limit reached for this key: 40 output tokens per UTC day; usage frees up at …" + `retry-after` seconds.
    `AuthError` gained `error_type` and `retry_after`; disabled/expired keys keep `authentication_error`.
  - **Enforced model**: `proxy/api.py::_enforce_model` rewrites `model` in a JSON-object body (content-length is
    already stripped and recomputed); other bodies are relayed untouched.
  - **Assigned accounts**: `ProxyService.forward` restricts the candidate pool to the key's assigned accounts before
    model filtering / sticky / strategy; never spills to the rest; none left (all deleted) → 503 "none of the accounts
    assigned to this API key exist any more"; all paused/cooling → the usual 503. `pinned_account_id` still works as
    before (the UI shows a pinned key as assigned to that account and clears the pin when assignments change).
  - **API**: `GET /api/keys` / `GET /api/keys/{id}` → `ApiKeyOut` + `status` (active/disabled/expired),
    `allowed_models`, `enforced_model`, `assigned_account_ids`, `limits[]` (`id, source, metric, window,
    window_seconds, max_value, model_filter, current_value, remaining, used_percent, window_start, resets_at`),
    `total_tokens`, `lifetime_requests`, `lifetime_cost_usd` (rollups; `total_requests`/`total_cost_usd` stay the key's
    own counters, which miss seeded/imported history). `POST /api/keys` accepts the new fields + `limits`;
    `PATCH /api/keys/{id}` accepts a JSON body with any of name / enabled / expires_at (null clears) / allowed_models
    ([] or null = unrestricted) / enforced_model / assigned_account_ids (unknown id → 422) / pinned_account_id /
    limits / legacy budget fields — only sent fields change; the legacy `?enabled=` query form still works; empty →
    422; duplicate name → 409; audited as `api_key.updated` (detail lists the fields) and `api_key.enabled/disabled`.
    `POST /api/keys/{id}/regenerate` → new secret, same record (`api_key.regenerated` audit). `GET /api/keys/overview`
    → total/active/disabled/expired/idle (active, no use in 7 d)/used_last_7d, lifetime requests/cost/tokens and
    `by_key` (rollups, live keys). `GET /api/keys/{id}/trends?days=7` (1–90) → zero-filled daily usage, totals,
    `by_account` (name, plan, deleted flag) and `by_model`, from `UsageDaily`.
  - Demo: `support-agent` now has three rules (5h requests, monthly cost, daily Opus output tokens).
  - Tests: new `tests/test_api_keys.py` (20): management round trips/validation/partial PATCH/legacy query form/
    regenerate (old secret 401, new 200)/legacy → rules conversion/delete cascade, usage per rule and model filter,
    trends + overview, **proxy-level**: disallowed model 403 (never reaches upstream), enforced model rewrite,
    assigned-account routing (only that account's credential is used; paused → 503, no spill), deleted assignment
    fails closed, multi-rule 429 with `retry-after`, model-filtered rule only limits that model, request rule holds a
    concurrent burst (2 of 8) and releases every slot; calendar bounds, model matching, corrupt JSON fails closed,
    and an old-shaped `api_keys` table upgrades and keeps its budget.
- **Frontend**
  - `features/api-keys`: `schemas.ts` (claude-lb shapes; cost in USD, no micro-dollars), `api.ts` (`/api/keys*`,
    catalog from `/api/health/models`), `lib.ts` (labels, `formatLimitValue`, `tightestLimit`, `normalizeRules`,
    `rulesChanged`, `ruleProblem`, `claudeCodeEnv`), `hooks/use-models.ts`. Components: `api-key-form-dialog.tsx` (one
    dialog for create and edit: name, expiry presets 1d/7d/30d/90d/1y/custom/none, enabled switch on edit, allowed
    models multi-select from the catalog **plus free text**, enforced model input with catalog datalist + warning
    when it is outside the allowlist, assigned accounts multi-select with plan + 5h/7d left chips and a "deleted
    account" chip for stale ids, limit-rules editor; edit sends only changed fields), `limit-rules-editor.tsx` /
    `limit-rule-card.tsx` (measure, window, amount, custom hours, model filter), `api-key-created-dialog.tsx` (show
    once + copy, plus the Claude Code snippet exactly as `claude-lb setup claude-code` prints: `export
    ANTHROPIC_BASE_URL=<origin>` / `export ANTHROPIC_API_KEY=…` and the `~/.claude/settings.json` `{"env": …}` form;
    "regenerated" wording variant), `api-keys-overview.tsx` (5 stat cards + cost/token rankings), `expiry-picker`
    (preset detection fixed to compare calendar days), `account-multi-select`, `model-multi-select`.
  - `features/apis`: `apis-page.tsx` (master/detail, `?selected=`, regenerate and delete confirmations, created dialog),
    `api-list(-item).tsx` (search over name/hint/models, status filter, status badge, last used, tightest-limit bar),
    `api-detail.tsx` (actions Edit / Enable·Disable / Regenerate / Delete; key info; limits; 7-day totals; cost-by-
    account donut; 7-day token+cost chart with cumulative toggle), `api-key-info.tsx`, `api-key-limits.tsx` (per rule:
    label, legacy badge, used / max, progress bar, "resets in" for calendar / "frees up in" for rolling windows),
    `key-status-badge.tsx`, `hooks/use-apis.ts` (30 s refresh; delete drops the key's cached trends first so nothing
    refetches into a 404).
  - **Removed** (codex-only / Step A leftovers): create + edit dialogs with `selectedSourceIds`/`clearSourceScope`,
    reasoning-effort / service-tier / traffic-class / transport-policy / apply-to-codex-model / usage-sections
    controls, `api-keys-section`, `api-key-table`, auth & quota-privacy toggles, `use-api-keys` hook, `limit-rules-utils`,
    `features/apis/{api,schemas}.ts`, credits metric, `/api/api-keys/*` + `/api/models` MSW handlers and factories.
  - **i18n**: all `apiKeys.*` / `apis.*` keys rewritten (en 171, ko 167 — no `_one`); zh-CN keeps 73 translations whose
    key and placeholders still match; 15 codex-only `common.reasoning/serviceTier/traffic.*` keys removed from all
    locales.
  - **MSW**: `apiKeyHandlers` mirror the backend (list/overview/create/get/patch incl. `?enabled=`/delete/regenerate/
    trends/`/api/health/models`, 409/422/404 like FastAPI); wire factories `createApiKeyWire`, `createLimitUsageWire`,
    `createDefaultApiKeyWires` (key_1 with allowlist + assigned `acc_max` + 2 rules, key_2 disabled with a legacy
    budget), `createKeyTrendsWire`, `createKeysOverviewWire`, `createCatalogModelWires`; `setMockApiKeys` /
    `getMockApiKeys`; coverage test updated.
  - Tests: `lib.test.ts` 6, `api.test.ts` 5, `api-key-form-dialog.test.tsx` 7, `api-key-created-dialog.test.tsx` 2,
    `model-multi-select.test.tsx` 2, `apis-page.test.tsx` 9, `__integration__/apis-page-flow.test.tsx` 1 (create →
    show once → edit through `App`); expiry-picker / account-multi-select tests updated.

**Results**: `pytest` 537 passed (+20); `ruff` clean; `npm test` 70 files / 384 tests pass (the drop from 82/494 is the
deleted codex api-key tests); `npm run lint` clean; `npm run build` OK. Browser (demo on :2461, Korean UI, dark,
fresh data dir): overview 5 cards + rankings; created `browser-test` with 7-day expiry, allowed `claude-haiku-5-5`
(typed, the demo catalog is empty), assigned `prod-us`, rules $5/day + 2 requests/5 h → show-once dialog with env
snippet, Copy → "복사됨" + toast; detail shows both rules with bars and reset/free-up times, 7-day totals, donut and
chart. **curl against the demo proxy with that key**: `claude-opus-5-5` → 403 `permission_error`; haiku → 200, 200
(both `x-claude-lb-account: prod-us`), then 429 `rate_limit_error` "2 requests per rolling 5h; usage frees up at …"
with `retry-after: 18000`. Edit (rename) sent only `name` (audit `api_key.updated: name`); Regenerate (confirm) →
new secret dialog, old secret 401, new secret 429 (limits kept); Disable → proxy 403 "API key is disabled"; Delete
(confirm) → list/selection update. 390 px: page and dialog scrollWidth 390. Console: no errors (one Chrome "form field
should have an id or name" issue, count 2).

**Known issues**
- Limits are counted from request logs: a window longer than `request_log_retention_days` (default 30) only sees what
  is retained — a `monthly` rule with a shorter retention undercounts. Token/cost rules can be overshot by requests in
  flight (same as the original budget). Enforcement is per process.
- Allowed models do not filter `GET /v1/models` responses; they only refuse model requests.
- Calendar windows are UTC (consistent with reports), not the operator's timezone.
- On mobile the detail panel sits below the list; selecting a key does not scroll to it.
- Server messages (409 duplicate name, 422) are shown in English. zh-CN lacks most new strings.
- The demo model catalog is empty, so the model pickers offer free text only there.

**Notes for next agents**
- Rule evaluation lives in `modules/api_keys/limits.py` (`key_rules`, `measure`, `describe`); reuse `measure()` for
  any "usage vs limit" display. `service.check_model_allowed` / `effective_model` are the model policy.
- Frontend: `ApiKeyFormDialog` takes `apiKey: null` for create; `useApiKeys()` mutations invalidate the whole
  `["api-keys"]` prefix. Wire factories for keys are in `test/mocks/factories.ts` (snake_case).


### 2026-11-27 — Step G1 (conversations, audit log, model catalog, sticky sessions)
**Done**
- **Backend**
  - Conversations (`modules/request_logs/conversations.py`, routes in `request_logs/api.py` as `conversations_router`):
    **`GET /api/conversations?limit&offset&search&timeframe|since`** groups request logs by `session_key` (rows without
    one are skipped) → `{conversations[{session_key, first_at, last_at, duration_ms, requests, errors (= not "ok"),
    input/output/cache read/cache write/total tokens, cost_usd, accounts[{id,name}], api_keys[{id,name}], models[]}],
    total, limit, offset, has_more}`; newest activity first; aggregates cover the window only; facets are ranked by
    request count and computed for the page's keys only (one extra grouped query). Search = a conversation with *any*
    request whose key/model/UA/IP/account name/key name matches (escaped LIKE, subquery). **`GET
    /api/conversations/{key}`** (whole retained conversation) → summary + `busy_ms` (sum of durations), `accounts`
    (with plan + requests), `api_keys`, `dominant_user_agent` and `_family` (`usage.reports.user_agent_family`),
    per-model stats, `timeline` (≤ 200 `RequestLogItem`s, newest first, `timeline_truncated`); 404 when unknown.
  - Audit: **`GET /api/audit/events?limit&offset&action*&target&search&timeframe|since&until&ok`** →
    `{events, total, limit, offset, has_more}` (target = substring, search over action/target/detail/IP/actor, both
    escaped LIKE); **`GET /api/audit/actions`** → `[{action, count}]`. `GET /api/audit` (plain list) is kept for the
    legacy page/scripts. Health probe/model-sync audits now carry the client IP.
  - Model catalog page: **`GET /api/health/catalog`** → `models[{model_id, display_name, accounts[{id,name}],
    max_input_tokens, max_output_tokens, synced_at, price, price_key}]` (price = the `pricing.PRICES` entry the id
    resolves to by the same longest-prefix rule, per MTok: input/output/cache_read/cache_write_5m/cache_write_1h +
    long-context tier), `prices` (the whole built-in table), `blocks` (learned temporary reroutes from
    `Account.model_blocks_json`: account, plan, model, until), `accounts` (models synced per account,
    `models_synced_at`, enabled/paused), `last_synced_at`. `/api/health/models`, `/sync-models`, `/probe` unchanged.
  - Sticky sessions (`modules/sticky_sessions/api.py`, helpers `entries/forget_many/forget_account/purge_expired/
    capacity` in `proxy/sticky.py`): **`GET /api/sticky-sessions?account_id&include_expired&search&limit&offset`** →
    entries (key, account id/name, wall-clock `expires_at` derived from the monotonic expiry, `remaining_seconds`,
    `expired`), most recently used first, plus `size`, `expired_count`, `capacity` (10 000), `enabled`, `ttl_seconds`,
    `by_account` counts. `POST /delete {keys}`, `POST /delete-account {account_id}`, `POST /purge` (expired only) →
    `{deleted_count}`; `DELETE /{key}` → 204/404. All audited (`sticky.deleted`, `sticky.account_cleared`,
    `sticky.purged`). Management-guarded like every other router (admin only; guest role arrives in G2).
  - **Bug fix (demo)**: the fake upstream was appended *after* the dashboard's SPA fallback, so its `GET
    /__demo-upstream/v1/models` returned the dashboard HTML — model sync/probe in the demo always found 0 models (why the
    Step F demo catalog was empty). New `demo.mount_fake_upstream(app)` puts its routes first (+ regression test).
  - Tests: new `tests/test_dashboard_extras.py` (6: conversations list/facets/paging/search/escaping/422, detail,
    audit filters/paging/actions/legacy list, catalog prices/blocks/accounts, sticky list/filter/delete/purge/audit,
    401 guard) + 1 demo regression test.
- **Frontend**
  - Dashboard request-log section: **Requests / Conversations** tab switch (`?view=conversations`, own URL params
    `convSearch`, `convTimeframe` (default all), `convLimit`, `convOffset`). `ConversationsView` (debounced search,
    timeframe, table: last request, duration, short key `xxxxxxxx…xxxx`, accounts / API keys / models with "+N more",
    requests (+errors), tokens (+cached), cost; pagination). **Row click → request log filtered by that conversation**
    (reuses Step D `?session=`, drops `view`); "Details" → `ConversationDetailsDialog` (copyable key, start/last/duration,
    requests/errors, time in requests, cost, accounts, keys, main user agent, by-model table, request timeline, "Show
    these requests in the log"). Column chooser is hidden in the conversations view.
  - New pages under **Advanced** (desktop dropdown + mobile sheet; `ADVANCED_NAV_ITEMS`), lazy routes in `App.tsx`:
    - `/audit` (`features/audit`): search, timeframe, action multi-select (translated labels + counts), target, result
      (all/succeeded/failed), reset, all in the URL; table time / action (label + raw code + area dot) / target / detail /
      client IP / result; pagination. `action-labels.ts` lists every action the backend records (27) with en+ko labels
      (a test enforces both); unknown actions show their code.
    - `/models` (`features/model-catalog`): "Sync from upstream" and "Probe unhealthy accounts" with inline result cards
      (per-account models / pass-fail with HTTP status), summary (model count, last sync, per-account chips), **runtime
      reroutes** ("claude-opus-5-5 is temporarily unavailable on claude-pro — routed elsewhere until … (Nh left)", "Try again" →
      `DELETE /api/accounts/{id}/model-blocks?model=`), searchable model table (served by, context window, max output,
      price in/out + cache read/write + long-context tier, synced), collapsible built-in price table.
    - `/sticky-sessions` (`features/sticky-sessions`, codex code replaced): status card (on/off, TTL, size/capacity,
      expired, **in-memory/per-process note**), account filter (all live accounts with counts), key search, show-expired
      switch, row checkboxes + select-all on page, "Delete selected (N)", "Delete all for <account>", "Purge expired (N)",
      per-row delete — all behind confirm dialogs; "Requests" link → `/dashboard?session=<key>`; pagination; 15 s refresh.
  - Shared `components/search-input.tsx` (debounced text filter). `shortConversationKey` / `formatConversationDuration`
    in `features/dashboard/utils.ts`.
  - i18n: en +218 / ko +196 keys (`audit.*`, `models.*`, `stickySessions.*`, `dashboard.conversations.*`,
    `dashboard.requests.view*`, `nav.audit/models/stickySessions`); 47 codex `stickySessions.*` keys removed from all
    three locales. zh-CN falls back to English for all of these.
  - MSW: handlers for conversations (derived from the mock request logs, mirroring the backend grouping), conversation
    detail, audit events/actions, health catalog/sync/probe, sticky list/delete/delete-account/purge/delete-one; wire
    factories `createAuditEventWire`/`createDefaultAuditEventWires`, `createCatalogWire`, `createStickyEntryWire`/
    `createDefaultStickyEntryWires`; helpers `setMockStickyEntries`/`getMockStickyEntries`, `setMockAuditEvents`,
    `setMockCatalog`. Old codex sticky handlers removed; coverage test updated.
  - Tests: `conversations-view.test.tsx` 6, `audit-page.test.tsx` 7, `model-catalog-page.test.tsx` 6,
    `sticky-sessions-page.test.tsx` 7, `__integration__/advanced-pages-flow.test.tsx` 4, header +2.

**Results**: `pytest` 544 passed (+7); `ruff check` clean; `npm test` 72 files / 402 tests pass; `npm run lint` clean;
`npm run build` OK (lazy chunks: audit 9 kB, sticky 12 kB, model catalog 18 kB). Browser (demo on :2461, Korean UI):
conversations tab → 67 conversations with accounts/keys/models "+N more", details dialog (by-model + timeline, main
UA `anthropic-python`), "요청 로그에서 이 요청들 보기" → `?session=…` with exactly that conversation's 3 rows; model
sync → 3 models × 4 accounts with prices + long-context tier; a temporary reroute seeded in the demo DB shown and cleared by
"다시 시도" (audited `account.model_blocks_cleared`); probe → "점검할 비정상 계정이 없습니다"; audit page in dark mode with
translated labels; sticky: select 2 → confirm → "세션 고정 2개를 삭제했습니다", account filter → delete all for
claude-max-5x (confirm showed the count); 390 px: `/dashboard?view=conversations`, `/audit`, `/models`,
`/sticky-sessions` all scrollWidth 390 (tables scroll inside their cards), mobile sheet lists the three Advanced pages;
no console messages.

**Known issues**
- Conversation aggregates are retention-bounded (request logs) and the list's window aggregates only that window;
  detail always covers every retained request of the key.
- Sticky map is per process: with several workers the page shows only the worker that served the request (UI says so).
  Remaining time is a snapshot refreshed every 15 s.
- Demo seed rows use `ddd…dXX` session keys (only 60 distinct, shared across days), so seeded "conversations" span
  ~20 h; real keys are SHA-256.
- Audit `detail` strings come from the backend in English (e.g. "4 account(s)").
- `claude-lb demo` leaves its `claude-lb-demo-*` temp dir behind on exit (pre-existing; many exist in `$TMPDIR`).
- zh-CN lacks all G1 strings.

**Notes for G2**
- Advanced nav: add firewall/automations entries to `ADVANCED_NAV_ITEMS` in `components/layout/app-header.tsx` and lazy
  routes in `App.tsx`; `__integration__/advanced-pages-flow.test.tsx` and `app-header.test.tsx` list the expected items.
- Guest role: every G1 endpoint is behind `require_management_auth` (router-level in `main.py`); write endpoints are
  `POST/DELETE /api/sticky-sessions*`, `POST /api/health/{sync-models,probe}`, `DELETE /api/accounts/{id}/model-blocks`.
  The pages already disable write buttons when `useAuthStore().canWrite` is false.
- New audit actions need a label in `features/audit/action-labels.ts` + `audit.action.<action>` in en/ko (a test checks).
- `features/firewall` and `features/quota-planner` are still codex-lb leftovers with legacy MSW handlers.


### 2026-11-27 — Step G2 (IP firewall, guest read-only role, automations)
**Done**
- **IP firewall** (`modules/firewall/{service,api}.py`, table `firewall_entries`): mode `allow_all | allowlist` stored
  in the `settings` table under `firewall_mode` (not a `RuntimeSettings` key — `POST /api/settings/reset` now deletes
  only `RuntimeSettings` keys, so a reset never opens the firewall or touches guest access). Entries are IPv4/IPv6
  addresses or CIDR ranges (normalized: `10.0.0.5/32` → `10.0.0.5`; host bits set → 422 "did you mean 10.0.0.0/8?";
  IPv4-mapped IPv6 refused), with a note. **Semantics (codex-lb parity + explicit mode)**: guards the **proxy only**
  (`/v1/*`, router dependency `enforce_firewall` that runs *before* API-key admission); the dashboard and `/api/*`
  are never firewalled (they have their own password gate), so a bad entry cannot lock the operator out. Loopback
  gets **no** exemption on the proxy (a rule means exactly what it says); an allowlist with no entries refuses every
  proxy request (UI warns). Client address = `auth.dependencies.client_ip` (TCP peer; claude-lb has no trusted-proxy
  setting, so `X-Forwarded-For` is ignored — documented in the UI). Blocked → 403 Anthropic envelope
  `{"type":"error","error":{"type":"permission_error","message":"claude-lb: client address X is not allowed by the
  firewall"}}`. Decisions cached 5 s per process, invalidated on every change. API: `GET /api/firewall` (mode, entries
  with `covers_client`, `client_ip`, `client_allowed`, `client_covered`), `GET /api/firewall/check?network=` (normalized
  form, covers you?, would you pass after adding?), `PUT /api/firewall/mode`, `POST /api/firewall/entries` (201/409/422),
  `PATCH|DELETE /api/firewall/entries/{id}`. Audited: `firewall.mode_changed`, `firewall.entry_added`,
  `firewall.entry_updated`, `firewall.entry_removed`.
- **Guest role**: `DashboardSession.role` (`admin`/`guest`, additive column). Settings-table keys
  `guest_access_enabled`, `guest_password` (`{hash, salt}`, scrypt like the admin password). `GET /api/auth/status`
  adds `role`, `guest_access_enabled`, `guest_password_required`. `POST /api/auth/guest/login {password?}` (409 without a
  dashboard password, 403 when off, 401 wrong password, shares the login throttle; audited `auth.guest_login` with
  actor `guest`, failures committed). `GET/PATCH /api/auth/guest {enabled?, password?, clear_password?}` (admin;
  enabling needs a dashboard password; disabling or changing the password revokes every guest session; audited
  `auth.guest_access_enabled/disabled`, `auth.guest_password_set/cleared`). **Enforcement is in
  `require_management_auth`**: a guest session gets 403 "read-only guest access cannot change anything" on every
  non-GET/HEAD/OPTIONS management route (router-level dependency, plus every auth route that uses `ManagementAuthDep`).
  Guest sessions whose access was switched off resolve as signed-out. Secrets: masked hints only; checked that
  accounts/keys/audit/settings/status payloads carry no credential, key secret, password or bootstrap token.
- **Automations** (`modules/automations/{schedule,service,scheduler,api}.py`, tables `automation_jobs`,
  `automation_runs`): job = name, enabled (default **on**, codex-lb parity), weekdays + `HH:MM` + IANA timezone +
  spread 0–120 min, model, prompt (≤ 2000 chars), `max_tokens` 1–1024 (default 16), target account ids (empty = all,
  paused excluded unless `include_paused_accounts`), `armed_at`. Schedule math is pure (`schedule.py`): DST
  nonexistent local time fires at the pre-gap offset (02:30 → 03:30 EDT), ambiguous time fires once (first
  occurrence). **Firing**: `AutomationScheduler` ticks once per minute aligned to `:02`; a job's latest slot fires if it
  is ≤ 15 min old (`GRACE`) and not before `armed_at` (set on create / enable / schedule change, so moving or
  re-enabling a job never fires a past slot). A cycle = one `AutomationRun` per target, `slot_key`
  (`<job>:<local date>T<time>@<tz>:<account>`) is **unique** → idempotent across restarts and workers (inserted in a
  savepoint). Runs are claimed with a conditional UPDATE and sent through `ProxyService.forward(pin_account_id=…,
  force_account=paused&&include_paused)` (new params; sticky off for pinned requests; one account, no spill), logged as a
  normal request with UA `claude-lb-automation/<version>` (no API key) so spend/quota/rollups update. Skips without a
  request: account paused (unless included), breaker-disabled, deleted, or **model temporarily unavailable** (active block); an upstream
  availability response during the run marks `skipped: model temporarily unavailable` and records the reroute. Pending runs older than `GRACE`
  → `skipped (missed)`; `running` older than 15 min → `failed (interrupted)`. **Run now** `POST /api/automations/{id}/run`
  → 202, runs in a background task; 429 + `retry-after` if the job had a cycle in the last 5 min (manual or
  scheduled). `GET /api/automations` → jobs with targets, missing ids, `next_run_at`, `last_cycle`, `estimate`
  (prompt tokens ≈ chars/4 + 8, `per_request_usd` upper bound with `max_tokens` output, API-key vs subscription
  counts, `per_run_usd` for API-key accounts) + caps. `GET /api/automations/runs?job_id*&status*&trigger&account_id&
  limit&offset` → cycles (aggregate status pending/running/success/partial/failed/skipped, counts, tokens, cost, runs).
  `POST`, `GET|PATCH|DELETE /api/automations/{id}` (delete removes the run records; request logs stay). Audited
  `automation.created/updated/enabled/disabled/deleted/run_now`.
- **Frontend**
  - Auth: `AuthStatusSchema` gains `role`/`guestAccessEnabled`/`guestPasswordRequired`; store derives `role`,
    `permissions`, `canWrite = authenticated && role !== guest`, new `loginAsGuest`. `GuestLogin` under the sign-in form
    ("Continue as guest", password field when required). `ReadOnlyBanner` on every page of a guest session.
  - Settings: `GuestAccessSettings` card (admin only; switch + set/change/remove guest password, all behind confirms
    that spell out the exposure) and `FirewallSettings` card (`features/firewall`, codex code replaced): mode radio with
    confirm (warns when your address is not covered / list empty), "your address as seen by claude-lb: … proxy
    allowed/blocked", add form (preview via `/check`; in allowlist mode an entry that leaves you out asks "Add anyway"),
    table with IPv4/6 tag, "you" badge, inline note edit, remove confirm (warns when it is the last entry covering you).
    Read-only for guests.
  - `/automations` under Advanced (`features/automations`): jobs table (search, enabled filter, schedule summary + spread,
    model + max tokens, targets "+N more"/missing, next run + countdown, last cycle badge, max cost/run with API-key vs
    subscription counts, enable switch, Run now (confirm with cost warning), Edit, Delete (confirm)); job dialog (name,
    enabled, day toggles + Weekdays/Every day, time, spread, timezone with IANA datalist defaulting to the browser zone,
    "a 5-hour window started at 07:00 resets around 12:00" hint, model with catalog datalist, prompt, max tokens with
    cap, account multi-select (empty = all) + include paused, cost note; edit sends only changed fields); recent runs
    grouped by cycle with filters (automation, result, trigger), expandable per-account rows (status, HTTP, duration,
    error, tokens, cost), pagination; 3 s polling while a cycle is in flight.
  - Audit: 15 new actions in `action-labels.ts` + area dots for `firewall`/`automation`.
  - i18n: en +224 / ko +213 keys (`firewall.*`, `settings.guest.*`, `auth.guest.*`, `automations.*`, audit labels);
    17 codex keys removed from en/ko and 22 from zh-CN (zh-CN falls back to English for all G2 strings).
  - MSW: `g2Handlers` (guest login/config, firewall incl. CIDR coverage, automations incl. run-now cycles; writes return
    403 for a guest session), factories `createFirewallEntryWire`, `createAutomation{Job,Run,Cycle}Wire`,
    `createDefaultAutomationWires`; helpers `setMockGuest`, `setMockFirewall`/`getMockFirewall`,
    `setMockAutomations`/`getMockAutomations`; legacy codex firewall handlers removed; coverage test updated.

**Results**: `pytest` 588 passed (+44: `test_firewall.py` 17, `test_guest_role.py` 8 — incl. a sweep over every
write route in the app's OpenAPI schema (34) asserting 403 for a guest —, `test_automations.py` 19 — schedule
timezone/DST/validation, slot idempotency across "restarts", grace/armed/disabled, spread, missed/interrupted, skips,
include-paused, temporary model unavailability, upstream error, API CRUD/estimate/run-now/429/runs/audit); `ruff` clean;
`npm test` 75 files / 422 tests (new: firewall-settings 8, guest-access-settings 3, automations-page 7, schedule 3,
`__integration__/guest-flow` 3; header/advanced-pages/auth/settings tests updated); `npm run lint` clean;
`npm run build` OK.
Browser + curl (demo on :2461, fresh data dir, Korean + dark): added `10.0.0.0/8 (사무실)`, switched to 허용 목록 → confirm
warned "내 주소(127.0.0.1)가 목록에 없어서…" → curl `POST /v1/messages` from 127.0.0.1 with the demo key = **403
permission_error** while `GET /api/firewall` = 200; added `127.0.0.1` ("내 주소" badge, status "프록시 허용") → curl
**200**; removing it showed the "유일한 항목" warning (cancelled). Set a dashboard password, enabled guest access (confirm
text shown), created "출근 전 5시간 창 시작" (평일 07:00 Asia/Seoul, claude-max-5x + prod-eu, est. "≤ $0.0001 · API 키 1개
· 구독 1개(정액)"), Run now → cycle "2개 중 2개 성공", per-account HTTP 200 rows; `/api/request-logs?search=claude-lb-
automation` → 2 rows (both accounts, UA `claude-lb-automation/0.6.1`); a second run now → 429. Second isolated browser
context: sign-in screen shows "게스트로 보기 / 게스트로 계속" → read-only banner, no create/run/edit/delete buttons,
switch disabled; `fetch POST /api/automations` and `PUT /api/firewall/mode` from the guest page → **403**. Audit log
shows all firewall/guest/automation events (guest login with actor `guest`). 390 px: `/automations` (guest) and
`/settings` firewall card scrollWidth 390. Console: only the two deliberate 403s.

**Known issues**
- Firewall and its cache are per process (5 s TTL; other workers pick up a change within that). No trusted-proxy
  support: behind a reverse proxy every client is the proxy's address.
- Automations scheduler runs in every worker; `slot_key` uniqueness prevents double sends, but each worker will try
  to plan (harmless IntegrityError, logged at INFO). Runs are executed inside the tick, so a very slow upstream delays
  that worker's next tick (grace is 15 min).
- The 5-minute minimum interval is enforced for Run now (and is implied by the one-time-per-day schedule); there is no
  multi-time-per-day schedule.
- Cost estimate is an upper bound from the built-in price table (chars/4 token guess); unknown models estimate $0.
- The demo's fake upstream ignores `max_tokens`, so demo automation runs report ~1k output tokens.
- Guest role keeps masked credential/key hints and request-log client IPs visible (same as admin).
- zh-CN lacks all G2 strings.

**Notes for Step H**
- Old `index.html` still exists; nothing in G2 depends on it. `features/quota-planner` is still a codex-lb leftover with
  legacy MSW handlers (unused by any page) — remove in H.
- README/CHANGELOG should document: firewall semantics (proxy-only, no loopback exemption, no X-Forwarded-For),
  guest role, automations (UA `claude-lb-automation`, grace/idempotency, 5-min cooldown, `max_tokens` ≤ 1024).


### 2026-11-26 — Step H (cleanup, guest privacy, docs, final verification)
**Done**
- **Legacy dashboard removed**: `claude_lb/modules/dashboard/index.html` and its fallback are gone. Without
  `static/index.html`, `/` and client routes answer **503** with a short HTML page giving the build command
  (`cd frontend && npm ci && npm run build`); `/health`, `/api` unaffected. `tests/test_dashboard_spa.py` checks it.
  `tests/test_dashboard_contract.py` (which parsed the old HTML) is replaced by: every `/api/...` literal in
  `frontend/src` must be a prefix of a route in the app's OpenAPI schema, and the committed build's `index.html`
  must reference only files that exist. `test_auth` expects `<title>Claude LB</title>` only.
- **Codex leftovers removed**: `features/quota-planner/` (+ MSW handlers/factories, coverage entries, the camelCase
  `legacyJson`/`legacyRequestUrl`/`parseJsonBody` helpers), `utils/account-status.ts`, `utils/account-identifiers.ts`,
  `components/{mini-quota-bar,blur-email}.tsx`, codex constants (`STATUS_LABELS`, `ERROR_LABELS`, `ROUTING_LABELS`,
  `KNOWN_PLAN_TYPES`, `MESSAGE_TONE_META`) and formatters (token labels, reset-credit countdown, `formatSlug`) with
  their tests; `SettingsSkeleton` redrawn for the three server-backed cards (no telemetry/API-key placeholders).
  **i18n**: 449 unused keys removed per locale (en 1803→1354, ko 1746→1297, zh-CN 798→349). Script (scratchpad, not
  committed) treats a key as used if its literal appears in `src` or it matches a template literal that starts with a
  dotted prefix (`` `accounts.plans.${x}` `` — single-segment wildcard); `audit.action.*` keys contain dots and are
  matched by the full action list. Korean leftovers translated (`Credits` → 크레딧 on the donuts, `Reset`, formatter
  strings). Missing-key check: every `t("…")` literal exists in en and every en key exists in ko.
- **Guest privacy**: `require_management_auth` stores the role on `request.state`; `auth.dependencies.is_guest()`.
  For guests, `client_ip` is `null` in `GET /api/request-logs`, `/api/request-logs/{id}`, the conversation timeline,
  and `""` in `GET /api/audit/events` and `/api/audit`; searches skip the IP column (`LogFilters.search_client_ip`,
  `conversations.list_page(search_client_ip=)`, `audit.page(search_client_ip=)`) so an address cannot be confirmed by
  probing. User agents stay. Tests: `TestGuestPrivacy` in `tests/test_guest_role.py` (admin sees IP + IP search hits;
  guest gets the IP nowhere and every IP search returns 0).
- **Docs**: README (feature rows, new **Dashboard** section with a per-page table, guest + automations notes, firewall
  and guest bullets in Security, retention env note, management API rows for the new endpoints, frontend dev commands,
  codex-lb MIT attribution under License), ARCHITECTURE.md (proxy flow with firewall/key rules, module table, in-memory
  state rows, new "Dashboard (frontend)" section: layout, wire format, SPA serving, auth, contract test),
  CHANGELOG [Unreleased] (Added: dashboard, APIs, RequestLog columns, accounts, API-key rules, reports, firewall, guest,
  automations; Fixed: pause undone by the probe, retention prune, demo `/v1/models` shadowed; Changed: legacy page gone,
  settings reset scope), `docs/subscription-pooling.md` (dashboard pointers), `frontend/README.md` (dev workflow with a
  demo/serve backend on 2456, build committed, tests/mocks/i18n conventions).
- **Hygiene**: `ruff format` on 7 legacy files in a separate `style: ruff format` commit (13+/22− lines). `npm run lint`
  clean.

**Results**
- `ruff check` clean, `ruff format --check` clean (103 files); `pytest` **564 passed** (588 in G2 − 28 tests of the old
  HTML contract file + 2 new contract + 2 guest-privacy tests).
- `npm test` **74 files / 414 tests** pass; `npm run lint` clean; `npm run build` OK (only the inherited >600 kB
  recharts chunk warning).
- `uv build`: wheel has 146 files, 67 under `claude_lb/modules/dashboard/static/`, `static/index.html` present, every
  asset it references present, legacy `index.html` absent; sdist has no `node_modules`.
- **Upgrade path on a copy of the real DB** (`~/.claude-lb/claude-lb.db*` + `secret.key` copied to a scratch dir;
  the original's mtimes unchanged afterwards): before starting, `health_probe_enabled`/`model_sync_enabled` were set to
  `false` in the **copy's** `settings` table so nothing called upstream; served with
  `CLAUDE_LB_DASHBOARD_AUTH_ENABLED=false` on :2461. Startup log: `schema upgraded: added dashboard_sessions.role,
  api_keys.allowed_models_json, api_keys.enforced_model, api_keys.assigned_account_ids_json, request_logs.ttft_ms,
  request_logs.session_key, request_logs.user_agent, request_logs.client_ip, request_logs:ix_request_logs_session_created`;
  new tables `api_key_limit_rules`, `firewall_entries`, `automation_jobs`, `automation_runs` created. 25 GET endpoints
  the pages use all 200. In the browser every page rendered with that data (console-first API key with its $1 cap at
  $0.424, sub-backup Max 5x preserve with 7d 53% used, 11 old request rows with "—" TTFT, 2 keys, catalog) — no schema
  mismatch, no console errors. No proxy traffic sent. Copy trashed.
- **Demo walkthrough** (fresh data dir, :2461): all 10 views (Dashboard, Conversations, Reports, Accounts, APIs,
  Settings, Audit log, Model catalog, Sticky sessions, Automations) in Korean light, Korean dark and English dark at
  1440 px, and Korean dark at 390 px: no raw i18n keys, no Hangul in English, no English UI strings left in Korean
  (only data: model ids, error text from upstream, names), page `scrollWidth` = viewport everywhere (wide tables scroll
  inside their cards), no console errors or warnings. Screenshots in the session scratchpad `screens/`.

**Known issues / not done**
- `docs/dashboard-light.png` / `docs/dashboard-dark.png` (README hero image) still show the **old** dashboard.
- Guests still see firewall entries (networks) and masked credential/key hints; only client IPs are hidden.
- zh-CN covers only the strings that survived from codex-lb (349 keys); everything new falls back to English.
- Inherited from earlier steps: limits and
  conversations are retention-bounded; sticky map / firewall cache / automations scheduler are per process; backend
  error messages are English; recharts chunk > 600 kB; `npm audit` moderate advisories in dev deps not reviewed;
  `claude-lb demo` leaves a `claude-lb-demo-*` dir in `$TMPDIR`.

### 2026-11-27 — Review fixes (security review of the rebuild)
**Done** (regression tests in `tests/test_review_fixes.py`, one class per finding)
1. **[High] Batches bypassed key model policy** — new `claude_lb/modules/proxy/request_models.py`: `inspect()` reads the
   models a request names (top-level `model` for `/v1/messages`, `/count_tokens`, `/v1/complete`; every
   `requests[*].params.model` for `POST /v1/messages/batches`) strictly (UTF-8, no BOM, no duplicate keys via
   `object_pairs_hook`, no `Content-Encoding`); `enforce()` rewrites them all. `admit()` takes `batch_models` and
   `unreadable`: unreadable → 400 for keys with a model policy (allowlist, enforced model or model-filtered rule);
   batch → 403 for keys with any token/cost rule or legacy token/cost budget, every entry checked against the
   allowlist. `_is_proxied` refuses empty/dot path segments. `TestBatchModelPolicy`.
2. **[Medium] Echoed text disabled accounts** — `is_billing_exhausted` needs `invalid_request_error` and a full
   `re.fullmatch` against the two known wordings. `TestBillingDetection` (existing out-of-credit test unchanged).
3. **[Medium-Low] Planned spread runs survived disable/reschedule** — `execute_run` re-checks `job.enabled` (scheduled
   runs; "Run now" on a disabled job still works) and that the account is still targeted; `PATCH` cancels pending runs
   (`skipped`, error `cancelled: …`) on disable, schedule change, or dropped targets (`service.cancel_pending`).
   Deleting a job already deleted its runs. `TestAutomationChanges`.
4. **[Low] Forced runs ignored caps** — `forced_unavailable_reason()` in `forward(force_account=True)` (spend cap, model block,
   breaker-disabled); `execute_run` also skips capped accounts up front. `TestForcedAutomation`.
5. `explain_unavailable` → category counts for clients, per-account detail logged at INFO. `TestUnavailableMessage`;
   `test_unavailable_message_counts_reasons_and_logs_the_details` updated.
6. `clip_error()` for `AutomationRun.error` (512); per-job `try` in planning, `ZoneInfoNotFoundError` caught, one
   crashing run cannot sink `gather`. `TestAutomationRobustness`.
7. Firewall cache invalidated from `after_commit`/`after_rollback` session events. `TestFirewallCache`.
8. Guests: firewall entries `network: "hidden"`, note and own IP blank; firewall-entry audit events masked and not
   searchable by target/detail. `TestGuestFirewallPrivacy`.
9. `limits.model_base()` strips `-YYYYMMDD`/`-latest`; `model_matches` and the SQL condition compare on the base.
   `TestModelAliases`.

**Results**: 36 of the 43 new tests fail on the pre-fix tree (the other 7 guard behaviour that must stay); all pass
after. `ruff check`/`ruff format --check` clean; `pytest` **607 passed**. Frontend untouched (guests see the literal
`hidden` in the network column).

**Known issues / not done**
- The allowlist now also uses alias/snapshot matching, so an entry `claude-opus-4-1-20250805` admits any
  `claude-opus-4-1-*` id — same family, but broader than an exact snapshot pin.
- A batch's later usage is still not metered for request-count-only keys (one batch = one request).

### 2026-11-26 — Postgres verification
**Done**: full suite against PostgreSQL 16.15 (Docker `postgres:16`, `postgresql+asyncpg`, same URL form as CI).
No application SQL needed changes — the dashboard buckets (`extract(epoch)`/`floor`), the request-log options
`GROUP BY` on labels, report `count(distinct)`, conversations, API-key limit-rule alias matching, automations
(unique slot keys + savepoints), firewall and schema reconcile all pass on Postgres. Two test-only failures fixed:
- `TestSchemaUpgrade` inserted `0` into a `BOOLEAN` column with raw SQL (Postgres refuses it) — now `false`.
- `test_add_subscription_cli_logs_in_verifies_and_stores`: the autouse `fresh_database` fixture left a pooled asyncpg
  connection bound to its event loop, and the CLI's own `asyncio.run()` reused it ("attached to a different loop";
  aiosqlite is not loop-bound, so SQLite hid it). The fixture now disposes the pool after creating the schema.

Upgrade path: pre-change code (`057f09d^`) created and seeded a Postgres DB; HEAD on the same DB added the new columns
(NOT NULL ones with defaults back-filled, e.g. `routing_policy='normal'`, `plan_type='api'`, `role='admin'`,
`model_blocks_json='{}'`), the new tables (limit rules, automations, firewall, quota history) and the session index;
every dashboard/reports/logs/keys/automations/firewall endpoint returned 200 with the old rows; a second start was a
no-op. **Results**: Postgres 607 passed (twice, no flakes); SQLite 607 passed; ruff clean.

### 아침 요약 (Morning summary)
**만든 것** — 예전 단일 HTML 대시보드를 codex-lb 기반 React 대시보드로 완전히 교체했습니다(A–H, 커밋 13개, push 안 함).
- 페이지: 대시보드(지표·추이·5h/7d 용량 도넛·주간 속도·API 키 지출·계정 카드·모델별 사용량·요청 로그/대화 보기),
  리포트(기간·필터·이전 기간 비교·CSV), 계정(일시 중지/점검/이름 변경/한도·정책·지출 한도/모델 경로 재시도/추이),
  API(키 규칙: 허용 모델·강제 모델·배정 계정·여러 사용량 한도, 재발급, 추이), 설정(라우팅·백그라운드 작업·보존 기간·
  비밀번호·TOTP·게스트·IP 방화벽), 고급 메뉴의 감사 로그·모델 카탈로그·세션 고정·자동화(예약 프롬프트).
- 백엔드: 새 API 다수, RequestLog 컬럼(ttft/session/UA/IP), API 키 규칙, 방화벽, 게스트(읽기 전용, IP 숨김), 자동화.
- 덤으로 잡은 버그: 일시 중지가 헬스 프로브에 의해 풀리던 문제, 보존 기간 정리가 대시보드 설정을 무시하던 문제,
  데모의 `/v1/models`가 대시보드 HTML에 가려지던 문제.

**실행 방법**
- 그대로 쓰기: `uv run claude-lb serve` → http://127.0.0.1:2456 (빌드 결과물이 커밋돼 있어 Node 불필요).
- 둘러보기: `CLAUDE_LB_DATA_DIR=$(mktemp -d) uv run claude-lb demo --port 2461`.
- 프론트 개발: 백엔드를 2456에 띄우고 `cd frontend && npm ci && npm run dev` (5173). 수정 후 `npm run build` 결과를 커밋.
- 실제 DB 사본으로 업그레이드 확인 완료: 시작 시 스키마가 자동으로 추가되고 모든 페이지가 기존 데이터로 정상 표시.

**알아둘 한계**
- README 상단 스크린샷(docs/dashboard-*.png)은 아직 예전 대시보드 — 새 스크린샷으로 바꿔야 합니다.
- 중국어(zh-CN)는 일부만 번역(나머지는 영어로 표시). 서버 오류 메시지는 영어.
- 일부 수치(한도·대화)는 요청 로그 보존 기간에 묶임, 세션 고정·방화벽 캐시·자동화 스케줄러는
  프로세스별(워커 1개 권장).

**다음 단계 제안**
1. 새 스크린샷으로 README 이미지 교체 → 릴리스(0.7.0) 준비.
2. ~~Postgres로 통합 테스트 한 번~~ — 완료(Log의 "Postgres verification" 참고).
3. 게스트에게 방화벽 항목도 숨길지 결정, 백엔드 오류 메시지 i18n(오류 코드 반환) 검토.
4. recharts 청크 분리, `npm audit` 정리.

