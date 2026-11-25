# Subscription Pooling

`claude-lb` supports pooling **Claude subscription accounts** (Pro, Max 5x, Max 20x, Team, Enterprise) alongside standard Console API keys in a single unified pool — modeled after [`codex-lb`](https://github.com/Soju06/codex-lb).

> **Credentials remain yours to supply.** `claude-lb` ships no first-party OAuth client constants. You can add subscription accounts via `claude-lb account login` (PKCE), `claude-lb account add-oauth`, or `claude-lb account import --file ...` using your own exported credentials JSON.

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
- **Manual reset**: `POST /api/accounts/{id}/reset-quota` clears stored quota blocks immediately.

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
  --routing-policy burn_first
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
- **Dashboard**: Displays plan badges, inline `routing_policy` selectors, 5h/7d quota utilization with reset times, depletion risk pills, and overall pool remaining percentage.

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

## Adding a subscription account

```bash
claude-lb account add-subscription alice --plan-type max_5x
```

A browser opens; log in with the account to add (paste the code back if the terminal
asks). claude-lb runs Claude Code's own `claude setup-token` in a throwaway config
directory, so the Claude Code login you are using right now is not touched. It then
sends one tiny Haiku request to confirm the token and prints the current 5h/7d usage.
Requires Claude Code (`claude`) on `PATH`.

claude-lb ships no OAuth client id and does not present itself as Claude Code.

## Models a subscription refuses

Called from outside Claude Code, a subscription token may be refused for some models
(observed: Haiku works, Sonnet/Opus get `429` with message `"Error"` and no
`anthropic-ratelimit-unified-*` headers). claude-lb tells this apart from a real quota
rejection, which always carries those headers:

- The account is **not** cooled down; it keeps serving models it can.
- That model is routed to other accounts for 12 hours, then tried again.
- `claude-lb account list` shows `alice: refuses claude-sonnet-5-5 — those requests go to other accounts.`

Keep at least one API-key account in the pool for the models subscriptions refuse.
