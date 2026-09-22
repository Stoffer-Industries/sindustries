#!/usr/bin/env python3
"""AC3 regression: a summaryDoc-only item with valid spec work must enter
priority recovery in `lobster_list_curate_candidates.py` without any
reviewDoc field (task b38f70bb).

The old `_active_doc = reviewDoc || summaryDoc` expression let legacy
reviewDoc-only records outrank summary-only items in priority recovery.
This test exercises the wrapper end-to-end via subprocess so the regression
cannot recur.
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
SCRIPT_PATH = _SCRIPTS_DIR / "lobster_list_curate_candidates.py"


def _workspace_for_tmpdir(tmpdir: Path) -> Path:
    (tmpdir / "brain" / "state").mkdir(parents=True, exist_ok=True)
    (tmpdir / "brain" / "bookmarks" / "x").mkdir(parents=True, exist_ok=True)
    (tmpdir / "brain" / "bookmarks" / "summaries").mkdir(parents=True, exist_ok=True)
    (tmpdir / "brain" / "bookmarks" / "specs").mkdir(parents=True, exist_ok=True)
    return tmpdir


def _write_state(tmpdir: Path, items: dict) -> Path:
    state_path = tmpdir / "brain" / "state" / "bookmark-review-state.json"
    state_path.write_text(json.dumps({"items": items}), encoding="utf-8")
    return state_path


def _write_summary(tmpdir: Path, rel_path: str, body: str) -> Path:
    full = tmpdir / rel_path
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(body, encoding="utf-8")
    return full


def _write_spec(tmpdir: Path, rel_path: str) -> Path:
    full = tmpdir / rel_path
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(
        "# Spec - sample\n\n## Proposed Tasks\n\n### Task\n\n- **Priority:** `high`\n",
        encoding="utf-8",
    )
    return full


def _write_bookmark(tmpdir: Path, rel_path: str, link: str | None = None) -> Path:
    full = tmpdir / rel_path
    full.parent.mkdir(parents=True, exist_ok=True)
    link_line = f"link: {link}\n" if link else ""
    full.write_text(
        f"---\ntitle: Sample\nsource: x\ntopic: brain\n{link_line}---\n\nBody.\n",
        encoding="utf-8",
    )
    return full


def _bookmark_key_for(tmpdir: Path, bookmark_rel: str, link: str | None) -> str:
    """Mirror common.bookmark_key: sha1(canonical)[:16].

    Using `link` as the canonical source lets the test pin the key
    deterministically regardless of how the script computes its keys.
    """
    import hashlib
    canonical = link or bookmark_rel
    return hashlib.sha1(canonical.encode("utf-8")).hexdigest()[:16]


def _run(tmpdir: Path, state_items: dict, source_root: str) -> dict:
    _workspace_for_tmpdir(tmpdir)
    state_path = _write_state(tmpdir, state_items)
    proc = subprocess.run(
        [
            sys.executable, str(SCRIPT_PATH),
            "--source-root", source_root,
            "--limit", "10",
            "--json",
        ],
        capture_output=True,
        text=True,
        cwd=str(tmpdir),
        env={**os.environ, "OPENCLAW_WORKSPACE": str(tmpdir)},
    )
    if proc.returncode != 0:
        raise AssertionError(
            f"lobster_list_curate_candidates.py failed: rc={proc.returncode}\n"
            f"stdout={proc.stdout[:500]}\nstderr={proc.stderr[:500]}"
        )
    return json.loads(proc.stdout.strip())


class SummaryOnlyPriorityRecoveryTests(unittest.TestCase):
    def test_summary_only_item_with_spec_work_enters_priority_candidates(self):
        """summaryDoc-only record with valid spec/proposal work enters priority recovery."""
        with tempfile.TemporaryDirectory() as td:
            tmpdir = Path(td)
            bookmark_rel = "brain/bookmarks/x/sample-summary-only.md"
            link = "https://example.test/sample-summary-only"
            key = _bookmark_key_for(tmpdir, bookmark_rel, link)
            summary_rel = f"brain/bookmarks/summaries/sample-{key}.md"
            spec_rel = f"brain/bookmarks/specs/sample-{key}.md"
            _write_summary(tmpdir, summary_rel, "high signal curation content\n")
            _write_spec(tmpdir, spec_rel)
            _write_bookmark(tmpdir, bookmark_rel, link=link)

            state_items = {
                key: {
                    "bookmarkKey": key,
                    "path": bookmark_rel,
                    "title": "Sample",
                    "source": "x",
                    "topic": "brain",
                    "summaryDoc": summary_rel,
                    # No reviewDoc field at all — this is the post-migration shape.
                    "specDocs": [spec_rel],
                    "specProposals": [
                        {
                            "title": "Sample spec",
                            "specDoc": spec_rel,
                            "proposedTasks": [{"title": "Task"}],
                        }
                    ],
                    "curation": {"createdAt": "2026-08-15T00:00:00+00:00",
                                  "score": 9, "threshold": 7},
                },
            }
            payload = _run(tmpdir, state_items, "brain/bookmarks/x")
            self.assertEqual(payload["count"], 1)
            self.assertEqual(payload["candidates"][0]["bookmarkKey"], key)
            self.assertTrue(payload["candidates"][0].get("skipReview"))

    def test_legacy_reviewdoc_only_item_is_NOT_used_as_routing_signal(self):
        """A reviewDoc-only record (no summaryDoc) must NOT enter the
        priority_recovery bucket. The old `reviewDoc || summaryDoc`
        expression let legacy records take priority slots — this test
        pins the corrected behavior: reviewDoc-only items may still
        appear in candidates as fresh processing entries, but they
        must never carry `skipReview: True` (the priority-recovery
        marker that requires summaryDoc-based routing)."""
        with tempfile.TemporaryDirectory() as td:
            tmpdir = Path(td)
            legacy_rel = "brain/bookmarks/x/legacy-reviewdoc-only.md"
            legacy_link = "https://example.test/legacy-reviewdoc-only"
            legacy_key = _bookmark_key_for(tmpdir, legacy_rel, legacy_link)
            legacy_summary_rel = f"brain/bookmarks/summaries/legacy-{legacy_key}.md"
            _write_summary(tmpdir, legacy_summary_rel,
                           "Classified as 'implement'\n"  # would have triggered old code path
                           )
            _write_bookmark(tmpdir, legacy_rel, link=legacy_link)

            state_items = {
                legacy_key: {
                    "bookmarkKey": legacy_key,
                    "path": legacy_rel,
                    "title": "Legacy",
                    "source": "x",
                    "topic": "brain",
                    # reviewDoc-only — no summaryDoc. Must NOT be a priority candidate.
                    "reviewDoc": legacy_summary_rel,
                    "analysis": {"classification": "implement"},
                    "curation": {"createdAt": "2026-08-15T00:00:00+00:00",
                                  "score": 2, "threshold": 7},
                },
            }
            payload = _run(tmpdir, state_items, "brain/bookmarks/x")
            legacy_candidates = [c for c in payload["candidates"]
                                 if c["bookmarkKey"] == legacy_key]
            self.assertEqual(len(legacy_candidates), 1,
                             "reviewDoc-only item may enter candidates as fresh processing")
            self.assertFalse(legacy_candidates[0].get("skipReview", False),
                             "reviewDoc-only items must NOT take priority-recovery slots")


if __name__ == "__main__":
    unittest.main()
