#!/usr/bin/env python3
"""Unit tests for the curation/routing/validation scripts.

Covers:
  - filter_curation: routing rules (state-based, no classification)
  - list_curate_candidates: filter logic (summarized, stale monitoring, batch size)
  - validate_curate_output: state transition application + idempotency
  - validate_spec_output: spec file existence check + idempotency
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import contextmanager, redirect_stdout
from pathlib import Path
from unittest.mock import patch

WORKFLOW_DIR = os.path.join(
    os.path.dirname(__file__), "..", "agents", "workflows", "bookmark"
)
sys.path.insert(0, WORKFLOW_DIR)

import common
import filter_curation
import list_curate_candidates
import validate_curate_output
import validate_spec_output


@contextmanager
def clean_argv(*args):
    """Temporarily replace sys.argv so argparse in main() doesn't see pytest args.
    Pass extra args (e.g. '--json') to enable JSON output mode."""
    saved = sys.argv
    sys.argv = ["script", *args]
    try:
        yield
    finally:
        sys.argv = saved


def _capture(fn) -> str:
    buf = io.StringIO()
    with clean_argv("--json"), redirect_stdout(buf):
        fn()
    return buf.getvalue().strip()


def _load_state(state_path: Path, items: dict) -> None:
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(
        json.dumps({"updatedAt": "2026-06-12T00:00:00+00:00", "items": items}, indent=2)
    )


class AssessUsefulnessRouteTests(unittest.TestCase):
    """The router is pure: reviewStatus + bookkeeping → bucket."""

    @staticmethod
    def _state_item(**overrides):
        item = {
            "bookmarkKey": "k1",
            "reviewStatus": "summarized",
            "title": "test",
        }
        item.update(overrides)
        return item

    def test_queued_for_spec_goes_to_implement(self):
        self.assertEqual(
            filter_curation.route(
                {"bookmarkKey": "k1"},
                self._state_item(reviewStatus="queued_for_spec"),
            ),
            "implement",
        )

    def test_spec_created_goes_to_implement(self):
        self.assertEqual(
            filter_curation.route(
                {"bookmarkKey": "k1"},
                self._state_item(reviewStatus="spec_created"),
            ),
            "implement",
        )

    def test_monitoring_goes_to_monitoring(self):
        self.assertEqual(
            filter_curation.route(
                {"bookmarkKey": "k1"},
                self._state_item(reviewStatus="monitoring"),
            ),
            "monitoring",
        )

    def test_summarized_with_no_spec_work_goes_to_reviewed(self):
        """Newly summarized items haven't been curated yet — heartbeat curate
        will pick them up and turn them into queued_for_spec."""
        self.assertEqual(
            filter_curation.route(
                {"bookmarkKey": "k1"},
                self._state_item(reviewStatus="summarized"),
            ),
            "reviewed",
        )

    def test_reviewed_terminal_stays_reviewed(self):
        for status in ("tasked", "approval_pending", "revision_staged"):
            with self.subTest(status=status):
                self.assertEqual(
                    filter_curation.route(
                        {"bookmarkKey": "k1"},
                        self._state_item(reviewStatus=status),
                    ),
                    "reviewed",
                )

    def test_declined_stays_reviewed_even_with_spec_proposals(self):
        """Tom said no — recovery branch must not re-implement a declined item."""
        self.assertEqual(
            filter_curation.route(
                {"bookmarkKey": "k1"},
                self._state_item(
                    reviewStatus="declined",
                    specProposals=[{"title": "old spec"}],
                ),
            ),
            "reviewed",
        )

    def test_tasked_stays_reviewed_even_with_spec_proposals(self):
        """Tasks already created — work is in flight, don't re-implement."""
        self.assertEqual(
            filter_curation.route(
                {"bookmarkKey": "k1"},
                self._state_item(
                    reviewStatus="tasked",
                    specProposals=[{"title": "old spec"}],
                    taskIds=["task-1"],
                ),
            ),
            "reviewed",
        )

    def test_spec_proposals_without_tasks_is_recovery_implement(self):
        """Spec exists, never became tasks, status is not terminal → implement."""
        self.assertEqual(
            filter_curation.route(
                {"bookmarkKey": "k1"},
                self._state_item(
                    reviewStatus="monitoring",  # unusual but possible
                    specProposals=[{"title": "spec"}],
                ),
            ),
            "implement",
        )

    def test_classification_is_ignored(self):
        """Old pipeline wrote analysis.classification. The new router must
        ignore it — otherwise it would silently misroute new items that
        have no classification field."""
        item = self._state_item(
            reviewStatus="summarized",  # not in IMPLEMENT_STATUSES
            analysis={"classification": "implement"},  # old signal
        )
        self.assertEqual(
            filter_curation.route({"bookmarkKey": "k1"}, item),
            "reviewed",
        )

    def test_review_status_in_item_wins_over_state(self):
        """The summary item's reviewStatus (if present) takes precedence."""
        self.assertEqual(
            filter_curation.route(
                {"bookmarkKey": "k1", "reviewStatus": "queued_for_spec"},
                self._state_item(reviewStatus="monitoring"),
            ),
            "implement",
        )


