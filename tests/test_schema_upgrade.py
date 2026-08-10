"""Booting against a database written by an older release.

Every other test starts from a freshly created schema, which is exactly why nobody
noticed that `create_all` never adds a column to a table that already exists. These
tests build an old-shaped table on purpose.
"""

from __future__ import annotations

import pytest
from sqlalchemy import inspect, text

from app.db import schema
from app.db.models import Base, UsageDaily
from app.db.session import get_engine, init_db, session_scope

# The shape `usage_daily` had before the api_key dimension was added, verbatim.
OLD_USAGE_DAILY = """
CREATE TABLE usage_daily (
    id VARCHAR(32) NOT NULL,
    day VARCHAR(10) NOT NULL,
    account_id VARCHAR(32),
    model VARCHAR(128),
    requests INTEGER NOT NULL,
    errors INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_creation_input_tokens INTEGER NOT NULL,
    cache_read_input_tokens INTEGER NOT NULL,
    cost_usd FLOAT NOT NULL,
    updated_at DATETIME NOT NULL,
    PRIMARY KEY (id)
)
"""


async def columns_of(table: str) -> set[str]:
    engine = get_engine()
    async with engine.begin() as conn:
        return {col["name"] for col in await conn.run_sync(lambda c: inspect(c).get_columns(table))}


async def build_old_schema() -> None:
    """Drop the modern table and put the old one in its place, with a row in it."""
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.execute(text("DROP TABLE IF EXISTS usage_daily"))
        await conn.execute(text(OLD_USAGE_DAILY))
        await conn.execute(
            text(
                "INSERT INTO usage_daily (id, day, account_id, model, requests, errors,"
                " input_tokens, output_tokens, cache_creation_input_tokens,"
                " cache_read_input_tokens, cost_usd, updated_at)"
                " VALUES ('row1', '2026-01-01', 'acct', 'claude-opus-5', 7, 1,"
                " 100, 200, 0, 0, 1.5, '2026-01-01 00:00:00')"
            )
        )


class TestAdditiveUpgrade:
    async def test_a_missing_column_is_added_on_startup(self):
        await build_old_schema()
        assert "api_key_id" not in await columns_of("usage_daily")

        await init_db()

        assert "api_key_id" in await columns_of("usage_daily")

    async def test_existing_rows_survive_the_upgrade(self):
        """An upgrade that loses historical spend is worse than one that fails."""
        await build_old_schema()
        await init_db()

        async with session_scope() as session:
            row = await session.get(UsageDaily, "row1")

        assert row is not None
        assert row.requests == 7
        assert row.cost_usd == 1.5
        assert row.api_key_id is None, "the new dimension is unknown for old rows"

    async def test_the_upgraded_table_is_queryable(self):
        """The actual production symptom was `no such column` at query time."""
        await build_old_schema()
        await init_db()

        from app.modules.usage import reports

        async with session_scope() as session:
            report = await reports.build(session, group_by="api_key", start="2026-01-01", end="2026-01-01")
        assert report.total_requests == 7

    async def test_running_twice_changes_nothing(self):
        await build_old_schema()
        await init_db()
        engine = get_engine()
        async with engine.begin() as conn:
            second = await schema.reconcile(conn)
        assert second == [], "reconcile must be idempotent"

    async def test_a_current_schema_needs_no_changes(self):
        engine = get_engine()
        async with engine.begin() as conn:
            assert await schema.reconcile(conn) == []

    async def test_every_model_column_exists_after_startup(self):
        """Catches the next forgotten column, not just this one."""
        await build_old_schema()
        await init_db()

        engine = get_engine()
        for table in Base.metadata.sorted_tables:
            async with engine.begin() as conn:
                live = {
                    col["name"]
                    for col in await conn.run_sync(lambda c, name=table.name: inspect(c).get_columns(name))
                }
            missing = {c.name for c in table.columns} - live
            assert not missing, f"{table.name} is missing {missing}"


class TestDefaults:
    def test_a_string_default_is_quoted_and_escaped(self):
        from sqlalchemy import Column, String

        column = Column("c", String(8), default="it's", nullable=False)
        assert schema._literal_default(column) == "'it''s'"

    def test_a_boolean_default_becomes_a_numeric_literal(self):
        from sqlalchemy import Boolean, Column

        assert schema._literal_default(Column("c", Boolean, default=True)) == "1"
        assert schema._literal_default(Column("c", Boolean, default=False)) == "0"

    def test_a_numeric_default_is_rendered_bare(self):
        from sqlalchemy import Column, Integer

        assert schema._literal_default(Column("c", Integer, default=0)) == "0"

    def test_a_callable_default_has_no_sql_literal(self):
        # e.g. `default=utcnow` — there is nothing to write into the DDL.
        from sqlalchemy import Column, DateTime

        from app.db.models import utcnow

        assert schema._literal_default(Column("c", DateTime, default=utcnow)) is None

    def test_no_default_yields_none(self):
        from sqlalchemy import Column, String

        assert schema._literal_default(Column("c", String(8))) is None


class TestUnsafeUpgradesFailLoudly:
    async def test_a_not_null_column_without_a_default_is_refused(self):
        """Backfilling existing rows is a judgement call, so it must not be guessed."""
        from sqlalchemy import Column, Integer, MetaData, String, Table

        engine = get_engine()
        async with engine.begin() as conn:
            await conn.execute(text("DROP TABLE IF EXISTS legacy_probe"))
            await conn.execute(text("CREATE TABLE legacy_probe (id VARCHAR(8) PRIMARY KEY)"))

        metadata = MetaData()
        Table(
            "legacy_probe",
            metadata,
            Column("id", String(8), primary_key=True),
            Column("mandatory", Integer, nullable=False),
        )

        original = Base.metadata.tables
        try:
            Base.metadata._add_table("legacy_probe", None, metadata.tables["legacy_probe"])
            async with engine.begin() as conn:
                with pytest.raises(schema.SchemaUpgradeError, match="NOT NULL with no"):
                    await schema.reconcile(conn)
        finally:
            Base.metadata._remove_table("legacy_probe", None)
            assert Base.metadata.tables is original
            async with engine.begin() as conn:
                await conn.execute(text("DROP TABLE IF EXISTS legacy_probe"))
