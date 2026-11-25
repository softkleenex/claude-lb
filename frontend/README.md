# claude-lb dashboard (React + Vite + TypeScript)

Derived from the [codex-lb](https://github.com/Soju06/codex-lb) frontend,
MIT License © 2025 Soju06 — see `LICENSE` in this directory. Modifications for
claude-lb are under the project's MIT license.

## Setup

```bash
cd frontend
npm install
```

## Development

```bash
# backend on :2456 (or set API_PROXY_TARGET)
uv run claude-lb serve
npm run dev
```

Vite proxies `/api`, `/v1`, `/health` and `/metrics` to the backend.

## Build

```bash
npm run build
```

Output goes to `../claude_lb/modules/dashboard/static/` and is committed, so the
Python package serves the dashboard without Node.

## Test / lint

```bash
npm test
npm run lint
```