class ListCurateCandidatesTests(unittest.TestCase):
    """Filter logic for stale curate selection."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.root = Path(self.tempdir.name)
        self.state_path = self.root / "brain" / "state" / "bookmark-review-state.json"
        self.no_focus = self.root / "no-focus-config.json"

    def _run_with_state(self) -> dict:
        with patch.object(common, "STATE_PATH", self.state_path), \
             patch.object(list_curate_candidates, "STATE_PATH", self.state_path), \
             patch.object(list_curate_candidates, "WORKSPACE", self.root), \
             patch.object(
                 list_curate_candidates,
                 "FOCUS_CONFIG_PATH",
                 self.no_focus,
             ):
            return json.loads(_capture(list_curate_candidates.main))

    def test_picks_summarized_items(self):
        _load_state(
            self.state_path,
            {
                "k1": {
                    "bookmarkKey": "k1",
                    "title": "new",
                    "topic": "brain",
                    "reviewStatus": "summarized",
                    "summary": {"headline": "h"},
                },
            },
        )
        payload = self._run_with_state()
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["batch"][0]["bookmarkKey"], "k1")
        self.assertEqual(payload["remaining"], 0)

    def test_skips_monitoring_when_fresh(self):
        from datetime import datetime, timezone, timedelta
        recent = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        _load_state(
            self.state_path,
            {
                "k1": {
                    "bookmarkKey": "k1",
                    "title": "fresh",
                    "topic": "brain",
                    "reviewStatus": "monitoring",
                    "lastCuratedAt": recent,
                },
            },
        )
        payload = self._run_with_state()
        self.assertEqual(payload["count"], 0)

    def test_picks_monitoring_when_stale(self):
        from datetime import datetime, timezone, timedelta
        old = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        _load_state(
            self.state_path,
            {
                "k1": {
                    "bookmarkKey": "k1",
                    "title": "stale",
                    "topic": "brain",
                    "reviewStatus": "monitoring",
                    "lastCuratedAt": old,
                },
            },
        )
        payload = self._run_with_state()
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["batch"][0]["bookmarkKey"], "k1")

    def test_picks_monitoring_with_no_last_curated(self):
        """Old items predating recurationDays tracking are always picked up."""
        _load_state(
            self.state_path,
            {
                "k1": {
                    "bookmarkKey": "k1",
                    "title": "ancient",
                    "topic": "brain",
                    "reviewStatus": "monitoring",
                    # no lastCuratedAt
                },
            },
        )
        payload = self._run_with_state()
        self.assertEqual(payload["count"], 1)

    def test_respects_batch_size(self):
        from datetime import datetime, timezone, timedelta
        old = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        items = {
            f"k{i}": {
                "bookmarkKey": f"k{i}",
                "title": f"item {i}",
                "topic": "brain",
                "reviewStatus": "monitoring",
                "lastCuratedAt": old,
            }
            for i in range(10)
        }
        _load_state(self.state_path, items)
        payload = self._run_with_state()
        self.assertEqual(payload["count"], 5)  # default batch size
        self.assertEqual(payload["remaining"], 5)

    def test_skips_terminal_statuses(self):
        _load_state(
            self.state_path,
            {
                "k1": {
                    "bookmarkKey": "k1",
                    "title": "tasked",
                    "topic": "brain",
                    "reviewStatus": "tasked",
                },
                "k2": {
                    "bookmarkKey": "k2",
                    "title": "spec_created",
                    "topic": "brain",
                    "reviewStatus": "spec_created",
                },
            },
        )
        payload = self._run_with_state()
        self.assertEqual(payload["count"], 0)


class ValidateCurateOutputTests(unittest.TestCase):
    """Apply curate decisions to state. Idempotent. Safe on bad input."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.root = Path(self.tempdir.name)
        self.state_path = self.root / "brain" / "state" / "bookmark-review-state.json"
        self.transitions_path = self.state_path.with_name("bookmark-transitions.jsonl")
        self.output_path = self.root / "brain" / "state" / "curate-output.json"
        self.state_root = self.state_path.parent

    def _write_artifact(self, decisions, errors=None, config=None):
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        artifact = {
            "producedAt": "2026-06-12T00:00:00+00:00",
            "config": config or {"activeTopics": ["brain"], "threshold": 7},
            "processed": len(decisions),
            "remaining": 0,
            "decisions": decisions,
            "errors": errors or [],
        }
        self.output_path.write_text(json.dumps(artifact, indent=2))

    def _run(self) -> dict:
        with patch.object(common, "STATE_PATH", self.state_path), \
             patch.object(common, "STATE_ROOT", self.state_root), \
             patch.object(common, "TRANSITIONS_PATH", self.transitions_path), \
             patch.object(validate_curate_output, "DEFAULT_OUTPUT", self.output_path), \
             patch.object(validate_curate_output, "STATE_PATH", self.state_path), \
             patch.object(validate_curate_output, "STATE_ROOT", self.state_root):
            return json.loads(_capture(validate_curate_output.main))

    def test_applies_queued_for_spec(self):
        _load_state(
            self.state_path,
            {"k1": {"bookmarkKey": "k1", "reviewStatus": "summarized"}},
        )
        self._write_artifact([
            {
                "bookmarkKey": "k1",
                "previousStatus": "summarized",
                "newStatus": "queued_for_spec",
                "primaryScore": 8.0,
                "primaryTopic": "brain",
                "relevanceScores": [],
                "approvalTopic": "brain",
                "lastCuratedAt": "2026-06-12T00:00:00+00:00",
                "reason": "relevance=8.0",
            }
        ])
        out = self._run()
        self.assertEqual(len(out["applied"]), 1)
        self.assertEqual(out["applied"][0]["bookmarkKey"], "k1")
        state = json.loads(self.state_path.read_text())
        item = state["items"]["k1"]
        self.assertEqual(item["reviewStatus"], "queued_for_spec")
        self.assertEqual(item["approvalTopic"], "brain")
        self.assertEqual(item["relevanceScore"], 8.0)
        self.assertEqual(item["relevanceTopic"], "brain")
        # Artifact renamed
        self.assertFalse(self.output_path.exists())
        self.assertTrue(self.output_path.with_suffix(".json.processed").exists())

    def test_applies_monitoring(self):
        _load_state(
            self.state_path,
            {"k1": {"bookmarkKey": "k1", "reviewStatus": "summarized"}},
        )
        self._write_artifact([
            {
                "bookmarkKey": "k1",
                "previousStatus": "summarized",
                "newStatus": "monitoring",
                "primaryScore": 3.0,
                "primaryTopic": "brain",
                "relevanceScores": [],
                "approvalTopic": None,
                "lastCuratedAt": "2026-06-12T00:00:00+00:00",
                "reason": "relevance=3.0",
            }
        ])
        out = self._run()
        self.assertEqual(len(out["applied"]), 1)
        state = json.loads(self.state_path.read_text())
        self.assertEqual(state["items"]["k1"]["reviewStatus"], "monitoring")
        self.assertNotIn("approvalTopic", state["items"]["k1"])

    def test_skips_when_already_in_target_state(self):
        _load_state(
            self.state_path,
            {"k1": {"bookmarkKey": "k1", "reviewStatus": "monitoring"}},
        )
        self._write_artifact([
            {
                "bookmarkKey": "k1",
                "previousStatus": "monitoring",
                "newStatus": "monitoring",
                "primaryScore": 3.0,
                "primaryTopic": "brain",
                "relevanceScores": [],
                "lastCuratedAt": "2026-06-12T00:00:00+00:00",
                "reason": "relevance=3.0",
            }
        ])
        out = self._run()
        self.assertEqual(len(out["applied"]), 0)
        self.assertEqual(len(out["skipped"]), 1)
        self.assertEqual(out["skipped"][0]["bookmarkKey"], "k1")

    def test_marks_invalid_decisions(self):
        _load_state(
            self.state_path,
            {"k1": {"bookmarkKey": "k1", "reviewStatus": "summarized"}},
        )
        self._write_artifact([
            {
                "bookmarkKey": "k1",
                "newStatus": "something_else",  # invalid
                "primaryScore": 5.0,
                "primaryTopic": "brain",
                "lastCuratedAt": "2026-06-12T00:00:00+00:00",
            }
        ])
        out = self._run()
        self.assertEqual(len(out["invalid"]), 1)
        state = json.loads(self.state_path.read_text())
        self.assertEqual(state["items"]["k1"]["reviewStatus"], "summarized")

    def test_no_artifact_is_noop(self):
        out = self._run()
        self.assertEqual(out["applied"], [])
        self.assertEqual(out["skipped"], [])

    def test_malformed_json_returns_error(self):
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        self.output_path.write_text("{ not valid json")
        out = self._run()
        self.assertFalse(out["ok"])
        self.assertIn("not valid JSON", out["error"])

    def test_writes_transition_log(self):
        _load_state(
            self.state_path,
            {"k1": {"bookmarkKey": "k1", "reviewStatus": "summarized"}},
        )
        self._write_artifact([
            {
                "bookmarkKey": "k1",
                "previousStatus": "summarized",
                "newStatus": "queued_for_spec",
                "primaryScore": 8.0,
                "primaryTopic": "brain",
                "approvalTopic": "brain",
                "lastCuratedAt": "2026-06-12T00:00:00+00:00",
                "reason": "relevance=8.0",
            }
        ])
        self._run()
        self.assertTrue(self.transitions_path.exists())
        entries = [
            json.loads(line)
            for line in self.transitions_path.read_text().splitlines()
            if line.strip()
        ]
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["from"], "summarized")
        self.assertEqual(entries[0]["to"], "queued_for_spec")


