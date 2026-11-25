# Architecture

claude-lb is one FastAPI process with two planes:

- the **proxy plane** (`/v1/*`), which clients call with `clb_` keys
- the **management plane** (`/api/*` and the dashboard), which an operator uses after signing in

They share a database (SQLite by default, Postgres optional) and nothing else.

## Request flow (proxy plane)

```
client ──► /v1/messages
            │
            ├─ dependencies.require_api_key     auth + budget check on a short DB session;
            │                                   reserves an in-flight slot (api_keys/service.py)
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
| `modules/api_keys/` | `clb_` keys, rolling-window budgets, in-flight slots |
| `modules/health/` | Background probes that re-enable recovered accounts, and the model catalog |
| `modules/usage/` | Summaries, daily rollups, cost reports, Prometheus `/metrics` |
| `modules/auth/` | Dashboard password + TOTP, sessions, the bootstrap window, login throttle |
| `modules/settings/` | Runtime settings, changeable without a restart |
| `modules/audit/` | Append-only log of management actions |
| `modules/dashboard/index.html` | The whole UI: one file, no build step |

## State that lives in memory

Each item below is per process. With more than one worker, each one holds its own copy:

| State | Effect of several workers |
|---|---|
| Sticky affinity map | Rendezvous hashing keeps routing consistent anyway |
| Budget in-flight slots | Each worker enforces the request cap on its own share |
| OAuth refresh single-flight | Workers can refresh the same account concurrently |
| Login throttle | Counted per worker |
| Bootstrap token | Differs per worker |

Run a single worker unless you have a reason not to. One async worker handles a lot of proxy traffic.

## Design rules

- **Fail open for routing, closed for auth.** An unknown model catalog keeps an account in rotation.
  An unreadable credential row means "sign in", never "unprotected".
- **Counters are SQL increments.** A read-modify-write in Python loses updates on Postgres.
- **Never forward claude-lb's own credentials** (client keys, the session cookie) upstream.
- **Additive schema only.** New columns need a default or must be nullable. Anything else needs a
  real migration.
