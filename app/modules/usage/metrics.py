"""Prometheus text exposition.

Hand-rolled rather than pulling in `prometheus_client`: the whole surface is a dozen
gauges rendered from a single query, and the scrape endpoint is stateless.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Account, ApiKey, RequestLog
from app.modules.proxy import load_balancer as lb
from app.modules.proxy import sticky

CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"


def _escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


class _Renderer:
    def __init__(self) -> None:
        self._lines: list[str] = []

    def metric(self, name: str, help_text: str, kind: str = "gauge") -> None:
        self._lines.append(f"# HELP {name} {help_text}")
        self._lines.append(f"# TYPE {name} {kind}")

    def sample(self, name: str, value: float, **labels: str) -> None:
        if labels:
            rendered = ",".join(f'{k}="{_escape(str(v))}"' for k, v in sorted(labels.items()))
            self._lines.append(f"{name}{{{rendered}}} {value}")
        else:
            self._lines.append(f"{name} {value}")

    def render(self) -> str:
        return "\n".join(self._lines) + "\n"


async def render(session: AsyncSession) -> str:
    out = _Renderer()
    now = datetime.now(UTC)

    accounts = list((await session.execute(select(Account).order_by(Account.name))).scalars())

    out.metric("claude_lb_accounts_total", "Configured upstream accounts.")
    out.sample("claude_lb_accounts_total", len(accounts))

    out.metric("claude_lb_accounts_available", "Accounts currently eligible for routing.")
    out.sample("claude_lb_accounts_available", sum(1 for a in accounts if lb.is_available(a)))

    out.metric("claude_lb_account_up", "1 when the account is eligible for routing, else 0.")
    out.metric("claude_lb_account_headroom_ratio", "Believed remaining rate-limit budget, 0-1.")
    out.metric("claude_lb_account_requests_total", "Requests served by the account.", "counter")
    out.metric("claude_lb_account_tokens_total", "Tokens attributed to the account.", "counter")
    out.metric("claude_lb_account_cost_usd_total", "Estimated spend attributed to the account.", "counter")
    out.metric("claude_lb_account_consecutive_failures", "Consecutive upstream failures.")

    for account in accounts:
        label = {"account": account.name}
        out.sample("claude_lb_account_up", 1 if lb.is_available(account) else 0, **label)
        out.sample("claude_lb_account_headroom_ratio", round(lb.headroom(account), 4), **label)
        out.sample("claude_lb_account_requests_total", account.total_requests, **label)
        out.sample("claude_lb_account_tokens_total", account.total_input_tokens, **label, direction="input")
        out.sample("claude_lb_account_tokens_total", account.total_output_tokens, **label, direction="output")
        out.sample("claude_lb_account_cost_usd_total", round(account.total_cost_usd, 6), **label)
        out.sample("claude_lb_account_consecutive_failures", account.consecutive_failures, **label)

    # Recent-window view, so a dashboard can alert on error rate without a rate() query.
    since = now - timedelta(minutes=5)
    recent = (
        await session.execute(
            select(
                func.count(RequestLog.id),
                func.coalesce(func.sum(RequestLog.cost_usd), 0.0),
                func.coalesce(func.avg(RequestLog.duration_ms), 0.0),
            ).where(RequestLog.created_at >= since)
        )
    ).one()
    errors = (
        await session.execute(
            select(func.count(RequestLog.id)).where(
                RequestLog.created_at >= since, RequestLog.status_code >= 400
            )
        )
    ).scalar_one()

    out.metric("claude_lb_requests_recent", "Requests in the last 5 minutes.")
    out.sample("claude_lb_requests_recent", recent[0])
    out.metric("claude_lb_request_errors_recent", "Requests in the last 5 minutes that failed.")
    out.sample("claude_lb_request_errors_recent", errors)
    out.metric("claude_lb_cost_usd_recent", "Estimated spend in the last 5 minutes.")
    out.sample("claude_lb_cost_usd_recent", round(recent[1], 6))
    out.metric("claude_lb_request_duration_ms_avg_recent", "Mean request duration over 5 minutes.")
    out.sample("claude_lb_request_duration_ms_avg_recent", round(recent[2], 2))

    key_count = (await session.execute(select(func.count(ApiKey.id)))).scalar_one()
    out.metric("claude_lb_api_keys_total", "Issued proxy API keys.")
    out.sample("claude_lb_api_keys_total", key_count)

    out.metric("claude_lb_sticky_sessions", "Conversations currently pinned to an account.")
    out.sample("claude_lb_sticky_sessions", sticky.size())

    return out.render()