class ValidateSpecOutputTests(unittest.TestCase):
    """Apply spec decisions to state. Verifies spec files exist. Idempotent."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.root = Path(self.tempdir.name)
        self.state_path = self.root / "brain" / "state" / "bookmark-review-state.json"
        self.transitions_path = self.state_path.with_name("bookmark-transitions.jsonl")
        self.output_path = self.root / "brain" / "state" / "spec-output.json"
        self.state_root = self.state_path.parent

    def _write_artifact(self, entries):
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        self.output_path.write_text(
            json.dumps(
                {"producedAt": "2026-06-12T00:00:00+00:00", "entries": entries},
                indent=2,
            )
        )

    def _make_spec(self, rel_path: str) -> Path:
        spec = self.root / rel_path
        spec.parent.mkdir(parents=True, exist_ok=True)
        spec.write_text("# Spec - test\n")
        return spec

    def _run(self) -> dict:
        with patch.object(common, "STATE_PATH", self.state_path), \
             patch.object(common, "STATE_ROOT", self.state_root), \
             patch.object(common, "TRANSITIONS_PATH", self.transitions_path), \
             patch.object(common, "WORKSPACE", self.root), \
             patch.object(validate_spec_output, "DEFAULT_OUTPUT", self.output_path), \
             patch.object(validate_spec_output, "STATE_PATH", self.state_path), \
             patch.object(validate_spec_output, "STATE_ROOT", self.state_root), \
             patch.object(validate_spec_output, "WORKSPACE", self.root):
            return json.loads(_capture(validate_spec_output.main))

    def test_applies_spec_created_when_file_exists(self):
        _load_state(
            self.state_path,
            {"k1": {"bookmarkKey": "k1", "reviewStatus": "spec_requested"}},
        )
        self._make_spec("brain/spec.md")
        self._write_artifact([
            {
                "bookmarkKey": "k1",
                "reviewDoc": "brain/reviews/k1.md",
                "requestType": "new",
                "specs": [
                    {
                        "title": "Spec",
                        "specDoc": "brain/spec.md",
                        "proposedTasks": [
                            {
                                "title": "task 1",
                                "priority": "high",
                                "summary": "s",
                                "deliverable": "d",
                                "acceptanceCriteria": ["ac"],
                            }
                        ],
                    }
                ],
            }
        ])
        out = self._run()
        self.assertEqual(len(out["applied"]), 1)
        state = json.loads(self.state_path.read_text())
        self.assertEqual(state["items"]["k1"]["reviewStatus"], "spec_created")
        self.assertEqual(state["items"]["k1"]["specDocs"], ["brain/spec.md"])
        self.assertFalse(self.output_path.exists())
        self.assertTrue(self.output_path.with_suffix(".json.processed").exists())

    def test_marks_invalid_when_spec_file_missing(self):
        _load_state(
            self.state_path,
            {"k1": {"bookmarkKey": "k1", "reviewStatus": "spec_requested"}},
        )
        self._write_artifact([
            {
                "bookmarkKey": "k1",
                "reviewDoc": "brain/reviews/k1.md",
                "requestType": "new",
                "specs": [
                    {
                        "title": "Spec",
                        "specDoc": "brain/specs/does/not/exist.md",
                        "proposedTasks": [
                            {
                                "title": "task",
                                "priority": "high",
                                "summary": "s",
                                "deliverable": "d",
                                "acceptanceCriteria": ["ac"],
                            }
                        ],
                    }
                ],
            }
        ])
        out = self._run()
        self.assertEqual(len(out["invalid"]), 1)
        self.assertIn("missing on disk", out["invalid"][0]["errors"][0])
        state = json.loads(self.state_path.read_text())
        self.assertEqual(state["items"]["k1"]["reviewStatus"], "spec_requested")

    def test_marks_invalid_on_bad_priority(self):
        _load_state(
            self.state_path,
            {"k1": {"bookmarkKey": "k1", "reviewStatus": "spec_requested"}},
        )
        self._make_spec("brain/spec.md")
        self._write_artifact([
            {
                "bookmarkKey": "k1",
                "reviewDoc": "brain/reviews/k1.md",
                "requestType": "new",
                "specs": [
                    {
                        "title": "Spec",
                        "specDoc": "brain/spec.md",
                        "proposedTasks": [
                            {
                                "title": "task",
                                "priority": "URGENT",  # invalid
                                "summary": "s",
                                "deliverable": "d",
                                "acceptanceCriteria": ["ac"],
                            }
                        ],
                    }
                ],
            }
        ])
        out = self._run()
        self.assertEqual(len(out["invalid"]), 1)
        self.assertIn("priority", out["invalid"][0]["errors"][0])

    def test_skips_already_spec_created(self):
        _load_state(
            self.state_path,
            {
                "k1": {
                    "bookmarkKey": "k1",
                    "reviewStatus": "spec_created",
                    "specDocs": ["brain/spec.md"],
                }
            },
        )
        self._make_spec("brain/spec.md")
        self._write_artifact([
            {
                "bookmarkKey": "k1",
                "reviewDoc": "brain/reviews/k1.md",
                "requestType": "new",
                "specs": [
                    {
                        "title": "Spec",
                        "specDoc": "brain/spec.md",
                        "proposedTasks": [
                            {
                                "title": "task",
                                "priority": "high",
                                "summary": "s",
                                "deliverable": "d",
                                "acceptanceCriteria": ["ac"],
                            }
                        ],
                    }
                ],
            }
        ])
        out = self._run()
        self.assertEqual(len(out["skipped"]), 1)

    def test_no_artifact_is_noop(self):
        out = self._run()
        self.assertEqual(out["applied"], [])
        self.assertEqual(out["skipped"], [])

    def test_malformed_json_returns_error(self):
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        self.output_path.write_text("{ not valid")
        out = self._run()
        self.assertFalse(out["ok"])
        self.assertIn("not valid JSON", out["error"])


if __name__ == "__main__":
    unittest.main()
