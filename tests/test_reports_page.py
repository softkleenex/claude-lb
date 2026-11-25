"""`/api/reports` (the Reports page payload) and the filtered cost report / CSV."""

from __future__ import annotations

import csv
import io
from datetime import UTC, datetime, time, timedelta

import pytest

from claude_lb.db.session import session_scope
from claude_lb.modules.settings import service as settings_service
from claude_lb.modules.usage import reports
from tests.test_dashboard_api import add_key, add_log
from tests.test_proxy_api import add_account, make_client, ok_json
from tests.test_reports import day_offset, seed


def at(days_ago: int, hour: int = 12) -> datetime:
    day = datetime.now(UTC).date() - timedelta(days=days_ago)
    return datetime.combine(day, time(hour), tzinfo=UTC)


async def get_report(query: str = "") -> dict:
    async for client in make_client(ok_json([])):
        response = await client.get(f"/api/reports{query}")
        assert response.status_code == 200, response.text
        return response.json()
    raise AssertionError("unreachable")


def week() -> str:
    return f"?start={day_offset(6)}&end={day_offset(0)}"


class TestValidation:
    @pytest.mark.parametrize(
        ("query", "message"),
        [
            ("?start=2026-05-02&end=2026-05-01", "start must not be after end"),
            ("?start=05/01/2026", "ISO YYYY-MM-DD"),
            ("?start=2020-01-01&end=2026-01-01", "366 days or less"),
            ("?group_by=colour", "group_by must be one of"),
        ],
    )
    async def test_bad_input_is_a_422(self, query, message):
        async for client in make_client(ok_json([])):
            response = await client.get(f"/api/reports{query}")
        assert response.status_code == 422
        assert message in response.json()["detail"]

    async def test_reports_require_authentication(self):
        from tests.test_auth import PASSWORD, make_remote_client

        async for client in make_client(ok_json([])):
            await client.post("/api/auth/password", json={"password": PASSWORD})
        async for client in make_remote_client(ok_json([])):
            assert (await client.get("/api/reports")).status_code == 401
            assert (await client.get("/api/reports/options")).status_code == 401


class TestSummaryAndDaily:
    async def test_spend_comes_from_rollups_and_days_are_zero_filled(self):
        a = await add_account("alpha")
        b = await add_account("beta")
        await seed(
            [
                {
                    "day": day_offset(0),
                    "account_id": a,
                    "model": "claude-sonnet-4-5",
                    "cost_usd": 3.0,
                    "requests": 4,
                },
                {
                    "day": day_offset(2),
                    "account_id": b,
                    "model": "claude-opus-4-1",
                    "cost_usd": 4.0,
                    "requests": 3,
                },
                {"day": day_offset(9), "account_id": a, "cost_usd": 100.0},
            ]
        )
        report = await get_report(week())

        assert report["source"] == "rollups"
        assert report["days"] == 7
        assert [p["day"] for p in report["daily"]] == [day_offset(i) for i in range(6, -1, -1)]
        assert [p["cost_usd"] for p in report["daily"]] == [0, 0, 0, 0, 4.0, 0, 3.0]
        summary = report["summary"]
        assert summary["total_cost_usd"] == 7.0
        assert summary["avg_cost_per_day"] == 1.0
        assert summary["requests"] == 7
        assert summary["avg_requests_per_day"] == 1.0
        assert summary["accounts_used"] == 2
        assert report["by_model"][0]["label"] == "claude-opus-4-1", "costliest first"

    async def test_rollups_cover_days_whose_request_logs_were_pruned(self):
        """No request logs at all, yet the cost series is complete."""
        await seed([{"day": day_offset(5), "cost_usd": 2.5}])
        report = await get_report(week())
        assert report["summary"]["total_cost_usd"] == 2.5
        assert report["daily"][1]["cost_usd"] == 2.5
        assert report["daily"][1]["median_ttft_ms"] is None

    async def test_cache_savings_and_hit_rate(self):
        async with session_scope() as session:
            from claude_lb.db.models import UsageDaily

            session.add(
                UsageDaily(
                    day=day_offset(0),
                    model="claude-sonnet-4-5",
                    requests=1,
                    errors=0,
                    input_tokens=100,
                    output_tokens=10,
                    cache_creation_input_tokens=0,
                    cache_read_input_tokens=1_000_000,
                    cost_usd=0.3,
                )
            )
        report = await get_report(week())
        summary = report["summary"]
        assert summary["cache_savings_usd"] > 0
        assert summary["cache_hit_rate"] == pytest.approx(1_000_000 / 1_000_100, abs=1e-4)
        assert report["breakdown"][0]["cache_savings_usd"] == summary["cache_savings_usd"]
        assert report["breakdown_total"]["cache_savings_usd"] == summary["cache_savings_usd"]

    async def test_previous_window_is_compared_when_it_has_history(self):
        await seed([{"day": day_offset(0), "cost_usd": 3.0}, {"day": day_offset(8), "cost_usd": 1.0}])
        report = await get_report(week())
        previous = report["previous"]
        assert previous["start"] == day_offset(13)
        assert previous["end"] == day_offset(7)
        assert previous["total_cost_usd"] == 1.0
        assert previous["can_compare"] is False, "history starts after the previous window began"

        await seed([{"day": day_offset(20), "cost_usd": 1.0}])
        assert (await get_report(week()))["previous"]["can_compare"] is True


