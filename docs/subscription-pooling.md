# Subscription Pooling

`claude-lb` supports multi-model pooling for **Claude subscription accounts** (Pro, Max 5x, Max 20x, Team, Enterprise) alongside standard Console API keys in a single unified pool — modeled after [`codex-lb`](https://github.com/Soju06/codex-lb).

Subscription accounts use Claude Code as their native execution backend. Console API
keys use direct HTTP, and both transports participate in the same routing strategies,
quota accounting, sticky sessions, and failover.

---

## 1. Dual-Window Quota Tracking (`5h` + `7d`)

Subscription accounts do not use per-minute RPM/TPM limits alone; Anthropic reports rolling **5-hour (primary)** and **7-day (secondary)** utilization via `anthropic-ratelimit-unified-*` response headers:

| Header | Mapped field | Meaning |
|---|---|---|
| `anthropic-ratelimit-unified-5h-utilization` | `primary_used_percent` | 5-hour window usage (`0–100%`) |
| `anthropic-ratelimit-unified-5h-reset` | `primary_reset_at` | When the 5-hour window resets |
| `anthropic-ratelimit-unified-7d-utilization` | `secondary_used_percent` | 7-day window usage (`0–100%`) |
| `anthropic-ratelimit-unified-7d-reset` | `secondary_reset_at` | When the 7-day window resets |
| `anthropic-ratelimit-unified-status` | `unified_status` | `allowed`, `allowed_warning`, or `rejected` |
| `anthropic-ratelimit-unified-overage-status` | `overage_status` | `allowed` overrides hard quota blocks when extra usage is enabled |

### Quota Status & Auto-Recovery

- **`active`**: Account is eligible for routing.
- **`rate_limited`**: 5-hour window reached `100%` (or `rejected`), cooling down until `primary_reset_at`.
- **`quota_exceeded`**: 7-day window reached `100%`, cooling down until `secondary_reset_at`.
- **Automatic recovery**: Once `primary_reset_at` or `secondary_reset_at` passes, `is_available()` and the background health scheduler automatically return the account to rotation without manual intervention.
- **Manual reset**: `POST /api/accounts/{id}/reset-quota` (dashboard: Accounts → account → *Reset quota state*) clears stored quota blocks immediately.

---

## 2. Plan Tiers & Capacity Credits

Each account has a `plan_type` (and optional `capacity_credits` override) used by `capacity_weighted` and `relative_availability`:

| `plan_type` | Default `capacity_credits` | Typical tier |
|---|---:|---|
| `free` | `10` | Free tier |
| `pro` | `100` | Claude Pro |
| `api` | `100` | Anthropic Console API key |
| `team` | `150` | Claude Team |
| `enterprise` | `300` | Claude Enterprise |
| `max` / `max_5x` | `500` | Claude Max 5x |
| `max_20x` | `2000` | Claude Max 20x |

---

## 3. Routing Strategies & Policies

### Subscription-Aware Strategies

Change live in the dashboard or via `PATCH /api/settings`:

- **`relative_availability`** *(recommended for mixed subscription pools)*: Scores each account by `remaining_secondary_credits / max(seconds_until_reset, 300s)`, normalizes against the top account, raises to `power=2.0`, and samples from the top-5 candidates. Accounts with more remaining quota and sooner resets receive proportionally more traffic.
- **`usage_weighted`**: Always selects the account with the lowest 7-day utilization (breaking ties by 5-hour utilization, then least-recently-used).
- **`reset_drain`**: Drains accounts whose active quota window resets soonest, avoiding wasted expiring quota.
- **`sequential_drain`**: Drains one account (ordered by `priority`, `name`) until headroom drops below 5% before moving to the next.
- **`capacity_weighted`** *(default)*: Weighted random over `weight × (capacity_credits / 100) × headroom`.

### Per-Account `routing_policy`

Every account can be assigned a `routing_policy` (changeable live in the dashboard or via `PATCH /api/accounts/{id}`):

1. **`burn_first`**: Always preferred first while available (ideal for expiring subscriptions or high-capacity Max accounts you want to utilize first).
2. **`normal`**: Standard pool tier, used once `burn_first` accounts are unavailable or exhausted.
3. **`preserve`**: Held in reserve and used only when all `burn_first` and `normal` accounts are unavailable.

---

## 4. EWMA Depletion Risk & Pacing

Every proxied response containing `anthropic-ratelimit-unified-*` headers records a snapshot in `quota_history`. `claude-lb` computes an exponentially weighted moving average (EWMA, `α = 0.4`) burn rate per window and projects whether the account will exhaust its quota before `reset_at`:

- `safe` (`risk < 0.60`)
- `warning` (`0.60 ≤ risk < 0.80`)
- `danger` (`0.80 ≤ risk < 0.95`)
- `critical` (`risk ≥ 0.95`)

---

## 5. Adding & Importing Subscription Accounts

### Import from a local JSON file (CLI)

Supports both Claude Code's `claudeAiOauth` format (`~/.claude/.credentials.json`) and generic OAuth JSON bundles:

```bash
claude-lb account import my-max \
  --file ~/.claude/.credentials.json \
  --routing-policy burn_first \
  --transport claude_code
```

### Add manually with OAuth tokens (CLI)

```bash
claude-lb account add-oauth my-pro \
  --access-token "$ACCESS_TOKEN" \
  --refresh-token "$REFRESH_TOKEN" \
  --token-endpoint "https://issuer.example.com/oauth/token" \
  --client-id "$CLIENT_ID" \
  --plan-type pro \
  --routing-policy normal
```

### Import via HTTP API

```bash
curl -X POST http://127.0.0.1:2456/api/accounts/import \
  -H "content-type: application/json" \
  -d '{
    "name": "team-max-20x",
    "plan_type": "max_20x",
    "routing_policy": "burn_first",
    "transport": "claude_code",
    "credentials": { ... }
  }'
```

---

## 6. Observability

- **Pool Quota Summary**: `GET /api/usage/quota` returns pool-wide `total_capacity_credits`, `remaining_capacity_credits`, `pool_remaining_percent`, and per-account 5h/7d utilization, reset timestamps, and `depletion_risk` / `risk_level`.
- **Account Quota History**: `GET /api/usage/quota/{account_id}/history?days=7` returns time-series snapshots for an account.
- **Prometheus `/metrics`**:
  - `claude_lb_account_primary_used_percent`
  - `claude_lb_account_secondary_used_percent`
  - `claude_lb_account_capacity_credits`
- **Dashboard**:
  - *Dashboard* page: 5h / 7d capacity donuts over the enabled subscription accounts (one segment per account, remaining in the centre, a safe-pace tick, risk badge, burn rate and projected run-out), a weekly pace forecast (`GET /api/dashboard/projections`), and API-key spend against caps.
  - *Accounts* page: plan / policy / depletion-risk badges, 5h / 7d bars with absolute reset times and countdowns, unified / overage status, an hourly 5h / 7d chart from `QuotaHistory`, learned model availability with *Try again*, spend-cap progress, and the plan / policy / weight / priority / cap editors.
  - *Automations* page (Advanced): schedule a tiny prompt per account, e.g. weekdays 07:00 in your timezone, so a 5-hour window starts before you do.

## Spend-capped API key in front of subscriptions

A Console API key drains first, but only up to a small budget, then traffic moves to
subscriptions.

```bash
claude-lb account add console-first --plan-type api --routing-policy burn_first --spend-cap-usd 1
claude-lb account set-spend-cap console-first 2    # raise later; omit the amount to remove
```

- The cap compares against claude-lb's **estimated** lifetime spend (`total_cost_usd`), so
  concurrent in-flight requests can overshoot it slightly. Set a spend limit in the
  Anthropic Console too, as the authoritative backstop.
- If the Console runs out of credit anyway, the `400 credit balance is too low` reply
  disables the account and the request fails over. Re-enable it after topping up.
- A capped account is not disabled; raising the cap puts it straight back in rotation.
- In the dashboard: Accounts → *Add account* → API key, then set the plan, policy and spend cap
  on the account's settings card. The Dashboard page's *API key spend* card shows spend vs cap.

## Adding a subscription account

```bash
claude-lb account add-subscription alice --plan-type max_5x --transport claude_code
```

A browser opens; log in with the account to add (paste the code back if the terminal
asks). claude-lb runs Claude Code's own `claude setup-token` in a throwaway config
directory, so the Claude Code login you are using right now is not touched. It then
sends a tiny quota probe and prints the probe model plus current 5h/7d usage. The stored
account then runs `/v1/messages` through an isolated Claude Code profile, using the
model named by each client request. Override the quota-probe order by repeating
`--verify-model MODEL`.
Requires Claude Code (`claude`) on `PATH`.

The dashboard (Accounts → *Add account* → Subscription) shows the exact command for the plan
and policy you pick, and also accepts a pasted `sk-ant-oat…` token or a credential file.

For an account that was added by an older release, switch it in place:

```bash
claude-lb account set-transport alice claude_code
```

## Multi-model availability

claude-lb forwards every requested model to the selected account's native Claude Code
backend and combines model sync with live results to maintain an account-specific
availability map. If a route is temporarily unavailable:

- The account stays active for every other model it serves.
- That model is routed to another eligible account for 12 hours, then tried again.
- `claude-lb account list` shows the temporary reroute and its destination policy.
- The dashboard shows it under *Model availability*; *Try again* clears it early
  (`DELETE /api/accounts/{id}/model-blocks?model=…`).

Direct subscription accounts and API-key accounts coexist, so the pool keeps serving
the requested model as each account's availability changes.

### Messages compatibility

- Text, system prompts, assistant turns, client tool definitions, `tool_use`, and
  `tool_result` are converted in both directions.
- Built-in Claude Code tools and MCP servers are disabled; client tools are returned to
  the caller instead of running on the gateway host.
- `stream: true` returns the standard Anthropic SSE event sequence after the native run
  finishes. It is wire-compatible but buffered rather than token-live.
- Image/document content blocks and exact `max_tokens` enforcement require a direct
  HTTP/API-key account because the Claude Code print interface does not expose an
  equivalent request contract.
- Each account has its own mode-0700 Claude config directory. Its token is supplied only
  in the child-process environment and never placed in command-line arguments.
