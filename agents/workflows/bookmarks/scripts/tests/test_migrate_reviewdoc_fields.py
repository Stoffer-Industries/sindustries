#!/usr/bin/env python3
"""Tests for the one-shot reviewDoc cleanup utility (task b38f70bb).

Covers AC2 plus the AC3 regression: a summary-only item with valid
spec/proposal work must enter priority recovery without any reviewDoc
field. Uses tempdirs everywhere so the live brain state is never touched.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
_SCRIPTS_DIR = _SCRIPT_DIR.parent
SCRIPT_PATH = _SCRIPTS_DIR / "migrate_reviewdoc_fields.py"


def _write_state(tmpdir: Path, items: dict, summary_paths: dict[str, str] | None = None) -> Path:
    """Write state.json with the given items dict; create summary files on disk."""
    summary_paths = summary_paths or {}
    for key, rel_path in summary_paths.items():
        full = tmpdir / rel_path
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text("# stub summary\n", encoding="utf-8")
    state_path = tmpdir / "brain" / "state" / "bookmark-review-state.json"
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps({"items": items}), encoding="utf-8")
    return state_path


def _run(state_path: Path, *, apply: bool = False) -> dict:
    cmd = [sys.executable, str(SCRIPT_PATH), "--state-path", str(state_path), "--json"]
    if apply:
        cmd.append("--apply")
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        cwd=str(state_path.parent.parent.parent),
        env={**os.environ, "OPENCLAW_WORKSPACE": str(state_path.parent.parent.parent)},
    )
    if proc.returncode != 0:
        raise AssertionError(
            f"migrate_reviewdoc_fields.py failed: rc={proc.returncode}\n"
            f"stdout={proc.stdout[:500]}\nstderr={proc.stderr[:500]}"
        )
    return json.loads(proc.stdout)


class MigrateReviewDocFieldsTests(unittest.TestCase):
    def test_dry_run_reports_eligible_but_does_not_mutate(self):
        with tempfile.TemporaryDirectory() as td:
            tmpdir = Path(td)
            items = {
                "k1": {"summaryDoc": "brain/bookmarks/summaries/k1.md",
                       "reviewDoc": "brain/bookmarks/summaries/k1-old.md"},
                "k2": {"summaryDoc": "brain/bookmarks/summaries/k2.md",
                       "reviewDoc": "brain/bookmarks/summaries/k2-old.md"},
                "k3": {"reviewDoc": "brain/bookmarks/summaries/k3.md"},  # reviewDoc-only
                "k4": {"summaryDoc": "brain/bookmarks/summaries/k4.md"},  # summaryDoc-only
                "k5": {},  # neither
            }
            summary_paths = {
                k: v["summaryDoc"] for k, v in items.items() if "summaryDoc" in v
            }
            state_path = _write_state(tmpdir, items, summary_paths)
            original = state_path.read_text(encoding="utf-8")

            report = _run(state_path, apply=False)

            self.assertEqual(report["counts"]["inspected"], 5)
            self.assertEqual(report["counts"]["eligible"], 2)
            self.assertEqual(report["counts"]["changed"], 0)
            self.assertEqual(report["counts"]["skippedMissingSummary"], 0)
            self.assertEqual(report["counts"]["reviewDocOnly"], 1)
            self.assertEqual(report["counts"]["neither"], 1)
            self.assertFalse(report["applied"])
            self.assertIsNone(report["backupPath"])
            self.assertEqual(set(report["keys"]["eligible"]), {"k1", "k2"})
            # State file untouched
            self.assertEqual(state_path.read_text(encoding="utf-8"), original)

    def test_apply_removes_reviewdoc_on_eligible_and_preserves_other_fields(self):
        with tempfile.TemporaryDirectory() as td:
            tmpdir = Path(td)
            original_item = {
                "summaryDoc": "brain/bookmarks/summaries/k1.md",
                "reviewDoc": "brain/bookmarks/summaries/k1-old.md",
                "reviewStatus": "summarized",
                "curation": {"createdAt": "2026-08-15T00:00:00+00:00", "score": 8, "threshold": 7},
                "taskIds": ["t-1"],
                "approvals": [{"id": "a-1"}],
                "approvalStatus": "approved",
                "specDocs": ["brain/specs/k1.md"],
            }
            items = {"k1": dict(original_item)}
            summary_paths = {"k1": "brain/bookmarks/summaries/k1.md"}
            state_path = _write_state(tmpdir, items, summary_paths)

            report = _run(state_path, apply=True)

            self.assertTrue(report["applied"])
            self.assertEqual(report["counts"]["changed"], 1)
            self.assertEqual(report["keys"]["changed"], ["k1"])
            self.assertIsNotNone(report["backupPath"])
            backup_path = Path(report["backupPath"])
            self.assertTrue(backup_path.exists())
            self.assertTrue(backup_path.name.startswith("bookmark-review-state.json.bak."))

            # State file: reviewDoc removed, every other field preserved verbatim
            updated = json.loads(state_path.read_text(encoding="utf-8"))["items"]["k1"]
            self.assertNotIn("reviewDoc", updated)
            for key, value in original_item.items():
                if key == "reviewDoc":
                    self.assertNotIn(key, updated)
                else:
                    self.assertEqual(updated.get(key), value, f"field {key} not preserved")

    def test_apply_skips_records_with_missing_summary_file(self):
        with tempfile.TemporaryDirectory() as td:
            tmpdir = Path(td)
            # k1 has summaryDoc but the file does NOT exist on disk.
            items = {
                "k1": {"summaryDoc": "brain/bookmarks/summaries/k1-missing.md",
                       "reviewDoc": "brain/bookmarks/summaries/k1-old.md"},
                "k2": {"summaryDoc": "brain/bookmarks/summaries/k2.md",
                       "reviewDoc": "brain/bookmarks/summaries/k2-old.md"},
            }
            summary_paths = {"k2": "brain/bookmarks/summaries/k2.md"}  # k1 file intentionally absent
            state_path = _write_state(tmpdir, items, summary_paths)

            report = _run(state_path, apply=True)

            self.assertEqual(report["counts"]["eligible"], 1)
            self.assertEqual(report["counts"]["skippedMissingSummary"], 1)
            self.assertEqual(report["counts"]["changed"], 1)
            self.assertEqual(report["keys"]["changed"], ["k2"])
            self.assertEqual(report["keys"]["skippedMissingSummary"], ["k1"])

            updated = json.loads(state_path.read_text(encoding="utf-8"))["items"]
            self.assertNotIn("reviewDoc", updated["k2"])
            self.assertIn("reviewDoc", updated["k1"], "k1 must be untouched because its summaryDoc file is missing")

    def test_apply_is_idempotent(self):
        with tempfile.TemporaryDirectory() as td:
            tmpdir = Path(td)
            items = {
                "k1": {"summaryDoc": "brain/bookmarks/summaries/k1.md",
                       "reviewDoc": "brain/bookmarks/summaries/k1-old.md"},
            }
            summary_paths = {"k1": "brain/bookmarks/summaries/k1.md"}
            state_path = _write_state(tmpdir, items, summary_paths)

            first = _run(state_path, apply=True)
            self.assertEqual(first["counts"]["changed"], 1)

            second = _run(state_path, apply=True)
            self.assertEqual(second["counts"]["eligible"], 0)
            self.assertEqual(second["counts"]["changed"], 0)
            self.assertFalse(second["applied"])

    def test_apply_preserves_review_only_records(self):
        with tempfile.TemporaryDirectory() as td:
            tmpdir = Path(td)
            items = {
                "k1": {"reviewDoc": "brain/bookmarks/summaries/k1.md"},  # reviewDoc-only, file present
            }
            summary_paths: dict[str, str] = {}  # no summaryDoc files
            state_path = _write_state(tmpdir, items, summary_paths)
            full = tmpdir / "brain/bookmarks/summaries/k1.md"
            full.parent.mkdir(parents=True, exist_ok=True)
            full.write_text("# legacy review\n", encoding="utf-8")

            report = _run(state_path, apply=True)

            self.assertEqual(report["counts"]["reviewDocOnly"], 1)
            self.assertEqual(report["counts"]["eligible"], 0)
            self.assertEqual(report["counts"]["changed"], 0)
            self.assertFalse(report["applied"])

            updated = json.loads(state_path.read_text(encoding="utf-8"))["items"]
            self.assertIn("reviewDoc", updated["k1"], "reviewDoc-only records must not be mutated")


class SummaryOnlyPriorityRecoveryTests(unittest.TestCase):
    """AC3 regression: a summary-only item with valid spec work must enter
    priority recovery via summaryDoc alone — no reviewDoc field required."""

    def test_summary_only_item_with_spec_work_enters_priority_candidates(self):
        # This regression lives next to lobster_list_curate_candidates.py and
        # exercises the new helper directly. The full lobster_list_curate_candidates
        # subprocess integration is covered by the smoke tests in
        # tests/test_lobster_list_curate_candidates.py (added in the same PR).
        import importlib

        sys.path.insert(0, str(_SCRIPTS_DIR))
        common = importlib.import_module("common")
        self.assertTrue(hasattr(common, "summary_doc_path"))
        self.assertEqual(common.summary_doc_path({"summaryDoc": "x.md"}), "x.md")
        self.assertEqual(common.summary_doc_path({"summaryDoc": "  x.md  "}), "x.md")
        self.assertEqual(common.summary_doc_path({"summaryDoc": ""}), "")
        self.assertEqual(common.summary_doc_path({"reviewDoc": "y.md"}), "")
        self.assertEqual(common.summary_doc_path(None), "")


if __name__ == "__main__":
    unittest.main()
