#!/usr/bin/env python3
"""Best-effort Postgres analytics mirror for bookmark transitions.

This module is intentionally tiny: one public function, `insert_transition`,
that mirrors a single bookmark state-transition event into the
`analytics.bookmark_transitions` table (or `analytics.task_transitions` for
the future feature-task mirror).

Contract:
- Returns ``False`` silently when ``DATABASE_URL`` is unset (no-op).
- Returns ``False`` and logs a warning on any DB failure (timeout, auth,
  schema mismatch, etc.). Never raises — the JSONL append path must remain
  authoritative and is untouched by this module.
- Returns ``True`` on a successful insert.

No schema or table creation lives here — that is owned by the SQL migration
in ``services/tasks-api/prisma/migrations/``.

Driver choice: tries ``psycopg2`` first (already a transitive dependency of
Prisma), falls back to ``pg8000`` (pure-Python, used by the Tasks API REST
tests) when psycopg2 is not importable.
"""

from __future__ import annotations

import os
from typing import Any

from common import log_debug

# Table → column list. Kept module-level so call sites can pass the table
# name without re-declaring the schema. New analytics tables can be added
# here without changing call sites.
_TABLE_COLUMNS: dict[str, tuple[str, ...]] = {
    "bookmark_transitions": (
        "bookmark_key",
        "bookmark_url",
        "bookmark_slug",
        "from_status",
        "to_status",
        "topic",
        "approval_status",
        "actor",
        "source",
        "payload",
    ),
    "task_transitions": (
        "task_id",
        "bookmark_key",
        "from_status",
        "to_status",
        "actor",
        "source",
        "payload",
    ),
}


def _connect(database_url: str):
    """Open a short-lived Postgres connection.

    Prefers psycopg2; falls back to pg8000. Raises on failure — caller
    catches and converts to a logged warning.
    """
    try:
        import psycopg2  # type: ignore

        return psycopg2.connect(database_url, connect_timeout=2)
    except ImportError:
        pass
    try:
        import pg8000.dbapi as pg8000_dbapi  # type: ignore

        # pg8000 expects URL components, not a connection string. Parse minimally.
        # Format: postgresql://user:pass@host:port/dbname?...
        from urllib.parse import parse_qs, urlparse

        parsed = urlparse(database_url)
        user = parsed.username or ""
        password = parsed.password or ""
        host = parsed.hostname or "localhost"
        port = parsed.port or 5432
        database = (parsed.path or "/").lstrip("/") or "postgres"
        # pg8000.connect accepts kwargs; ssl is parsed from query string.
        qs = parse_qs(parsed.query or "")
        ssl = bool(qs.get("ssl", ["false"])[0].lower() == "true")
        connect_kwargs: dict[str, Any] = {
            "user": user,
            "password": password,
            "host": host,
            "port": port,
            "database": database,
        }
        if ssl:
            connect_kwargs["ssl_context"] = True
        return pg8000_dbapi.connect(**connect_kwargs)
    except ImportError as e:
        raise RuntimeError(
            "analytics_db: no Postgres driver available (need psycopg2 or pg8000)"
        ) from e


def insert_transition(event: dict, *, table: str = "bookmark_transitions") -> bool:
    """Insert a single transition row into the named analytics table.

    Parameters
    ----------
    event
        Mapping whose keys are a subset of the table's columns. Unknown keys
        are ignored. ``payload`` is JSON-serialised; everything else is bound
        as text. Missing keys map to NULL.
    table
        One of the keys in ``_TABLE_COLUMNS``. Defaults to
        ``bookmark_transitions``.

    Returns
    -------
    bool
        ``True`` on successful insert, ``False`` otherwise (no env var, DB
        unreachable, schema mismatch, etc.). Never raises.
    """
    database_url = os.environ.get("DATABASE_URL", "").strip()
    if not database_url:
        # No DB configured — this is the expected production posture for
        # environments that haven't been wired up yet. Stay silent.
        return False

    columns = _TABLE_COLUMNS.get(table)
    if columns is None:
        log_debug(f"[analytics-db] unknown table: {table!r}")
        return False

    import json as _json

    values: list[Any] = []
    for col in columns:
        raw = event.get(col)
        if col == "payload":
            if raw is None:
                values.append(_json.dumps({}))
            elif isinstance(raw, str):
                values.append(raw)
            else:
                values.append(_json.dumps(raw, default=str))
        else:
            values.append(None if raw is None else str(raw))

    placeholders = ", ".join(["%s"] * len(columns))
    col_list = ", ".join(columns)
    sql = (
        f"INSERT INTO analytics.{table} ({col_list}) VALUES ({placeholders})"
    )

    conn = None
    try:
        conn = _connect(database_url)
        try:
            with conn.cursor() as cur:
                cur.execute(sql, values)
            conn.commit()
        finally:
            try:
                conn.close()
            except Exception:
                pass
        return True
    except Exception as e:
        log_debug(f"[analytics-db] insert into analytics.{table} skipped: {e}")
        return False