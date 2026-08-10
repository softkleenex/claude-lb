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
| **Automatic failover** | 429/5xx/transport errors retry on the next account; 401/403 disables the key |
| **Scoped client keys** | Issue `clb_…` keys with per-window request, token, and USD budgets |
| **Usage + cost tracking** | Per request, account, model, and key — including cache-read/write pricing |
| **Streaming passthrough** | SSE bytes are relayed unmodified; usage is sniffed out of the stream |
| **Dashboard** | Single-page, no build step, light/dark |

## Quick start

```bash
uv tool install claude-lb          # or: pipx install claude-lb

claude-lb account add work         # prompts for the Anthropic key
claude-lb key create my-laptop     # prints a clb_… key once
claude-lb serve
```

Open <http://127.0.0.1:2456> for the dashboard.

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

Set with `CLAUDE_LB_ROUTING_STRATEGY`.

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

### Failure handling

| Upstream result | Action |
|---|---|
| `429` | Cool down until `retry-after` (or the reset header), then retry the next account |
| `500` / `502` / `503` / `504` / `529` / `408` | Retry the next account; back off after 3 consecutive failures |
| Transport error | Same as 5xx |
| `401` / `403` | Disable the account and record the reason — retrying a revoked key just burns requests |
| Other `4xx` | Relayed to the caller verbatim, no retry (it's the request's fault, not the key's) |

`CLAUDE_LB_MAX_ATTEMPTS` (default `3`) caps how many accounts one client request may burn.

## Configuration

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
- **The management API and dashboard are unauthenticated.** They are reachable by anyone
  who can reach the port, and they can add, disable, and delete accounts. Keep the default
  `127.0.0.1` bind, or put the instance behind a reverse proxy that handles auth before
  exposing it. Dashboard auth is not implemented in v0.1.
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
| `GET` | `/health` | Liveness |

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
