# Changelog

All notable changes to claude-lb. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may change behaviour).

## [Unreleased]

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

[Unreleased]: https://github.com/softkleenex/claude-lb/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/softkleenex/claude-lb/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/softkleenex/claude-lb/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/softkleenex/claude-lb/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/softkleenex/claude-lb/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/softkleenex/claude-lb/releases/tag/v0.1.0
