"""Bring an existing database up to the current model definitions.

`create_all` only creates *missing tables*. It never touches a table that already
exists, so every release that added a column left upgraded instances failing with
"no such column" the first time that column was queried — and no test caught it,
because tests always start from a fresh schema.

This reconciles the additive case, which is every schema change claude-lb has made:
columns present in the metadata but absent from the live table are added with
``ALTER TABLE ... ADD COLUMN``. It is idempotent and runs on every startup.

Deliberately *not* a migration framework. Renames, drops, type changes, and new
constraints are out of scope — those need a real migration, and this will not
pretend otherwise. It fails loudly rather than guessing.
"""

from __future__ import annotations

import logging

from sqlalchemy import Column, inspect, text
from sqlalchemy.ext.asyncio import AsyncConnection
from sqlalchemy.schema import CreateIndex

from app.db.models import Base

logger = logging.getLogger(__name__)


class SchemaUpgradeError(RuntimeError):
    """A column is missing that cannot be added safely."""


def _literal_default(column: Column) -> str | None:
    """A SQL literal for ADD COLUMN's DEFAULT, or None if there isn't one.

    SQLAlchemy's `default=` is applied in Python at INSERT time, so it does not help
    an ALTER against a table that already has rows — the existing rows need a value
    written now.
    """
    default = column.default
    if default is None or not getattr(default, "is_scalar", False):
        return None
    value = default.arg
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        escaped = value.replace("'", "''")
        return f"'{escaped}'"
    return None


async def reconcile(connection: AsyncConnection) -> list[str]:
    """Add any columns the models declare but the database lacks.

    Returns the ``table.column`` names that were added, for logging.
    """
    existing_tables = set(await connection.run_sync(lambda c: inspect(c).get_table_names()))

    added: list[str] = []

    for table in Base.metadata.sorted_tables:
        if table.name not in existing_tables:
            # create_all already handled brand-new tables.
            continue

        present = {
            col["name"]
            for col in await connection.run_sync(lambda c, name=table.name: inspect(c).get_columns(name))
        }
        for column in table.columns:
            if column.name in present:
                continue

            ddl_type = column.type.compile(connection.dialect)
            clause = f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {ddl_type}'

            if not column.nullable:
                default = _literal_default(column)
                if default is None:
                    raise SchemaUpgradeError(
                        f"cannot add {table.name}.{column.name}: it is NOT NULL with no "
                        "scalar default, so existing rows have no value to take. Give the "
                        "column a default, make it nullable, or write a migration."
                    )
                clause += f" NOT NULL DEFAULT {default}"
            else:
                default = _literal_default(column)
                if default is not None:
                    clause += f" DEFAULT {default}"

            await connection.execute(text(clause))
            added.append(f"{table.name}.{column.name}")

    # An index declared alongside a new column is not created by create_all either,
    # because its table already existed.
    for table in Base.metadata.sorted_tables:
        if table.name not in existing_tables:
            continue
        known = {
            index["name"]
            for index in await connection.run_sync(lambda c, name=table.name: inspect(c).get_indexes(name))
        }
        for index in table.indexes:
            if index.name not in known:
                try:
                    await connection.execute(CreateIndex(index))
                    added.append(f"{table.name}:{index.name}")
                except Exception as exc:  # noqa: BLE001 - a unique index may now conflict
                    logger.warning("could not create index %s: %s", index.name, exc)

    if added:
        logger.info("schema upgraded: added %s", ", ".join(added))
    return added
