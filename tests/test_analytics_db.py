"""Unit tests for the best-effort Postgres analytics mirror helper.

Covers the three documented contracts:
1. ``DATABASE_URL`` unset → silent no-op, returns ``False``.
2. ``DATABASE_URL`` set but DB unreachable → returns ``False``, logs a warning,
   does not raise.
3. ``log_transition()`` continues to write the JSONL even when the DB helper
   fails (graceful degradation; AC6).
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(
    0, os.path.join(os.path.dirname(__file__), "..", "agents", "workflows", "bookmarks", "scripts")
)

import analytics_db  # noqa: E402
import common  # noqa: E402


class AnalyticsDbEnvUnsetTests(unittest.TestCase):
    def setUp(self):
        # Ensure DATABASE_URL is not set so the helper short-circuits.
        self._saved = os.environ.pop("DATABASE_URL", None)

    def tearDown(self):
        if self._saved is not None:
            os.environ["DATABASE_URL"] = self._saved

    def test_returns_false_when_env_unset(self):
        result = analytics_db.insert_transition(
            {"bookmark_key": "x", "from_status": "summarized", "to_status": "spec_created"}
        )
        self.assertFalse(result)

    def test_returns_false_when_env_empty(self):
        os.environ["DATABASE_URL"] = ""
        self.assertFalse(
            analytics_db.insert_transition({"bookmark_key": "x", "to_status": "spec_created"})
        )

    def test_returns_false_when_env_whitespace(self):
        os.environ["DATABASE_URL"] = "   "
        self.assertFalse(
            analytics_db.insert_transition({"bookmark_key": "x", "to_status": "spec_created"})
        )


class AnalyticsDbUnreachableTests(unittest.TestCase):
    def setUp(self):
        # Point at a port nothing should be listening on. Short connect_timeout
        # keeps the test fast.
        os.environ["DATABASE_URL"] = "postgresql://postgres:postgres@127.0.0.1:1/x"

    def tearDown(self):
        os.environ.pop("DATABASE_URL", None)

    def test_returns_false_on_unreachable_host(self):
        result = analytics_db.insert_transition(
            {"bookmark_key": "x", "from_status": "summarized", "to_status": "spec_created"}
        )
        self.assertFalse(result)

    def test_logs_warning_on_failure(self):
        # Patch the log_debug name as bound inside analytics_db (it's a local
        # import, not a module attribute lookup at call time).
        with patch("analytics_db.log_debug") as mock_log:
            analytics_db.insert_transition(
                {"bookmark_key": "x", "to_status": "spec_created"}
            )
        # log_debug must have been called at least once with the warning prefix.
        self.assertTrue(mock_log.called, "expected log_debug to be called on DB failure")
        call_args = [str(call.args[0]) for call in mock_log.call_args_list]
        self.assertTrue(
            any("analytics-db" in msg for msg in call_args),
            f"expected an [analytics-db] warning; got: {call_args}",
        )


class AnalyticsDbBadTableTests(unittest.TestCase):
    def setUp(self):
        os.environ["DATABASE_URL"] = "postgresql://postgres:postgres@127.0.0.1:1/x"

    def tearDown(self):
        os.environ.pop("DATABASE_URL", None)

    def test_unknown_table_returns_false(self):
        with patch("analytics_db.log_debug") as mock_log:
            result = analytics_db.insert_transition(
                {"x": "y"}, table="nonexistent_table"
            )
        self.assertFalse(result)
        self.assertTrue(mock_log.called)


class LogTransitionDegradationTests(unittest.TestCase):
    """AC6 — the JSONL append must survive a DB-mirror failure."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.transitions_path = self.root / "brain" / "state" / "bookmark-transitions.jsonl"
        # DATABASE_URL points at an unreachable host so the helper returns False
        # (and exercises the failure path inside log_transition).
        os.environ["DATABASE_URL"] = "postgresql://postgres:postgres@127.0.0.1:1/x"

    def tearDown(self):
        self.tempdir.cleanup()
        os.environ.pop("DATABASE_URL", None)

    def test_jsonl_written_when_db_fails(self):
        common.log_transition(
            "abc",
            "summarized",
            "spec_created",
            "generated 1 spec doc(s)",
            transitions_path=self.transitions_path,
        )

        rows = [
            json.loads(line)
            for line in self.transitions_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        self.assertEqual(len(rows), 1, "JSONL append must succeed even when DB fails")
        self.assertEqual(rows[0]["key"], "abc")
        self.assertEqual(rows[0]["from"], "summarized")
        self.assertEqual(rows[0]["to"], "spec_created")
        self.assertEqual(rows[0]["reason"], "generated 1 spec doc(s)")


class AnalyticsDbSchemaTests(unittest.TestCase):
    """Schema sanity check — the helper maps known columns only."""

    def test_bookmark_transitions_columns_match_migration(self):
        # If a column is added in the migration, it must also be added in
        # analytics_db._TABLE_COLUMNS. This test fails loudly on drift.
        expected = {
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
        }
        self.assertEqual(set(analytics_db._TABLE_COLUMNS["bookmark_transitions"]), expected)

    def test_task_transitions_columns_match_migration(self):
        expected = {
            "task_id",
            "bookmark_key",
            "from_status",
            "to_status",
            "actor",
            "source",
            "payload",
        }
        self.assertEqual(set(analytics_db._TABLE_COLUMNS["task_transitions"]), expected)


if __name__ == "__main__":
    unittest.main()