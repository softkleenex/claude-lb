# Contributing

Thanks for helping. Bug reports with a reproduction are as valuable as code.

## Setup

```bash
git clone https://github.com/softkleenex/claude-lb && cd claude-lb
uv sync --extra postgres
uv run pytest -q
uv run claude-lb serve --reload
```

[ARCHITECTURE.md](ARCHITECTURE.md) explains how a request moves through the code.

## Before opening a PR

```bash
uv run ruff check . && uv run ruff format --check .
uv run pytest -q
```

CI also runs the whole suite against **Postgres**. To run it locally:

```bash
CLAUDE_LB_TEST_DATABASE_URL=postgresql+asyncpg://user:pass@localhost/claude_lb_test uv run pytest -q
```

SQLite serializes writes, so lost updates and transaction-abort bugs only show up on Postgres.

## What makes a change easy to merge

- **Add a test that fails without the change.** For a concurrency or streaming bug, the test has
  to exercise concurrency or an aborted stream. Most of the bugs fixed so far slipped through
  because every test sent one request and read it to the end.
- **Keep it narrow.** One concern per PR.
- **Explain why in comments, not what.** The codebase records why a non-obvious choice was made,
  usually the failure it prevents. Keep doing that.
- **Update [CHANGELOG.md](CHANGELOG.md)** under *Unreleased* for anything a user would notice.

## Pricing updates

When Anthropic publishes a new model or price, update `claude_lb/core/pricing.py`. List every point
release whose price differs from its family's: lookup takes the longest matching prefix, so a
missing entry silently bills the family rate. Add a test next to the existing pricing tests.

## Scope

claude-lb pools credentials **you are entitled to pool**: Console API keys, or bearer tokens you
supply. Changes that pool consumer subscriptions, or that ship a provider's OAuth client
identity, will not be merged.

## Releasing (maintainers)

1. Move *Unreleased* in the changelog to a new version heading, and bump `version` in
   `pyproject.toml`.
2. Merge, then `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The release workflow checks that the tag matches the version, publishes to PyPI (trusted
   publishing) and to GHCR (amd64 and arm64).
