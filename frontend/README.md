# claude-lb dashboard (React + Vite + TypeScript)

Derived from the [codex-lb](https://github.com/Soju06/codex-lb) frontend,
MIT License © 2025 Soju06 — see `LICENSE` in this directory. Modifications for
claude-lb are under the project's MIT license.

Layout, wire format and serving are described in [ARCHITECTURE.md](../ARCHITECTURE.md#dashboard-frontend).

## Setup

Node 20 or newer, npm (not bun):

```bash
cd frontend
npm ci
```

`jsdom` is pinned to exactly `30.0.1` on purpose (30.1.x breaks style assertions and MSW in tests).

## Development

Run a backend on port 2456 against a throwaway data directory, then the Vite dev server:

```bash
# terminal 1 — repository root; a demo backend with simulated traffic and no API key:
CLAUDE_LB_DATA_DIR=$(mktemp -d) uv run claude-lb demo --port 2456 --no-open
# …or a plain server: CLAUDE_LB_DATA_DIR=$(mktemp -d) uv run claude-lb serve --port 2456

# terminal 2
cd frontend && npm run dev        # http://localhost:5173
```

Vite proxies `/api`, `/v1`, `/health` and `/metrics` to `http://localhost:2456`; set
`API_PROXY_TARGET` to point elsewhere. Pointing the dev server at your real data directory
works too, but remember the dashboard can change real accounts.

## Build

```bash
npm run build
```

Output goes to `../claude_lb/modules/dashboard/static/` (the directory is emptied first) and
**is committed**, so `uv run claude-lb serve`, the wheel and the Docker image serve the
dashboard without Node. Rebuild and commit it with every frontend change.

## Test / lint

```bash
npm test          # vitest + Testing Library + MSW
npm run lint      # eslint
npm run typecheck
```

- API mocks live in `src/test/mocks/handlers.ts` (snake_case, mirroring the FastAPI handlers) with
  wire factories in `factories.ts`; `handler-coverage.test.ts` lists every mocked endpoint —
  update it when you add one.
- Translations: `src/i18n/locales/{en,ko,zh-CN}.json`, flat dotted keys. Add English and Korean
  together; Simplified Chinese falls back to English for missing keys.
- On the backend, `tests/test_dashboard_contract.py` fails if the frontend calls an `/api` path
  that is not routed, or if the committed build is incomplete.
