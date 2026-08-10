from __future__ import annotations

import csv
import io
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete

from app.db.models import RequestLog, UsageDaily
from app.db.session import session_scope
from app.modules.usage import reports
from tests.test_proxy_api import MESSAGE_BODY, add_account, make_client, ok_json


def day_offset(days: int) -> str:
    return (datetime.now(UTC).date() - timedelta(days=days)).isoformat()


async def seed(rows: list[dict]) -> None:
    async with session_scope() as session:
        for row in rows:
            session.add(
                UsageDaily(
                    day=row["day"],
                    account_id=row.get("account_id"),
                    api_key_id=row.get("api_key_id"),
                    model=row.get("model"),
                    requests=row.get("requests", 1),
                    errors=row.get("errors", 0),
                    input_tokens=row.get("input_tokens", 0),
                    output_tokens=row.get("output_tokens", 0),
                    cache_creation_input_tokens=0,
                    cache_read_input_tokens=0,
                    cost_usd=row.get("cost_usd", 0.0),
                )
            )


class TestDateRange:
    def test_defaults_to_the_last_30_days(self):
        start, end = reports.normalize_range(None, None)
        assert end == day_offset(0)
        assert start == day_offset(29)

    def test_accepts_an_explicit_range(self):
        assert reports.normalize_range("2026-01-01", "2026-01-31") == ("2026-01-01", "2026-01-31")

    def test_a_single_day_range_is_valid(self):
        assert reports.normalize_range("2026-01-05", "2026-01-05") == ("2026-01-05", "2026-01-05")

    def test_a_reversed_range_is_rejected(self):
        with pytest.raises(ValueError, match="start must not be after end"):
            reports.normalize_range("2026-02-01", "2026-01-01")

    @pytest.mark.parametrize("bad", ["01/02/2026", "2026-13-01", "yesterday", "2026-1-1x"])
    def test_a_malformed_date_is_rejected(self, bad):
        with pytest.raises(ValueError, match="ISO YYYY-MM-DD"):
            reports.normalize_range(bad, None)


