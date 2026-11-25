# Architecture

claude-lb is one FastAPI process with two planes:

- the **proxy plane** (`/v1/*`), which clients call with `clb_` keys
- the **management plane** (`/api/*` and the dashboard), which an operator uses after signing in

They share a database (SQLite by default, Postgres optional) and nothing else.

## Request flow (proxy plane)

```
client ──► /v1/messages
            │
            ├─ firewall.enforce_firewall        IP allowlist (proxy only), cached 5 s
            ├─ dependencies.require_api_key     key auth, model allowlist / enforced model, limit
            │                                   rules; reserves an in-flight slot (api_keys/)
            ├─ proxy/api.py                     404s unknown /v1 paths
            └─ proxy/service.py: forward()
                 │  for attempt in 1..max_attempts:
                 ├─ load accounts, drop those the model catalog rules out   (health/service.py)
                 ├─ sticky.resolve()             prompt-cache affinity on attempt 1  (proxy/sticky.py)
                 ├─ load_balancer.select_account()   strategy over rate-limit headroom
                 ├─ credentials.resolve()        x-api-key or bearer, refreshing OAuth if due
                 ├─ send upstream (stream=True)
                 │    429 / 5xx / transport  → record failure, cool down, next account
                 │    401                    → one forced OAuth refresh, else disable
                 │    403                    → next account, nothing disabled
                 │    2xx / other 4xx        → return to the client
                 └─ record_request()         log row + atomic counters + daily rollup
```

Streams are relayed byte for byte. `wrap_stream_for_accounting` reads usage out of the SSE events
as they pass and writes the log in a shielded task once the stream ends. "Ends" includes the client
hanging up, which arrives as a cancellation.

## Modules

| Path | Responsibility |
|---|---|
| `claude_lb/main.py` | App factory, lifespan (DB init, scheduler), cross-site write guard, error envelopes |
| `claude_lb/cli.py` | `claude-lb` command (Typer) |
| `claude_lb/core/pricing.py` | Price table and cost/savings math. **Update when Anthropic changes prices** |
| `claude_lb/core/crypto.py` | Fernet encryption at rest, `clb_` key hashing |
| `claude_lb/db/schema.py` | Additive schema reconcile on startup (new columns, int→bigint on Postgres) |
| `modules/proxy/` | Forwarding, failover, stickiness, subscription quota/depletion, usage parsing |
| `modules/accounts/` | Upstream accounts, OAuth refresh, browser login (PKCE), credential bundle import |
| `modules/api_keys/` | `clb_` keys, limit rules (`limits.py`), model allowlist, assigned accounts, in-flight slots |
| `modules/health/` | Background probes that re-enable recovered accounts, and the model catalog |
| `modules/usage/` | Summaries, daily rollups, cost reports, Prometheus `/metrics` |
| `modules/auth/` | Dashboard password + TOTP, sessions (admin / read-only guest), the bootstrap window, login throttle |
| `modules/settings/` | Runtime settings, changeable without a restart |
| `modules/audit/` | Append-only log of management actions, paged/filtered for the Audit page |
| `modules/dashboard/` | SPA serving (`api.py`), overview / projections / weekly pace (`data_api.py`, `overview.py`, `pace.py`) |
| `modules/request_logs/` | Paged request log, filter options, request detail, conversations (grouped by `session_key`) |
| `modules/reports/` | Date-range report for the Reports page (rollups + request-log medians) |
| `modules/sticky_sessions/` | Browse / delete the in-memory sticky map |
| `modules/firewall/` | Proxy IP allowlist (`firewall_entries`, mode in `settings`) |
| `modules/automations/` | Scheduled per-account prompts: schedule math, per-minute scheduler, idempotent runs |
| `frontend/` | Dashboard source (React); built into `modules/dashboard/static/` |

## State that lives in memory

Each item below is per process. With more than one worker, each one holds its own copy:

| State | Effect of several workers |
|---|---|
| Sticky affinity map | Rendezvous hashing keeps routing consistent anyway |
| Budget in-flight slots | Each worker enforces the request cap on its own share |
| OAuth refresh single-flight | Workers can refresh the same account concurrently |
| Login throttle | Counted per worker |
| Bootstrap token | Differs per worker |
| Firewall decision cache | Up to 5 s stale on the other workers after a change |
| Automations scheduler | Every worker plans; the unique `slot_key` lets only one send each run |

Run a single worker unless you have a reason not to. One async worker handles a lot of proxy traffic.

## Dashboard (frontend)

`frontend/` is a React 19 + Vite + TypeScript app (Tailwind, Radix/shadcn components, React
Query, zustand, i18next, recharts), derived from the codex-lb frontend (MIT, see
`frontend/LICENSE`).

```
frontend/src/
  App.tsx                 routes; every page is a lazy chunk
  components/layout/      header (nav + Advanced menu), status bar, auth gate banners
  components/ui/          shadcn/Radix primitives
  features/<area>/        api.ts (calls), schemas.ts (zod), hooks/, components/
                          accounts, api-keys, apis, audit, auth, automations, dashboard,
                          firewall, health, model-catalog, reports, settings, sticky-sessions
  lib/api-client.ts       fetch wrapper: snake_case <-> camelCase, zod validation, 401 handling
  i18n/locales/           en.json, ko.json, zh-CN.json (flat dotted keys)
  test/mocks/             MSW handlers + wire factories mirroring the FastAPI responses
```

- **Wire format.** The backend speaks snake_case. `api-client.ts` camelizes response keys before
  zod validation and snakifies request bodies and query keys (`rawKeys: true` opts out where keys
  are data). A response that does not match its schema fails loudly as "Response schema mismatch".
- **Serving.** `npm run build` writes `claude_lb/modules/dashboard/static/`, which is committed, so
  the wheel and Docker image need no Node. `modules/dashboard/api.py` serves real files from there
  (`/assets/*` hashed and cached for a year, a missing asset is a 404), and answers every other
  GET with `index.html` (`no-cache`) so client-side routes survive a reload. Paths whose first
  segment is `api`, `v1`, `health`, `metrics`, `docs`, `redoc` or `openapi.json` are excluded by
  the route class itself, so they keep their normal 404/405. The dashboard router is registered
  last. Without a build, `/` answers 503 with the build command.
- **Auth.** The SPA reads `/api/auth/status` and renders the gate (first-run setup, sign-in with
  optional TOTP, guest sign-in); any 401 returns it to the gate. Guests get a read-only UI, and
  the backend enforces it (`require_management_auth` refuses non-GET for a guest session).
- **Contract.** `tests/test_dashboard_contract.py` checks that every `/api/...` path in the
  frontend source is routed and that the committed build is complete; field shapes are guarded by
  the zod schemas and the MSW mocks.

## Design rules

- **Fail open for routing, closed for auth.** An unknown model catalog keeps an account in rotation.
  An unreadable credential row means "sign in", never "unprotected".
- **Counters are SQL increments.** A read-modify-write in Python loses updates on Postgres.
- **Never forward claude-lb's own credentials** (client keys, the session cookie) upstream.
- **Additive schema only.** New columns need a default or must be nullable. Anything else needs a
  real migration.
