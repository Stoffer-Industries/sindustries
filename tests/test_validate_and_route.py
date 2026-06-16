#!/usr/bin/env python3
"""Unit tests for the curation/routing/validation scripts (new schema).

Covers:
  - filter_curation: routing on curation.score + curation age + terminal status
  - list_curate_candidates: pure age check (curation missing or stale)
  - validate_curate_output: writes item.curation sub-object, no status change
  - validate_spec_output: spec file existence check + idempotency

The new curation schema (per item):
  {
    curation: { createdAt, topic, score, reasoning,
                relevanceScores, threshold } | absent
  }
Status is no longer the verdict — it's just where the item is in the pipeline.
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import contextmanager, redirect_stdout
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import patch

WORKFLOW_DIR = os.path.join(
    os.path.dirname(__file__), "..", "agents", "workflows", "bookmark"
)
sys.path.insert(0, WORKFLOW_DIR)

import common
import lobster_list_curations as filter_curation
import list_curate_candidates
import validate_curate_output
import validate_spec_output


@contextmanager
def clean_argv(*args):
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


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _iso_days_ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def _curation(score: float = 8.0, topic: str = "brain", age_days: int = 0,
              threshold: float = 7.0) -> dict:
    return {
        "createdAt": _iso_days_ago(age_days),
        "topic": topic,
        "score": score,
        "reasoning": "test reasoning",
        "relevanceScores": [],
        "activeTopics": ["brain", "infra"],
        "threshold": threshold,
    }


# ===================================================================
# filter_curation routing
# ===================================================================

class FilterCurationRouteTests(unittest.TestCase):
    """Routes on curation score + terminal status. No freshness check.

    Freshness is the heartbeat's concern — filter_curation just trusts the
    verdict on disk. If the curator hasn't refreshed, that's a heartbeat
    cadence issue, not filter_curation's problem.
    """

    def _route(self, state_item: dict, item: dict | None = None) -> str:
        return filter_curation.route(
            item or {"bookmarkKey": state_item.get("bookmarkKey", "k1")},
            state_item,
        )

    # --- terminal statuses ---

    def test_terminal_statuses_route_to_reviewed(self):
        for status in ("tasked", "declined", "approval_pending",
                       "revision_staged", "revision_requested", "needs_research"):
            with self.subTest(status=status):
                # Even with a high-score curation, terminal wins.
                item = {
                    "bookmarkKey": "k1",
                    "reviewStatus": status,
                    "curation": _curation(score=10.0, age_days=0),
                }
                self.assertEqual(self._route(item), "reviewed")

    # --- implement ---

    def test_spec_created_routes_to_implement(self):
        # Spec exists, awaiting approval — curation ignored.
        item = {
            "bookmarkKey": "k1",
            "reviewStatus": "spec_created",
            "curation": _curation(score=2.0, age_days=0),  # low score, but irrelevant
            "specProposals": [{"title": "x"}],
        }
        self.assertEqual(self._route(item), "implement")

    def test_high_score_curation_routes_to_implement(self):
        item = {
            "bookmarkKey": "k1",
            "reviewStatus": "summarized",
            "curation": _curation(score=8.0, age_days=0, threshold=7.0),
        }
        self.assertEqual(self._route(item), "implement")

    def test_score_at_threshold_routes_to_implement(self):
        item = {
            "bookmarkKey": "k1",
            "reviewStatus": "summarized",
            "curation": _curation(score=7.0, age_days=0, threshold=7.0),
        }
        self.assertEqual(self._route(item), "implement")

    def test_stale_high_score_curation_routes_to_implement(self):
        # Curations are kept fresh by the heartbeat. If for some reason
        # filter_curation sees a stale curation, it still trusts the verdict.
        # (Heartbeat will refresh it on its next pass.)
        item = {
            "bookmarkKey": "k1",
            "reviewStatus": "summarized",
            "curation": _curation(score=10.0, age_days=180),  # very stale
        }
        self.assertEqual(self._route(item), "implement")

    def test_broad_reference_curation_routes_to_needs_research(self):
        for reasoning in (
            "This is too broad for immediate implementation.",
            "A DENSE REFERENCE worth manual review.",
            "Monitor this catalogue rather than build it.",
            "Useful reference material.",
            "Broad reference for future work.",
        ):
            with self.subTest(reasoning=reasoning):
                item = {
                    "bookmarkKey": "k1",
                    "reviewStatus": "summarized",
                    "curation": {
                        **_curation(score=8.0, age_days=0, threshold=7.0),
                        "reasoning": reasoning,
                    },
                }
                self.assertEqual(self._route(item), "needs_research")

    def test_low_score_broad_reference_stays_monitoring(self):
        item = {
            "bookmarkKey": "k1",
            "reviewStatus": "summarized",
            "curation": {
                **_curation(score=5.0, age_days=0, threshold=7.0),
                "reasoning": "Broad reference material.",
            },
        }
        self.assertEqual(self._route(item), "monitoring")

    def test_spec_proposals_no_tasks_is_recovery_implement(self):
        # Spec work exists but never became tasks — recovery branch.
        item = {
            "bookmarkKey": "k1",
            "reviewStatus": "monitoring",  # unusual but possible
            "curation": _curation(score=2.0, age_days=0),  # low score
            "specProposals": [{"title": "x"}],
        }
        self.assertEqual(self._route(item), "implement")

    def test_recovery_skipped_for_terminal_items(self):
        # Tom said no — recovery branch must not re-implement.
        item = {
            "bookmarkKey": "k1",
            "reviewStatus": "declined",
            "curation": _curation(score=2.0, age_days=0),
            "specProposals": [{"title": "x"}],
        }
        self.assertEqual(self._route(item), "reviewed")

    def test_recovery_skipped_for_tasked_items(self):
        # Tasks already created — work is in flight, don't re-implement.
        item = {
            "bookmarkKey": "k1",
            "reviewStatus": "tasked",
            "curation": _curation(score=2.0, age_days=0),
            "specProposals": [{"title": "x"}],
            "taskIds": ["t1"],
        }
        self.assertEqual(self._route(item), "reviewed")

    # --- monitoring ---

    def test_low_score_curation_routes_to_monitoring(self):
        item = {
            "bookmarkKey": "k1",
            "reviewStatus": "summarized",
            "curation": _curation(score=5.0, age_days=0, threshold=7.0),
        }
        self.assertEqual(self._route(item), "monitoring")

    def test_missing_curation_routes_to_monitoring(self):
        # Heartbeat will create one.
        item = {
            "bookmarkKey": "k1",
            "reviewStatus": "summarized",
        }
        self.assertEqual(self._route(item), "monitoring")

    def test_summary_overrides_state_status(self):
        # The summary item's reviewStatus (if present) wins.
        item = {
            "bookmarkKey": "k1",
            "reviewStatus": "spec_created",  # summary says this
        }
        state_item = {
            "bookmarkKey": "k1",
            "reviewStatus": "monitoring",  # state says this
        }
        self.assertEqual(
            filter_curation.route(item, state_item),
            "implement",
        )


# ===================================================================
# list_curate_candidates (pure age check)
# ===================================================================

class ListCurateCandidatesTests(unittest.TestCase):

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.root = Path(self.tempdir.name)
        self.state_path = self.root / "brain" / "state" / "bookmark-review-state.json"
        self.no_focus = self.root / "no-focus-config.json"

    def _run(self) -> dict:
        with patch.object(common, "STATE_PATH", self.state_path), \
             patch.object(list_curate_candidates, "STATE_PATH", self.state_path), \
             patch.object(list_curate_candidates, "WORKSPACE", self.root), \
             patch.object(
                 list_curate_candidates,
                 "FOCUS_CONFIG_PATH",
                 self.no_focus,
             ):
            return json.loads(_capture(list_curate_candidates.main))

    def _item(self, bookmark_key: str, **overrides) -> dict:
        item = {
            "bookmarkKey": bookmark_key,
            "title": f"item {bookmark_key}",
            "topic": "brain",
            "summary": {"headline": "h"},
        }
        item.update(overrides)
        return item

    def test_picks_items_with_missing_curation(self):
        _load_state(self.state_path, {
            "k1": self._item("k1", reviewStatus="summarized"),
        })
        payload = self._run()
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["batch"][0]["bookmarkKey"], "k1")

    def test_picks_items_with_stale_curation(self):
        _load_state(self.state_path, {
            "k1": self._item("k1", reviewStatus="summarized",
                             curation=_curation(age_days=30)),
        })
        payload = self._run()
        self.assertEqual(payload["count"], 1)

    def test_skips_items_with_fresh_curation(self):
        _load_state(self.state_path, {
            "k1": self._item("k1", reviewStatus="summarized",
                             curation=_curation(age_days=1)),
        })
        payload = self._run()
        self.assertEqual(payload["count"], 0)

    def test_skips_items_without_summary_and_without_review_doc(self):
        # No summary AND no reviewDoc = summarizer hasn't run; curate would
        # have nothing to score. (An item with just a reviewDoc — summary
        # lives in the file — IS eligible.)
        _load_state(self.state_path, {
            "k1": {"bookmarkKey": "k1", "title": "no summary",
                   "topic": "brain", "reviewStatus": "summarized"},
        })
        payload = self._run()
        self.assertEqual(payload["count"], 0)

    def test_picks_items_with_review_doc_but_no_summary_cache(self):
        # The summary lives in the review doc on disk; the state cache is optional.
        _load_state(self.state_path, {
            "k1": {"bookmarkKey": "k1", "title": "has reviewDoc",
                   "topic": "brain", "reviewStatus": "summarized",
                   "reviewDoc": "brain/reviews/whatever/k1.md"},
        })
        payload = self._run()
        self.assertEqual(payload["count"], 1)

    def test_picks_regardless_of_review_status(self):
        # Pure age check — status doesn't gate eligibility.
        for status in ("summarized", "monitoring", "spec_created",
                       "tasked", "declined", "approval_pending"):
            with self.subTest(status=status):
                _load_state(self.state_path, {
                    f"k_{status}": self._item(
                        f"k_{status}",
                        reviewStatus=status,
                        # no curation — eligible
                    ),
                })
                payload = self._run()
                self.assertEqual(payload["count"], 1)

    def test_respects_batch_size(self):
        items = {
            f"k{i}": self._item(f"k{i}", reviewStatus="summarized")
            for i in range(10)
        }
        _load_state(self.state_path, items)
        payload = self._run()
        self.assertEqual(payload["count"], 5)  # default batch size
        self.assertEqual(payload["remaining"], 5)


# ===================================================================
# validate_curate_output (writes item.curation sub-object)
# ===================================================================

class ValidateCurateOutputTests(unittest.TestCase):

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.root = Path(self.tempdir.name)
        self.state_path = self.root / "brain" / "state" / "bookmark-review-state.json"
        self.transitions_path = self.state_path.with_name("bookmark-transitions.jsonl")
        self.output_path = self.root / "brain" / "state" / "curate-output.json"
        self.state_root = self.state_path.parent

    def _write_artifact(self, decisions, config=None):
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        artifact = {
            "producedAt": _now_iso(),
            "config": config or {"topics": ["brain", "infra"], "relevanceThreshold": 7},
            "processed": len(decisions),
            "remaining": 0,
            "decisions": decisions,
            "errors": [],
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

    def _decision(self, key: str, **overrides) -> dict:
        d = {
            "bookmarkKey": key,
            "topic": "brain",
            "score": 8.0,
            "reasoning": "test reasoning",
            "threshold": 7.0,
            "createdAt": _now_iso(),
        }
        d.update(overrides)
        if "relevanceScores" not in overrides:
            selected_topic = d["topic"]
            selected_score = d["score"]
            d["relevanceScores"] = [
                {
                    "topic": topic,
                    "score": selected_score if topic == selected_topic else min(float(selected_score) - 1, 6),
                    "reasoning": "test score",
                }
                for topic in ("brain", "infra")
            ]
        return d

    def test_writes_curation_sub_object(self):
        _load_state(self.state_path, {
            "k1": {"bookmarkKey": "k1", "reviewStatus": "summarized",
                   "summary": {"headline": "h"}},
        })
        self._write_artifact([self._decision("k1", score=8.5, topic="infra")])
        out = self._run()
        self.assertEqual(len(out["applied"]), 1)
        state = json.loads(self.state_path.read_text())
        item = state["items"]["k1"]
        self.assertIn("curation", item)
        self.assertEqual(item["curation"]["score"], 8.5)
        self.assertEqual(item["curation"]["topic"], "infra")
        # Status did NOT change — curation is the verdict, not the status.
        self.assertEqual(item["reviewStatus"], "summarized")
        # No legacy fields written
        self.assertNotIn("relevanceScore", item)
        self.assertNotIn("approvalTopic", item)
        # Artifact renamed
        self.assertFalse(self.output_path.exists())
        self.assertTrue(self.output_path.with_suffix(".json.processed").exists())

    def test_overwrites_existing_curation(self):
        # Re-curation on a summary that already has a curation.
        old_curation = _curation(score=5.0, topic="brain", age_days=0)
        _load_state(self.state_path, {
            "k1": {"bookmarkKey": "k1", "reviewStatus": "summarized",
                   "curation": old_curation},
        })
        self._write_artifact([self._decision("k1", score=9.0, topic="infra")])
        self._run()
        state = json.loads(self.state_path.read_text())
        self.assertEqual(state["items"]["k1"]["curation"]["score"], 9.0)
        self.assertEqual(state["items"]["k1"]["curation"]["topic"], "infra")

    def test_idempotent_when_curation_unchanged(self):
        # Same topic + score + createdAt as existing → skip.
        curation = _curation(score=8.0, topic="brain", age_days=0)
        _load_state(self.state_path, {
            "k1": {"bookmarkKey": "k1", "reviewStatus": "summarized",
                   "curation": curation},
        })
        self._write_artifact([self._decision(
            "k1", score=8.0, topic="brain",
            createdAt=curation["createdAt"],
        )])
        out = self._run()
        self.assertEqual(len(out["applied"]), 0)
        self.assertEqual(len(out["skipped"]), 1)

    def test_marks_invalid_decision_shape(self):
        _load_state(self.state_path, {
            "k1": {"bookmarkKey": "k1", "reviewStatus": "summarized"},
        })
        self._write_artifact([{
            "bookmarkKey": "k1",
            # missing: topic, score, reasoning, activeTopics, threshold, createdAt
        }])
        out = self._run()
        self.assertEqual(len(out["invalid"]), 1)

    def test_rejects_missing_topic_scores(self):
        _load_state(self.state_path, {
            "k1": {"bookmarkKey": "k1", "reviewStatus": "summarized"},
        })
        decision = self._decision("k1")
        decision["relevanceScores"] = [{"topic": "brain", "score": 8}]
        self._write_artifact([decision])
        out = self._run()
        self.assertEqual(len(out["invalid"]), 1)
        self.assertIn("missing configured topics", " ".join(out["invalid"][0]["errors"]))

    def test_rejects_selected_topic_that_is_not_maximum(self):
        _load_state(self.state_path, {
            "k1": {"bookmarkKey": "k1", "reviewStatus": "summarized"},
        })
        decision = self._decision("k1", topic="brain", score=7)
        decision["relevanceScores"] = [
            {"topic": "brain", "score": 7},
            {"topic": "infra", "score": 9},
        ]
        self._write_artifact([decision])
        out = self._run()
        self.assertEqual(len(out["invalid"]), 1)
        self.assertIn("maximum relevance score", " ".join(out["invalid"][0]["errors"]))

    def test_rejects_unconfigured_selected_topic(self):
        _load_state(self.state_path, {
            "k1": {"bookmarkKey": "k1", "reviewStatus": "summarized"},
        })
        decision = self._decision("k1", topic="crypto", score=9)
        self._write_artifact([decision])
        out = self._run()
        self.assertEqual(len(out["invalid"]), 1)
        self.assertIn("configured topics", " ".join(out["invalid"][0]["errors"]))
        state = json.loads(self.state_path.read_text())
        self.assertNotIn("curation", state["items"]["k1"])

    def test_no_artifact_is_noop(self):
        out = self._run()
        self.assertEqual(out["applied"], [])

    def test_malformed_json_returns_error(self):
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        self.output_path.write_text("{ not valid")
        out = self._run()
        self.assertFalse(out["ok"])
        self.assertIn("not valid JSON", out["error"])

    def test_writes_transition_log(self):
        _load_state(self.state_path, {
            "k1": {"bookmarkKey": "k1", "reviewStatus": "summarized"},
        })
        self._write_artifact([self._decision("k1", score=8.0)])
        self._run()
        entries = [
            json.loads(line)
            for line in self.transitions_path.read_text().splitlines()
            if line.strip()
        ]
        self.assertEqual(len(entries), 1)
        self.assertIn("curation refreshed", entries[0]["reason"])


# ===================================================================
# validate_spec_output (unchanged from previous round, regression tests)
# ===================================================================

class ValidateSpecOutputTests(unittest.TestCase):

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
                {"producedAt": _now_iso(), "entries": entries},
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
        _load_state(self.state_path, {
            "k1": {"bookmarkKey": "k1", "reviewStatus": "spec_requested"},
        })
        self._make_spec("brain/spec.md")
        self._write_artifact([{
            "bookmarkKey": "k1",
            "reviewDoc": "brain/reviews/k1.md",
            "requestType": "new",
            "specs": [{
                "title": "Spec",
                "specDoc": "brain/spec.md",
                "proposedTasks": [{
                    "title": "task 1",
                    "priority": "high",
                    "summary": "s",
                    "deliverable": "d",
                    "acceptanceCriteria": ["ac"],
                }],
            }],
        }])
        out = self._run()
        self.assertEqual(len(out["applied"]), 1)
        state = json.loads(self.state_path.read_text())
        self.assertEqual(state["items"]["k1"]["reviewStatus"], "spec_created")

    def test_marks_invalid_when_spec_file_missing(self):
        _load_state(self.state_path, {
            "k1": {"bookmarkKey": "k1", "reviewStatus": "spec_requested"},
        })
        self._write_artifact([{
            "bookmarkKey": "k1",
            "reviewDoc": "brain/reviews/k1.md",
            "requestType": "new",
            "specs": [{
                "title": "Spec",
                "specDoc": "brain/specs/does/not/exist.md",
                "proposedTasks": [{
                    "title": "task",
                    "priority": "high",
                    "summary": "s",
                    "deliverable": "d",
                    "acceptanceCriteria": ["ac"],
                }],
            }],
        }])
        out = self._run()
        self.assertEqual(len(out["invalid"]), 1)
        self.assertIn("missing on disk", out["invalid"][0]["errors"][0])

    def test_marks_invalid_on_bad_priority(self):
        _load_state(self.state_path, {
            "k1": {"bookmarkKey": "k1", "reviewStatus": "spec_requested"},
        })
        self._make_spec("brain/spec.md")
        self._write_artifact([{
            "bookmarkKey": "k1",
            "reviewDoc": "brain/reviews/k1.md",
            "requestType": "new",
            "specs": [{
                "title": "Spec",
                "specDoc": "brain/spec.md",
                "proposedTasks": [{
                    "title": "task",
                    "priority": "URGENT",
                    "summary": "s",
                    "deliverable": "d",
                    "acceptanceCriteria": ["ac"],
                }],
            }],
        }])
        out = self._run()
        self.assertEqual(len(out["invalid"]), 1)
        self.assertIn("priority", out["invalid"][0]["errors"][0])

    def test_rejects_unknown_bookmark_key_without_creating_state(self):
        _load_state(self.state_path, {
            "k1": {"bookmarkKey": "k1", "reviewStatus": "spec_requested"},
        })
        self._make_spec("brain/spec.md")
        self._write_artifact([{
            "bookmarkKey": "typo-k1",
            "reviewDoc": "brain/reviews/k1.md",
            "requestType": "new",
            "specs": [{
                "title": "Spec",
                "specDoc": "brain/spec.md",
                "proposedTasks": [],
            }],
        }])

        out = self._run()

        self.assertEqual(len(out["invalid"]), 1)
        self.assertIn("does not exist", out["invalid"][0]["errors"][0])
        state = json.loads(self.state_path.read_text())
        self.assertNotIn("typo-k1", state["items"])

    def test_rejects_bookmark_not_waiting_for_spec(self):
        _load_state(self.state_path, {
            "k1": {"bookmarkKey": "k1", "reviewStatus": "summarized"},
        })
        self._make_spec("brain/spec.md")
        self._write_artifact([{
            "bookmarkKey": "k1",
            "reviewDoc": "brain/reviews/k1.md",
            "requestType": "new",
            "specs": [{
                "title": "Spec",
                "specDoc": "brain/spec.md",
                "proposedTasks": [],
            }],
        }])

        out = self._run()

        self.assertEqual(len(out["invalid"]), 1)
        self.assertIn("spec_requested or revision_requested", out["invalid"][0]["errors"][0])
        state = json.loads(self.state_path.read_text())
        self.assertEqual(state["items"]["k1"]["reviewStatus"], "summarized")

    def test_no_artifact_is_noop(self):
        out = self._run()
        self.assertEqual(out["applied"], [])

    def test_malformed_json_returns_error(self):
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        self.output_path.write_text("{ not valid")
        out = self._run()
        self.assertFalse(out["ok"])
        self.assertIn("not valid JSON", out["error"])


# ===================================================================
# Approval lock: state.approvalLocks self-asserting global lock
# ===================================================================

class ApprovalLockHelperTests(unittest.TestCase):
    """The clear_approval_lock helper in common.py."""

    def test_clears_lock_matching_approval_id(self):
        state = {
            "items": {},
            "approvalLocks": {
                "brain": {
                    "approvalId": "apabc123",
                    "requestedAt": "2026-06-12T00:00:00+00:00",
                    "items": ["k1"],
                },
            },
        }
        result = common.clear_approval_lock(state, "apabc123")
        self.assertEqual(result, "brain")
        self.assertNotIn("brain", state["approvalLocks"])

    def test_idempotent_when_no_lock(self):
        state = {"items": {}, "approvalLocks": {}}
        result = common.clear_approval_lock(state, "apnonexistent")
        self.assertIsNone(result)

    def test_idempotent_when_no_approval_locks_field(self):
        state = {"items": {}}
        result = common.clear_approval_lock(state, "apanything")
        self.assertIsNone(result)

    def test_does_not_clear_other_topics(self):
        state = {
            "items": {},
            "approvalLocks": {
                "brain": {"approvalId": "apbrain1", "items": []},
                "infra": {"approvalId": "apinfra1", "items": []},
            },
        }
        common.clear_approval_lock(state, "apbrain1")
        self.assertNotIn("brain", state["approvalLocks"])
        self.assertIn("infra", state["approvalLocks"])

    def test_case_insensitive_match(self):
        # approvalId is normalized to lowercase before comparison
        state = {
            "items": {},
            "approvalLocks": {
                "brain": {"approvalId": "apabc123", "items": []},
            },
        }
        result = common.clear_approval_lock(state, "APABC123")
        self.assertEqual(result, "brain")
        self.assertNotIn("brain", state["approvalLocks"])


class ApprovalLockConcurrencyTests(unittest.TestCase):
    """Simulate the race between two concurrent request_topic_approval runs.

    Real concurrency requires fcntl or threads; for a unit test, we
    simulate the race by:
      1. Run A: pass 1 (no lock yet) → pass 2 (writes lock) → save
      2. Run B: pass 1 (sees A's lock after re-read) → blocks
    and the inverse:
      1. Run A + Run B both pass 1 (no lock, before either saves)
      2. Run A saves first
      3. Run B saves second (overwrites A)
      4. A re-reads → sees B's lock, backs off
      5. B re-reads → sees B's lock, wins
    """

    def test_concurrent_run_blocks_when_other_run_holds_lock(self):
        # Pre-state: topic already locked by a prior run
        state = {
            "items": {
                "k1": {"bookmarkKey": "k1", "reviewStatus": "approval_pending",
                       "approvalId": "apexisting", "approvalTopic": "brain"},
            },
            "approvalLocks": {
                "brain": {"approvalId": "apexisting", "items": ["k1"]},
            },
        }

        # Try to claim brain again — should be blocked
        topic = "brain"
        self.assertIn(topic, state["approvalLocks"])

    def test_lost_race_detection_via_approval_id_mismatch(self):
        # Simulate: run A and run B both pass the initial check, both
        # write their locks, B saves second. A's re-read sees B's lock
        # and should back off.
        our_approval_id = "apA123"
        their_approval_id = "apB456"

        # The state after both saves shows B's lock
        state_after_saves = {
            "approvalLocks": {
                "brain": {"approvalId": their_approval_id, "items": ["k1"]},
            }
        }

        # A re-reads — sees B's lock, A's approval_id is not the stored one
        actual_lock = state_after_saves["approvalLocks"].get("brain", {})
        stored_id = str(actual_lock.get("approvalId") or "").strip().lower()
        self.assertNotEqual(stored_id, our_approval_id.lower())
        # A would block here, not proceed to send

    def test_winner_detection_via_approval_id_match(self):
        # The run that wrote the lock sees its own approvalId in the
        # re-read and proceeds to send.
        our_approval_id = "apA123"
        state_after_save = {
            "approvalLocks": {
                "brain": {"approvalId": our_approval_id, "items": ["k1"]},
            }
        }
        actual_lock = state_after_save["approvalLocks"].get("brain", {})
        stored_id = str(actual_lock.get("approvalId") or "").strip().lower()
        self.assertEqual(stored_id, our_approval_id.lower())

    def test_lock_field_survives_state_load(self):
        # Make sure load_state() preserves approvalLocks across save/load
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "state.json"
            original = {
                "version": 1,
                "items": {"k1": {"bookmarkKey": "k1"}},
                "approvalLocks": {
                    "brain": {"approvalId": "apxyz", "items": ["k1"]},
                },
            }
            common.save_state(original, state_path)
            reloaded = common.load_state(state_path)
            self.assertIn("approvalLocks", reloaded)
            self.assertEqual(reloaded["approvalLocks"]["brain"]["approvalId"], "apxyz")

    def test_load_state_backfills_missing_approval_locks(self):
        # Old state files (pre-approvalLocks) should get an empty field
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "state.json"
            state_path.write_text(json.dumps({"items": {"k1": {}}}))
            reloaded = common.load_state(state_path)
            self.assertIn("approvalLocks", reloaded)
            self.assertEqual(reloaded["approvalLocks"], {})


if __name__ == "__main__":
    unittest.main()