class TestGrouping:
    async def test_rejects_an_unknown_grouping(self):
        async with session_scope() as session:
            with pytest.raises(ValueError, match="group_by must be one of"):
                await reports.build(session, group_by="colour")

    async def test_groups_by_day_in_chronological_order(self):
        await seed(
            [
                {"day": day_offset(2), "cost_usd": 1.0},
                {"day": day_offset(0), "cost_usd": 3.0},
                {"day": day_offset(1), "cost_usd": 2.0},
            ]
        )
        async with session_scope() as session:
            report = await reports.build(session, group_by="day")

        assert [r.label for r in report.rows] == [day_offset(2), day_offset(1), day_offset(0)]
        assert report.total_cost_usd == 6.0

    async def test_other_groupings_are_costliest_first(self):
        cheap = await add_account("cheap")
        pricey = await add_account("pricey")
        await seed(
            [
                {"day": day_offset(0), "account_id": cheap, "cost_usd": 1.0},
                {"day": day_offset(0), "account_id": pricey, "cost_usd": 9.0},
            ]
        )
        async with session_scope() as session:
            report = await reports.build(session, group_by="account")

        assert [r.label for r in report.rows] == ["pricey", "cheap"]

    async def test_sums_across_days_within_the_range(self):
        account = await add_account("acct")
        await seed(
            [
                {"day": day_offset(0), "account_id": account, "cost_usd": 1.5, "requests": 2},
                {"day": day_offset(1), "account_id": account, "cost_usd": 2.5, "requests": 3},
            ]
        )
        async with session_scope() as session:
            report = await reports.build(session, group_by="account")

        assert len(report.rows) == 1
        assert report.rows[0].cost_usd == 4.0
        assert report.rows[0].requests == 5

    async def test_the_range_is_inclusive_at_both_ends(self):
        await seed(
            [
                {"day": "2026-01-01", "cost_usd": 1.0},
                {"day": "2026-01-15", "cost_usd": 1.0},
                {"day": "2026-01-31", "cost_usd": 1.0},
                {"day": "2026-02-01", "cost_usd": 99.0},
            ]
        )
        async with session_scope() as session:
            report = await reports.build(session, group_by="day", start="2026-01-01", end="2026-01-31")

        assert report.total_cost_usd == 3.0, "both endpoints included, February excluded"

    async def test_labels_resolve_to_names(self):
        account = await add_account("prod-us")
        await seed([{"day": day_offset(0), "account_id": account, "cost_usd": 1.0}])
        async with session_scope() as session:
            report = await reports.build(session, group_by="account")
        assert report.rows[0].label == "prod-us"

    async def test_spend_from_a_deleted_account_is_still_reported(self):
        """Rollups outlive the account; dropping the row would understate the bill."""
        await seed([{"day": day_offset(0), "account_id": "gone-forever", "cost_usd": 4.0}])
        async with session_scope() as session:
            report = await reports.build(session, group_by="account")
        assert report.total_cost_usd == 4.0
        assert report.rows[0].label.startswith("(deleted:")

    async def test_unattributed_spend_is_not_labelled_deleted(self):
        """A NULL key means the spend was never attributed — rollups written before
        the dimension existed, or requests made without a client key. Calling that
        "deleted" asserts something untrue about a key that may still exist."""
        await seed([{"day": day_offset(0), "api_key_id": None, "cost_usd": 2.0}])
        async with session_scope() as session:
            report = await reports.build(session, group_by="api_key")
        assert report.rows[0].label == "(unattributed)"

    async def test_deleted_and_unattributed_are_distinguishable(self):
        await seed(
            [
                {"day": day_offset(0), "api_key_id": None, "cost_usd": 1.0},
                {"day": day_offset(0), "api_key_id": "vanished-key-id", "cost_usd": 2.0},
            ]
        )
        async with session_scope() as session:
            report = await reports.build(session, group_by="api_key")
        labels = {r.label for r in report.rows}
        assert "(unattributed)" in labels
        assert any(label.startswith("(deleted:") for label in labels)

    async def test_an_empty_range_reports_zero_rather_than_failing(self):
        async with session_scope() as session:
            report = await reports.build(session, group_by="day", start="2020-01-01", end="2020-01-02")
        assert report.rows == []
        assert report.total_cost_usd == 0.0


class TestPerKeyAttribution:
    async def test_traffic_is_attributed_to_the_key_that_drove_it(self, proxy_calls):
        await add_account("primary")
        async for client in make_client(ok_json(proxy_calls)):
            team_a = (await client.post("/api/keys", json={"name": "team-a"})).json()
            team_b = (await client.post("/api/keys", json={"name": "team-b"})).json()

            for _ in range(3):
                await client.post("/v1/messages", json=MESSAGE_BODY, headers={"x-api-key": team_a["api_key"]})
            await client.post("/v1/messages", json=MESSAGE_BODY, headers={"x-api-key": team_b["api_key"]})

            report = (await client.get("/api/usage/report?group_by=api_key")).json()

        by_label = {row["label"]: row for row in report["rows"]}
        assert by_label["team-a"]["requests"] == 3
        assert by_label["team-b"]["requests"] == 1
        assert by_label["team-a"]["cost_usd"] > by_label["team-b"]["cost_usd"]

    async def test_the_report_survives_log_pruning(self, proxy_calls):
        await add_account("primary")
        async for client in make_client(ok_json(proxy_calls)):
            key = (await client.post("/api/keys", json={"name": "team-a"})).json()
            for _ in range(2):
                await client.post("/v1/messages", json=MESSAGE_BODY, headers={"x-api-key": key["api_key"]})

            async with session_scope() as session:
                await session.execute(delete(RequestLog))

            report = (await client.get("/api/usage/report?group_by=api_key")).json()

        assert report["total_requests"] == 2, "rollups, not logs, back the report"


