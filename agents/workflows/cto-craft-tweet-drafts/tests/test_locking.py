"""Tests for the CTO Craft workflow lock context manager.

The non-obvious contract under test: when ``pg_try_advisory_lock`` reports
the lock is already held (a concurrent run), the ``finally`` block must
NOT call ``pg_advisory_unlock``. Releasing a lock you never held emits a
PostgreSQL ``WARNING: you don't own a lock of type ExclusiveLock`` and
hides the real contended-run log line.
"""

from __future__ import annotations

from cto_craft_workflow.locking import LOCK_KEY, LOCK_NAMESPACE, workflow_lock


class _RecordingCursor:
    """Cursor stub that records every executed SQL statement.

    ``lock_returned`` controls the row returned for ``pg_try_advisory_lock``:
    - True → row with `[True]` so the caller treats the lock as acquired.
    - False → row with `[False]` so the caller treats the lock as already held.
    """

    def __init__(self, lock_returned: bool) -> None:
        self._lock_returned = lock_returned
        self.executed: list[tuple[str, tuple]] = []
        self.closed = False

    def execute(self, sql: str, params: tuple = ()) -> None:
        self.executed.append((sql, params))

    def fetchone(self) -> tuple:
        return (self._lock_returned,)

    def close(self) -> None:
        self.closed = True


class _FakeConnection:
    def __init__(self, cursor: _RecordingCursor) -> None:
        self._cursor = cursor

    def cursor(self) -> _RecordingCursor:
        return self._cursor


def test_contended_run_does_not_call_unlock() -> None:
    """A contended run (lock already held) must skip ``pg_advisory_unlock``.

    This is the W34 T3.1 audit scenario: ``pg_try_advisory_lock`` returns
    False, the handle is yielded with ``acquired=False``, and the finally
    block must not attempt to release a lock the caller never held.
    """

    cursor = _RecordingCursor(lock_returned=False)
    conn = _FakeConnection(cursor)

    with workflow_lock(conn, wait=False) as handle:
        assert handle.acquired is False

    executed_sqls = [sql for sql, _ in cursor.executed]
    assert "SELECT pg_try_advisory_lock(%s, %s)" in executed_sqls
    assert "SELECT pg_advisory_unlock(%s, %s)" not in executed_sqls
    assert cursor.closed is True


def test_acquired_run_releases_lock() -> None:
    """When the lock is acquired, the finally block must release it."""

    cursor = _RecordingCursor(lock_returned=True)
    conn = _FakeConnection(cursor)

    with workflow_lock(conn, wait=False) as handle:
        assert handle.acquired is True

    executed_sqls = [sql for sql, _ in cursor.executed]
    assert "SELECT pg_try_advisory_lock(%s, %s)" in executed_sqls
    assert "SELECT pg_advisory_unlock(%s, %s)" in executed_sqls
    assert cursor.closed is True


def test_wait_mode_presumes_acquired_and_releases() -> None:
    """``wait=True`` calls blocking ``pg_advisory_lock`` and treats the lock
    as acquired; the finally block must always release it."""

    cursor = _RecordingCursor(lock_returned=False)  # value irrelevant for wait mode
    conn = _FakeConnection(cursor)

    with workflow_lock(conn, wait=True) as handle:
        assert handle.acquired is True

    executed_sqls = [sql for sql, _ in cursor.executed]
    assert "SELECT pg_advisory_lock(%s, %s)" in executed_sqls
    assert "SELECT pg_advisory_unlock(%s, %s)" in executed_sqls


def test_lock_uses_constants_namespace_and_key() -> None:
    """Lock acquisition must use the module-level LOCK_NAMESPACE/LOCK_KEY."""

    cursor = _RecordingCursor(lock_returned=True)
    conn = _FakeConnection(cursor)

    with workflow_lock(conn, wait=False):
        pass

    acquire_calls = [
        params for sql, params in cursor.executed if "pg_try_advisory_lock" in sql
    ]
    assert acquire_calls == [(LOCK_NAMESPACE, LOCK_KEY)]
    unlock_calls = [
        params for sql, params in cursor.executed if "pg_advisory_unlock" in sql
    ]
    assert unlock_calls == [(LOCK_NAMESPACE, LOCK_KEY)]


def test_none_connection_raises_lock_error() -> None:
    """``None`` connection is rejected before any SQL is executed."""

    raised = False
    try:
        with workflow_lock(None, wait=False):
            pass
    except Exception as exc:  # noqa: BLE001
        raised = True
        assert exc.code == "LOCK_DB_UNAVAILABLE"  # type: ignore[attr-defined]

    assert raised