class TestRequestLogMetrics:
    async def test_medians_of_ttft_and_tokens_per_second_per_day(self):
        # Streamed: TPS = output / ((duration - ttft) / 1000).
        await add_log(at(1), streaming=True, ttft_ms=200, duration_ms=1200, output_tokens=100)  # 100 tps
        await add_log(at(1), streaming=True, ttft_ms=400, duration_ms=1400, output_tokens=300)  # 300 tps
        await add_log(at(1), streaming=True, ttft_ms=600, duration_ms=600, output_tokens=0)  # no tps
        await add_log(at(1), streaming=False, duration_ms=9000)  # buffered: ignored
        report = await get_report(week())

        yesterday = report["daily"][5]
        assert yesterday["median_ttft_ms"] == 400
        assert yesterday["median_tps"] == 200
        assert report["daily"][6]["median_ttft_ms"] is None
        assert report["summary"]["median_ttft_ms"] == 400

    async def test_aborted_and_conversations_come_from_logs(self):
        await add_log(at(0), session_key="conv-a")
        await add_log(at(0), session_key="conv-a", error="client disconnected")
        await add_log(at(1), session_key="conv-b")
        await add_log(at(1), status_code=500, session_key="conv-b")
        report = await get_report(week())
        assert report["summary"]["aborted"] == 1
        assert report["summary"]["conversations"] == 2
        assert report["daily"][6]["aborted"] == 1
        assert report["daily"][6]["conversations"] == 1

    async def test_user_agent_distribution_groups_by_family(self):
        await add_log(at(0), user_agent="claude-cli/2.1 (external, cli)", cost_usd=1.0)
        await add_log(at(0), user_agent="claude-cli/2.0", cost_usd=2.0)
        await add_log(at(0), user_agent="python-httpx/0.27", cost_usd=0.5)
        await add_log(at(0), user_agent=None, cost_usd=0.25)
        report = await get_report(week())
        by_ua = {entry["label"]: entry for entry in report["by_user_agent"]}
        assert by_ua["claude-cli"]["cost_usd"] == 3.0
        assert by_ua["claude-cli"]["requests"] == 2
        assert by_ua["python-httpx"]["cost_usd"] == 0.5
        assert by_ua[reports.UNKNOWN_USER_AGENT]["requests"] == 1

    async def test_a_user_agent_filter_reads_everything_from_logs(self):
        await seed([{"day": day_offset(0), "cost_usd": 50.0}])  # rollup-only spend must not leak in
        await add_log(at(0), user_agent="claude-cli/2.1", cost_usd=1.0)
        await add_log(at(0), user_agent="claude-cli-extra/1.0", cost_usd=7.0)
        await add_log(at(0), user_agent="curl/8", cost_usd=2.0)
        report = await get_report(week() + "&user_agent=claude-cli")
        assert report["source"] == "request_logs"
        assert report["summary"]["total_cost_usd"] == 1.0
        assert [e["label"] for e in report["by_user_agent"]] == ["claude-cli"]

        unknown = await get_report(week() + f"&user_agent={reports.UNKNOWN_USER_AGENT}")
        assert unknown["summary"]["requests"] == 0

    async def test_coverage_flags_a_range_older_than_retention(self):
        async with session_scope() as session:
            await settings_service.update(session, {"request_log_retention_days": 7})
        report = await get_report(f"?start={day_offset(29)}&end={day_offset(0)}")
        assert report["coverage"] == {
            "retention_days": 7,
            "logs_from": day_offset(6),
            "logs_truncated": True,
        }
        assert (await get_report(week()))["coverage"]["logs_truncated"] is False