class TestReportApi:
    async def test_returns_totals_and_rows(self):
        await seed([{"day": day_offset(0), "model": "claude-opus-5", "cost_usd": 2.0, "requests": 4}])
        async for client in make_client(ok_json([])):
            payload = (await client.get("/api/usage/report?group_by=model")).json()

        assert payload["group_by"] == "model"
        assert payload["total_cost_usd"] == 2.0
        assert payload["total_requests"] == 4
        assert payload["rows"][0]["label"] == "claude-opus-5"

    async def test_an_invalid_grouping_is_a_422(self):
        async for client in make_client(ok_json([])):
            response = await client.get("/api/usage/report?group_by=colour")
        assert response.status_code == 422

    async def test_an_invalid_date_is_a_422(self):
        async for client in make_client(ok_json([])):
            response = await client.get("/api/usage/report?start=not-a-date")
        assert response.status_code == 422

    async def test_a_reversed_range_is_a_422(self):
        async for client in make_client(ok_json([])):
            response = await client.get("/api/usage/report?start=2026-05-01&end=2026-04-01")
        assert response.status_code == 422

    async def test_reports_require_authentication(self):
        from tests.test_auth import PASSWORD, make_remote_client

        async for client in make_client(ok_json([])):
            await client.post("/api/auth/password", json={"password": PASSWORD})
        async for client in make_remote_client(ok_json([])):
            assert (await client.get("/api/usage/report")).status_code == 401
            assert (await client.get("/api/usage/report.csv")).status_code == 401


class TestCsvExport:
    async def test_is_downloadable_and_parses_as_csv(self):
        account = await add_account("prod-us")
        await seed(
            [{"day": day_offset(0), "account_id": account, "cost_usd": 1.25, "requests": 7, "errors": 1}]
        )
        async for client in make_client(ok_json([])):
            response = await client.get("/api/usage/report.csv?group_by=account")

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/csv")
        assert "attachment" in response.headers["content-disposition"]
        assert ".csv" in response.headers["content-disposition"]

        rows = list(csv.reader(io.StringIO(response.text)))
        assert rows[0] == list(reports.CSV_COLUMNS)
        assert rows[1][1] == "prod-us"
        assert rows[1][2] == "7"

    async def test_ends_with_a_total_row_that_reconciles(self):
        await seed(
            [
                {"day": day_offset(0), "model": "a", "cost_usd": 1.5, "requests": 2},
                {"day": day_offset(0), "model": "b", "cost_usd": 2.5, "requests": 3},
            ]
        )
        async for client in make_client(ok_json([])):
            text = (await client.get("/api/usage/report.csv?group_by=model")).text

        rows = list(csv.reader(io.StringIO(text)))
        total = rows[-1]
        assert total[1] == "TOTAL"
        assert float(total[-1]) == 4.0
        assert total[2] == "5"
        # The body rows must sum to the total, or a spreadsheet will disagree.
        assert sum(float(r[-1]) for r in rows[1:-1]) == pytest.approx(float(total[-1]))

    async def test_a_label_containing_a_comma_is_quoted(self):
        """An unquoted comma would silently shift every later column."""
        await seed([{"day": day_offset(0), "model": "weird,model,name", "cost_usd": 1.0}])
        async for client in make_client(ok_json([])):
            text = (await client.get("/api/usage/report.csv?group_by=model")).text

        rows = list(csv.reader(io.StringIO(text)))
        assert rows[1][1] == "weird,model,name"
        assert len(rows[1]) == len(reports.CSV_COLUMNS)

    async def test_an_empty_report_still_produces_a_header_and_total(self):
        async for client in make_client(ok_json([])):
            text = (await client.get("/api/usage/report.csv?start=2020-01-01&end=2020-01-02")).text
        rows = list(csv.reader(io.StringIO(text)))
        assert rows[0] == list(reports.CSV_COLUMNS)
        assert rows[-1][1] == "TOTAL"
        assert float(rows[-1][-1]) == 0.0

    def test_the_filename_names_the_grouping_and_range(self):
        report = reports.Report(group_by="api_key", start="2026-01-01", end="2026-01-31", rows=[])
        assert reports.filename(report) == "claude-lb-api_key-2026-01-01-to-2026-01-31.csv"
