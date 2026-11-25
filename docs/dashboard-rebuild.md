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
- [ ] B. Auth gate + shell (nav, status bar, theme, i18n ko/en, privacy blur) + Settings page
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

