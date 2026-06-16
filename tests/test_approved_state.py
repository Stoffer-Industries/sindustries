#!/usr/bin/env python3
"""Focused tests for the `approved` terminal state in lobster_resolve_spec_request.

These tests run in isolation so they don't trip over the (pre-existing) rot
in test_bookmark_workflow.py. They cover the four outcomes of the resolver:

  - approve + no created tasks  -> `approved`  (NEW — was `spec_created`)
  - approve + created tasks     -> `tasked`
  - decline                    -> `declined`
  - already resolved (skipped)  -> unchanged
"""
from __future__ import annotations

import importlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "agents" / "workflows" / "bookmark"))
sys.path.insert(0, str(REPO / "agents" / "skills" / "tasks-api-ops"))

import common  # noqa: E402
import lobster_resolve_spec_request as resolve_spec_request  # noqa: E402


class ApprovedStateTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.state_path = self.root / "brain" / "state" / "bookmark-review-state.json"
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.bookmark = {
            "bookmarkKey": "abc123bookmark",
            "path": "brain/bookmarks/x/test.md",
            "topic": "infra",
            "source": "x",
            "title": "Test bookmark",
        }

    def tearDown(self):
        self.tempdir.cleanup()

    def _seed(self, **overrides):
        state = common.state_template()
        item = {
            "bookmarkKey": self.bookmark["bookmarkKey"],
            "path": self.bookmark["path"],
            "topic": self.bookmark["topic"],
            "source": self.bookmark["source"],
            "title": self.bookmark["title"],
            "reviewStatus": "approval_pending",
            "approvalTopic": "infra",
            "specDocs": ["brain/specs/infra/test-abc123bookmark.md"],
            "taskIds": [],
        }
        item.update(overrides)
        state["items"][self.bookmark["bookmarkKey"]] = item
        common.save_state(state, self.state_path)

    def _run(self, decision: str, approvals: list, created: list) -> dict:
        stdin = io.StringIO(json.dumps({"approvals": approvals, "created": created}))
        stdout = io.StringIO()
        with patch.object(resolve_spec_request, "STATE_PATH", self.state_path):
            with patch("sys.stdin", stdin), patch("sys.stdout", stdout), \
                 patch.object(sys, "argv", ["lobster_resolve_spec_request.py", "--decision", decision, "--json"]):
                rc = resolve_spec_request.main()
        self.assertEqual(rc, 0)
        return json.loads(stdout.getvalue())

    def _reload(self) -> dict:
        return common.load_state(self.state_path)["items"][self.bookmark["bookmarkKey"]]

    def test_approve_no_proposals_marks_approved(self):
        """The new state: Tom approves a spec that produced no tasks."""
        self._seed()
        payload = self._run("approve", [{
            "topic": "infra",
            "items": [{"bookmarkKey": self.bookmark["bookmarkKey"]}],
        }], created=[])

        self.assertEqual(payload["decision"], "approved")
        self.assertEqual(payload["resolved"][0]["items"][0]["reviewStatus"], "approved")

        item = self._reload()
        self.assertEqual(item["approvalStatus"], "approved")
        self.assertEqual(item["reviewStatus"], "approved")
        self.assertEqual(item["taskIds"], [])
        self.assertIsNotNone(item.get("approvalResolvedAt"))
        self.assertIsNone(item.get("approvalResumeToken"))

    def test_approve_with_proposals_marks_tasked(self):
        """The existing path: approved + work in flight."""
        self._seed()
        payload = self._run("approve", [{
            "topic": "infra",
            "items": [{"bookmarkKey": self.bookmark["bookmarkKey"]}],
        }], created=[{
            "bookmarkKey": self.bookmark["bookmarkKey"],
            "taskId": "task-001",
        }])

        self.assertEqual(payload["decision"], "approved")
        self.assertEqual(payload["resolved"][0]["items"][0]["reviewStatus"], "tasked")

        item = self._reload()
        self.assertEqual(item["approvalStatus"], "approved")
        self.assertEqual(item["reviewStatus"], "tasked")
        self.assertEqual(item["taskIds"], ["task-001"])

    def test_decline_marks_declined(self):
        self._seed()
        payload = self._run("decline", [{
            "topic": "infra",
            "items": [{"bookmarkKey": self.bookmark["bookmarkKey"]}],
        }], created=[])

        self.assertEqual(payload["decision"], "declined")
        item = self._reload()
        self.assertEqual(item["approvalStatus"], "declined")
        self.assertEqual(item["reviewStatus"], "declined")

    def test_already_resolved_item_is_skipped(self):
        """An item no longer in approval_pending must not be re-touched."""
        self._seed(reviewStatus="approved")
        payload = self._run("approve", [{
            "topic": "infra",
            "items": [{"bookmarkKey": self.bookmark["bookmarkKey"]}],
        }], created=[])

        self.assertEqual(len(payload["skipped"]), 1)
        self.assertEqual(payload["skipped"][0]["reason"], "item is not currently approval_pending")
        item = self._reload()
        self.assertEqual(item["reviewStatus"], "approved")  # unchanged


if __name__ == "__main__":
    unittest.main()
