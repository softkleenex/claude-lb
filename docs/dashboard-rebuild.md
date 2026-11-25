# Dashboard rebuild (React) — plan & progress

Goal: replace the single-file vanilla dashboard (`claude_lb/modules/dashboard/index.html`)
with a React app whose features are a **superset of codex-lb's dashboard** plus everything
claude-lb already had (audit log, cache savings, grouped cost report + CSV, model catalog,
spend caps, subscription 5h/7d quota, per-model refusals).

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
- [ ] C. Accounts page (+ backend: pause/resume, per-account probe, trends from QuotaHistory, rename)
- [ ] D. Dashboard overview + request logs + request details (+ backend: overview/deltas/sparklines, log filters/pagination/options)
- [ ] E. Reports page (+ backend: date range, multi-filters, TTFT/TPS)
- [ ] F. API keys page (+ backend: regenerate, expiry, allowed models, multi-rule limits, trends)
- [ ] G. Extras: conversations, audit log page, model catalog page, firewall, sticky sessions browser, data retention, guest role
- [ ] H. Remove old index.html, docs/README/CHANGELOG, final full verification

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