class TestFiltersAndGrouping:
    async def test_multi_filters_apply_to_every_section(self):
        a = await add_account("alpha")
        b = await add_account("beta")
        c = await add_account("gamma")
        await seed(
            [
                {"day": day_offset(0), "account_id": a, "model": "m1", "cost_usd": 1.0},
                {"day": day_offset(0), "account_id": b, "model": "m2", "cost_usd": 2.0},
                {"day": day_offset(0), "account_id": c, "model": "m1", "cost_usd": 4.0},
            ]
        )
        report = await get_report(week() + f"&account_id={a}&account_id={b}&group_by=account")
        assert report["summary"]["total_cost_usd"] == 3.0
        assert [row["label"] for row in report["breakdown"]] == ["beta", "alpha"]
        assert report["breakdown_total"]["cost_usd"] == 3.0

        by_model = await get_report(week() + "&model=m1&group_by=model")
        assert by_model["summary"]["total_cost_usd"] == 5.0
        assert [row["label"] for row in by_model["breakdown"]] == ["m1"]

    async def test_api_key_filter_and_grouping(self):
        k1 = await add_key("team-a")
        k2 = await add_key("team-b")
        await seed(
            [
                {"day": day_offset(0), "api_key_id": k1, "cost_usd": 1.0},
                {"day": day_offset(1), "api_key_id": k2, "cost_usd": 2.0},
            ]
        )
        report = await get_report(week() + f"&api_key_id={k1}&group_by=api_key")
        assert [(row["key"], row["label"]) for row in report["breakdown"]] == [(k1, "team-a")]

    async def test_group_by_user_agent(self):
        await add_log(at(0), user_agent="claude-cli/2.1", cost_usd=1.0)
        await add_log(at(1), user_agent="curl/8", cost_usd=3.0)
        report = await get_report(week() + "&group_by=user_agent")
        assert [row["label"] for row in report["breakdown"]] == ["curl", "claude-cli"]
        assert report["breakdown_total"]["cost_usd"] == 4.0

    async def test_group_by_day_lists_only_days_with_traffic(self):
        await seed([{"day": day_offset(0), "cost_usd": 1.0}, {"day": day_offset(3), "cost_usd": 1.0}])
        report = await get_report(week() + "&group_by=day")
        assert [row["label"] for row in report["breakdown"]] == [day_offset(3), day_offset(0)]


class TestOptions:
    async def test_lists_accounts_keys_models_and_user_agents(self):
        await add_account("zeta")
        await add_account("alpha")
        key = await add_key("team-a")
        await seed([{"day": day_offset(0), "model": "m1", "account_id": "gone-account-id"}])
        await add_log(at(0), user_agent="claude-cli/2.1")
        await add_log(at(0), user_agent="claude-cli/2.2")
        await add_log(at(0), user_agent=None)
        async for client in make_client(ok_json([])):
            options = (await client.get(f"/api/reports/options{week()}")).json()

        names = [a["name"] for a in options["accounts"]]
        assert names == ["(deleted: gone-acc)", "alpha", "zeta"]
        assert options["api_keys"] == [{"id": key, "name": "team-a", "key_hint": "clb-…team"}]
        assert options["models"] == ["m1"]
        assert options["user_agents"] == [reports.UNKNOWN_USER_AGENT, "claude-cli"]


class TestFilteredCostReport:
    async def test_usage_report_accepts_the_same_filters(self):
        a = await add_account("alpha")
        b = await add_account("beta")
        await seed(
            [
                {"day": day_offset(0), "account_id": a, "cost_usd": 1.0},
                {"day": day_offset(0), "account_id": b, "cost_usd": 2.0},
            ]
        )
        async for client in make_client(ok_json([])):
            payload = (await client.get(f"/api/usage/report?group_by=account&account_id={b}")).json()
            text = (await client.get(f"/api/usage/report.csv?group_by=account&account_id={b}")).text
        assert payload["total_cost_usd"] == 2.0
        assert payload["source"] == "rollups"
        rows = list(csv.reader(io.StringIO(text)))
        assert rows[0] == list(reports.CSV_COLUMNS)
        assert [r[1] for r in rows[1:]] == ["beta", "TOTAL"]
        assert float(rows[-1][-1]) == 2.0

    async def test_csv_by_user_agent(self):
        await add_log(at(0), user_agent="claude-cli/2.1", cost_usd=1.0)
        await add_log(at(0), user_agent="=cmd|calc/1", cost_usd=1.0)
        async for client in make_client(ok_json([])):
            response = await client.get("/api/usage/report.csv?group_by=user_agent")
        assert "user_agent" in response.headers["content-disposition"]
        rows = list(csv.reader(io.StringIO(response.text)))
        labels = [r[1] for r in rows[1:-1]]
        assert "claude-cli" in labels
        assert "'=cmd|calc" in labels, "formula-looking labels are neutralised"
