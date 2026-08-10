# claude-lb

Load balancer and proxy for **Anthropic API keys**. Pool multiple keys, route around rate
limits, track spend per key and per model, and hand out scoped keys to your own clients —
all behind one Anthropic-compatible endpoint.

Inspired by [codex-lb](https://github.com/Soju06/codex-lb), rebuilt for the Anthropic API.

> **Scope note.** claude-lb pools **API keys** (`sk-ant-…`) issued from the Anthropic
> Console. It deliberately does **not** pool Claude Pro/Max *subscription* accounts:
> multiplexing consumer subscriptions to get past per-account limits runs against
> Anthropic's consumer terms, and it would require reverse-engineering an undocumented
> OAuth client. The `provider` column on `accounts` leaves room for other credential
> types, but nothing in this repo implements subscription pooling.

## Features

| | |
|---|---|
| **Key pooling** | Route across many Anthropic keys — separate workspaces, orgs, or billing buckets |
| **Rate-limit aware** | Reads `anthropic-ratelimit-*` response headers and steers traffic toward headroom |
| **Prompt-cache affinity** | Pins a conversation to one account so its cache stays warm (0.1x reads, not 1.25x writes) |
| **Automatic failover** | 429/5xx/transport errors retry on the next account; 401/403 disables the key |
| **Self-healing** | Background probes return recovered accounts to rotation without operator action |
| **Model-aware routing** | Skips accounts whose org cannot serve the requested model |
| **Live configuration** | Change strategy, stickiness, and probe intervals from the dashboard — no restart |
| **Dashboard auth** | Password + optional TOTP, with a loopback/bootstrap-token first run |
| **Scoped client keys** | Issue `clb_…` keys with per-window request, token, and USD budgets |
| **Usage + cost tracking** | Per request, account, model, and key — including cache-read/write pricing |
| **Trends that outlive logs** | Daily rollups keep a 28-day chart even with short log retention |
| **Prometheus metrics** | `/metrics` exposes per-account health, headroom, tokens, and spend |
| **Audit log** | Append-only record of every management change and sign-in |
| **Streaming passthrough** | SSE bytes are relayed unmodified; usage is sniffed out of the stream |
| **Dashboard** | Single page, no build step, light/dark |

## Quick start

```bash
uv tool install claude-lb          # or: pipx install claude-lb

claude-lb account add work         # prompts for the Anthropic key
claude-lb key create my-laptop     # prints a clb_… key once
claude-lb serve
```

Open <http://127.0.0.1:2456> and set a dashboard password when prompted.

Reaching the dashboard from another machine on the first run? There is no password
yet, so the management plane is loopback-only — paste the one-time bootstrap token
printed in the server log into the setup form. It rotates on every restart and stops
working the moment a password is set.

### Docker

```bash
docker volume create claude-lb-data
docker run -d --name claude-lb \
  -p 2456:2456 \
  -v claude-lb-data:/var/lib/claude-lb \
  ghcr.io/softkleenex/claude-lb:latest
```

## Client setup

claude-lb speaks the Anthropic API, so point any client's base URL at it and use the
`clb_…` key in place of your Anthropic key.

**Python SDK**

```python
from anthropic import Anthropic

client = Anthropic(base_url="http://127.0.0.1:2456", api_key="clb_...")
client.messages.create(
    model="claude-opus-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)
```

**TypeScript SDK**

```typescript
const client = new Anthropic({ baseURL: "http://127.0.0.1:2456", apiKey: "clb_..." });
```

**Claude Code / Agent SDK**

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:2456
export ANTHROPIC_API_KEY=clb_...
```

**curl**

```bash
curl http://127.0.0.1:2456/v1/messages \
  -H "x-api-key: clb_..." \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-opus-5","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'
```

Every response carries `x-claude-lb-account`, naming the upstream account that served it.

## Routing strategies

Change live in the dashboard, or set the default with `CLAUDE_LB_ROUTING_STRATEGY`.

| Strategy | Behavior | Use when |
|---|---|---|
| `capacity_weighted` *(default)* | Weighted random over remaining rate-limit headroom × account weight | Mixed pools; smooths load without hard-pinning |
| `round_robin` | Even rotation | Keys with identical limits |
| `least_used` | Fewest lifetime requests | Warming a new key into the pool |
| `fill_first` | Drains the highest-`priority` account before moving on | A cheap/committed-spend key you want consumed first |
| `single_account` | Always the highest-priority enabled account | Debugging, or isolating one key |

Headroom comes from the `anthropic-ratelimit-*` headers on the previous response. An
account never called returns full headroom, so a fresh pool spreads out rather than
piling onto whichever key sorts first.

### Prompt-cache affinity

Anthropic prompt caches are scoped to the credential that created them, so spreading
one conversation across the pool throws the cache away on every turn — each account
pays the ~1.25x cache-write premium instead of the 0.1x read. claude-lb keys each
request on its *cacheable prefix* (`system` + `tools` + the first user turn), which is
exactly the part Anthropic hashes and exactly the part that stays byte-identical as a
conversation grows, and pins that key to one account.

No client-side session id is needed: turn 20 of a conversation hashes like turn 1.
Cold start and extra workers fall back to rendezvous hashing, so the mapping is stable
without shared state and only ~1/N conversations move when the pool changes.

Affinity is a soft hint. It outranks the routing strategy, but yields to a pinned API
key, to `single_account`, and to any failure. Turn it off with
`sticky_sessions_enabled` if you would rather have perfectly even load.

### Failure handling

| Upstream result | Action |
|---|---|
| `429` | Cool down until `retry-after` (or the reset header), then retry the next account |
| `500` / `502` / `503` / `504` / `529` / `408` | Retry the next account; back off after 3 consecutive failures |
| Transport error | Same as 5xx |
| `401` / `403` | Disable the account and record the reason — retrying a revoked key just burns requests |
| Other `4xx` | Relayed to the caller verbatim, no retry (it's the request's fault, not the key's) |

`max_attempts` (default `3`) caps how many accounts one client request may burn.

A background probe re-checks disabled and past-cooldown accounts against
`GET /v1/models` — authenticated, no token cost — and returns them to rotation on
their own when the credential starts working again. The same call doubles as the
account's model catalog, which routing uses to skip accounts whose org cannot serve
the requested model. An unsynced catalog never blackholes traffic: it falls back to
the whole pool.

## Configuration

Most routing knobs are **runtime settings**: change them in the dashboard (or via
`PATCH /api/settings`) and they apply to the next request, no restart. Environment
variables set the defaults.

| Runtime setting | Default | |
|---|---|---|
| `routing_strategy` | `capacity_weighted` | See the table above |
| `max_attempts` | `3` | Accounts tried per client request |
| `sticky_sessions_enabled` | `true` | Prompt-cache affinity |
| `sticky_ttl_seconds` | `900` | How long a conversation stays pinned |
| `health_probe_enabled` / `_interval_seconds` | `true` / `120` | Auto-recovery probe |
| `model_sync_enabled` / `_interval_seconds` | `true` / `3600` | Model catalog refresh |
| `request_log_retention_days` | `30` | Rollups are kept regardless |

Environment variables use the `CLAUDE_LB_` prefix; `.env` and `.env.local` are read too.

| Variable | Default | Notes |
|---|---|---|
| `CLAUDE_LB_HOST` | `127.0.0.1` | Set `0.0.0.0` to expose it — see the security note below |
| `CLAUDE_LB_PORT` | `2456` | |
| `CLAUDE_LB_DATA_DIR` | `~/.claude-lb` | `/var/lib/claude-lb` in Docker |
| `CLAUDE_LB_DATABASE_URL` | SQLite in the data dir | `postgresql+asyncpg://…` for Postgres |
| `CLAUDE_LB_ROUTING_STRATEGY` | `capacity_weighted` | See above |
| `CLAUDE_LB_MAX_ATTEMPTS` | `3` | Accounts tried per client request |
| `CLAUDE_LB_REQUIRE_API_KEY` | `true` | Set `false` only for a loopback-only dev instance |
| `CLAUDE_LB_DASHBOARD_AUTH_ENABLED` | `true` | Set `false` only behind a proxy that authenticates for it |
| `CLAUDE_LB_UPSTREAM_BASE_URL` | `https://api.anthropic.com` | Per-account override also available |
| `CLAUDE_LB_SECRET_KEY` | generated | Fernet key for credentials at rest; see below |
| `CLAUDE_LB_REQUEST_LOG_RETENTION_DAYS` | `30` | Pruned at startup |
| `CLAUDE_LB_DASHBOARD_ENABLED` | `true` | |
| `CLAUDE_LB_LOG_LEVEL` | `INFO` | |

## Security

- **Upstream keys are encrypted at rest** with Fernet. The key lives at
  `$CLAUDE_LB_DATA_DIR/secret.key` (mode `0600`) unless you supply `CLAUDE_LB_SECRET_KEY`.
  Back up the data directory *and* that file together — moving the database without the
  secret makes every stored credential unrecoverable.
- **Client keys are stored hashed** (SHA-256). The plaintext is shown once at creation.
- **The management plane requires an operator session.** Password (scrypt) plus
  optional TOTP; sessions are stored server-side so they can be revoked, and rotating
  the password ends every existing one. A fresh install has no password, so the
  management plane is reachable from loopback only until you set one — or from
  elsewhere with the one-time bootstrap token printed at startup.
- **Proxy routes are separate.** API clients authenticate with `clb_` keys and are
  unaffected by dashboard sessions. `/health` and `/metrics` stay open so probes and
  scrapers work without a cookie; `/metrics` exposes account *names* and aggregate
  counters, never credentials.
- **The audit log records the fact of a change, never the secret** — names, ids, and
  masked hints only.
- Unknown `/v1/...` paths return 404 rather than being blindly relayed, so a typo in a
  client base URL fails loudly instead of leaking a request upstream.

## Data

| Environment | Path |
|---|---|
| Local | `~/.claude-lb/` |
| Docker | `/var/lib/claude-lb/` |

Contains `claude-lb.db` (SQLite) and `secret.key`. Back up both.

## CLI

```
claude-lb serve                    Start the proxy and dashboard
claude-lb config                   Show the resolved configuration
claude-lb account add <name>       Add an upstream Anthropic key
claude-lb account list             Show accounts, health, and spend
claude-lb account remove <name>    Remove an account (history is kept)
claude-lb key create <name>        Issue a client key
claude-lb key list                 List issued keys
```

## Management API

| Method | Path | |
|---|---|---|
| `GET` / `POST` | `/api/accounts` | List / add upstream accounts |
| `PATCH` / `DELETE` | `/api/accounts/{id}` | Update (incl. re-enable) / remove |
| `GET` / `POST` | `/api/keys` | List / issue client keys |
| `PATCH` / `DELETE` | `/api/keys/{id}` | Enable-disable / remove |
| `GET` | `/api/usage/summary?window_hours=24` | Totals, by account, by model |
| `GET` | `/api/usage/requests?limit=100` | Recent request log |
| `GET` | `/api/usage/trend?days=28` | Daily rollups, zero-filled |
| `POST` | `/api/usage/rollups/backfill` | Rebuild rollups from surviving logs |
| `GET` / `PATCH` | `/api/settings` | Read / change runtime configuration |
| `POST` | `/api/settings/reset` | Discard overrides |
| `POST` | `/api/health/probe` | Probe unhealthy accounts now |
| `POST` | `/api/health/sync-models` | Refresh the model catalog now |
| `GET` | `/api/health/models` | Merged model catalog |
| `GET` | `/api/audit` | Management audit log |
| `POST` | `/api/auth/login` · `/logout` · `/password` | Session management |
| `POST` | `/api/auth/totp/enroll` · `/confirm` | TOTP setup |
| `GET` | `/health` | Liveness (open) |
| `GET` | `/metrics` | Prometheus scrape (open) |

OpenAPI docs at `/docs`.

## Development

```bash
uv sync
uv run pytest
uv run ruff check .
uv run claude-lb serve --reload
```

## License

MIT
