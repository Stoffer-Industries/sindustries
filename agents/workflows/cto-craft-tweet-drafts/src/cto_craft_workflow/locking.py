"""PostgreSQL advisory lock for the CTO Craft workflow.

The lock prevents two overlapping weekly invocations from doing duplicate
model work and sending duplicate notifications. It is **not** the product
idempotency guarantee — that lives in the Content Scheduler's
``(source, sourceRef)`` unique constraint. The lock is a coordination
mechanism, not a transactional one.

A second invocation that finds the lock held exits successfully with a
structured ``already_running`` no-op. The lock is released when the
finally block runs (process exit, exception, or explicit release).

The lock key is a stable 64-bit signed integer derived from a fixed
namespace string. PostgreSQL's ``pg_try_advisory_lock(bigint)`` accepts
only one bigint at a time, so we use two-argument form with a namespace
and the workflow's own stable key.
"""

from __future__ import annotations

import hashlib
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator


LOCK_NAMESPACE = 0x43_54_4F_43  # 'CTOC' in ASCII big-endian
LOCK_KEY = 0x54_57_45_54  # 'TWET' — CTO Craft TWEET draft


class LockError(Exception):
    """Raised when the lock cannot be acquired or held."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class LockHandle:
    """Opaque handle returned by :func:`acquire_workflow_lock`."""

    connection: object
    acquired: bool


def _stable_namespace_key(component: str) -> int:
    """Map a stable component string into a 63-bit signed integer.

    PostgreSQL's ``pg_try_advisory_lock(key bigint)`` takes a single
    signed 64-bit integer. We hash the component into a positive 64-bit
    value and then collapse it into a signed 63-bit range to be safe
    across platforms.
    """

    digest = hashlib.sha256(component.encode("utf-8")).digest()
    value = int.from_bytes(digest[:8], byteorder="big", signed=False)
    # Mask to signed 63-bit range (PostgreSQL's ``bigint`` is signed 64-bit
    # but we want a positive, safe key).
    return value & 0x7FFF_FFFF_FFFF_FFFF


def _check_connection(conn) -> None:
    if conn is None:
        raise LockError("LOCK_DB_UNAVAILABLE", "no database connection available for lock")


@contextmanager
def workflow_lock(
    connection,
    *,
    wait: bool = False,
) -> Iterator[LockHandle]:
    """Context manager that holds the CTO Craft workflow lock.

    Usage::

        with workflow_lock(conn) as handle:
            if not handle.acquired:
                return {"outcome": "already_running"}

    ``wait=False`` is the default and matches the documented design:
    overlapping invocations exit cleanly instead of queueing.
    """

    _check_connection(connection)
    if wait:
        sql = "SELECT pg_advisory_lock(%s, %s)"
    else:
        sql = "SELECT pg_try_advisory_lock(%s, %s)"

    cursor = connection.cursor()
    try:
        cursor.execute(sql, (LOCK_NAMESPACE, LOCK_KEY))
        row = cursor.fetchone()
        if wait:
            acquired = True
        else:
            acquired = bool(row and row[0])
        yield LockHandle(connection=connection, acquired=acquired)
    finally:
        try:
            if wait:
                cursor.execute("SELECT pg_advisory_unlock(%s, %s)", (LOCK_NAMESPACE, LOCK_KEY))
            else:
                cursor.execute("SELECT pg_advisory_unlock(%s, %s)", (LOCK_NAMESPACE, LOCK_KEY))
        except Exception:
            # Best-effort release; the connection will close on exit.
            pass
        try:
            cursor.close()
        except Exception:
            pass


__all__ = [
    "LockError",
    "LockHandle",
    "LOCK_NAMESPACE",
    "LOCK_KEY",
    "workflow_lock",
    "_stable_namespace_key",
]
