from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "agents/workflows/bookmark"))

import check_transitions
import common


class BookmarkTransitionTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.state_path = self.root / "brain" / "state" / "bookmark-review-state.json"
        self.transitions_path = self.root / "brain" / "state" / "bookmark-transitions.jsonl"

    def tearDown(self):
        self.tempdir.cleanup()

    def write_state(self, key: str, status: str, last_updated_at: str) -> None:
        state = common.state_template()
        state["items"][key] = {
            "bookmarkKey": key,
            "reviewStatus": status,
            "lastUpdatedAt": last_updated_at,
        }
        common.save_state(state, self.state_path)

    def test_log_transition_appends_jsonl(self):
        common.log_transition("abc", "pending", "reviewed", "classification=ignore", transitions_path=self.transitions_path)
        common.log_transition("abc", "reviewed", "spec_created", "generated 1 spec doc(s)", transitions_path=self.transitions_path)

        rows = [json.loads(line) for line in self.transitions_path.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["key"], "abc")
        self.assertEqual(rows[0]["from"], "pending")
        self.assertEqual(rows[0]["to"], "reviewed")
        self.assertEqual(rows[0]["reason"], "classification=ignore")
        self.assertIn("actor", rows[0])

    def test_missing_transition_history_is_warning_only(self):
        self.write_state("abc", "reviewed", "2026-06-04T09:00:00+00:00")

        result = check_transitions.check_state(self.state_path, self.transitions_path)

        self.assertTrue(result["ok"])
        self.assertEqual(result["missingTransitionHistory"][0]["key"], "abc")

    def test_state_newer_than_last_transition_is_drift(self):
        common.log_transition("abc", "pending", "reviewed", "classification=ignore", transitions_path=self.transitions_path)
        self.write_state("abc", "reviewed", "2999-01-01T00:00:00+00:00")

        result = check_transitions.check_state(self.state_path, self.transitions_path)

        self.assertFalse(result["ok"])
        self.assertEqual(result["drift"][0]["key"], "abc")


if __name__ == "__main__":
    unittest.main()
