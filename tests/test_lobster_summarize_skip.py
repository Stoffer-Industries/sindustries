#!/usr/bin/env python3
"""Tests for lobster_summarize.py's skip behaviour.

Covers the rewind bug where items in a downstream reviewStatus
(spec_created, approval_pending, tasked, approved, declined) with an
existing summaryDoc were being re-summarized on every run, which clobbered
their reviewStatus back to "summarized".
"""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "agents/workflows/bookmarks/scripts"))

import common
import lobster_summarize as summarize_mod


class LobsterSummarizeSkipTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.state_path = self.root / "brain" / "state" / "bookmark-review-state.json"
        self.reviews_root = self.root / "brain" / "bookmarks" / "summaries"
        self.reviews_root.mkdir(parents=True, exist_ok=True)
        common.save_state(common.state_template(), self.state_path)
        # Path used by the LLM invoker — make sure the patcher redirects it.
        # Patch both common.WORKSPACE (so load_state/save_state resolve to the
        # tempdir) and summarize_mod.WORKSPACE (since the script imported the
        # name at module load time and has its own binding).
        self.workspace_patcher = patch.object(common, "WORKSPACE", self.root)
        self.workspace_patcher.start()
        self.summarize_workspace_patcher = patch.object(summarize_mod, "WORKSPACE", self.root)
        self.summarize_workspace_patcher.start()
        self.addCleanup(self.workspace_patcher.stop)
        self.addCleanup(self.summarize_workspace_patcher.stop)
        self.state_path_patcher = patch.object(summarize_mod, "STATE_PATH", self.state_path)
        self.state_path_patcher.start()
        self.addCleanup(self.state_path_patcher.stop)

    def tearDown(self):
        self.tempdir.cleanup()

    def _write_summary_doc(self, bookmark_key: str) -> str:
        rel = f"brain/bookmarks/summaries/sample-{bookmark_key}.md"
        (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
        (self.root / rel).write_text(
            "# Summary — Sample\n\nAn existing summary doc.\n",
            encoding="utf-8",
        )
        return rel

    def _candidates_input(self, candidates: list[dict]) -> str:
        return json.dumps({"ok": True, "count": len(candidates), "candidates": candidates})

    def _make_record(self, bookmark_key: str, **overrides) -> dict:
        record = {
            "bookmarkKey": bookmark_key,
            "path": f"brain/bookmarks/infra/{bookmark_key}.md",
            "topic": "infra",
            "source": "x",
            "title": f"Sample {bookmark_key}",
            "link": "https://example.com/post",
            "tags": ["infra"],
            "type": "infra",
            "dateArchived": "2026-06-16",
            "bodyExcerpt": "excerpt",
            "body": "body",
        }
        record.update(overrides)
        return record

    def test_spec_created_item_with_summary_doc_is_not_rewound(self):
        """An item in spec_created with an existing summaryDoc must be skipped
        without clobbering reviewStatus back to summarized.
        """
        bookmark_key = "spec-created-key"
        summary_rel = self._write_summary_doc(bookmark_key)
        state = common.load_state(self.state_path)
        state["items"][bookmark_key] = {
            "bookmarkKey": bookmark_key,
            "reviewStatus": "spec_created",
            "summaryDoc": summary_rel,
            "summary": {"headline": "existing", "problem": "p", "approach": "a", "valueProposition": "v", "keyDetails": [], "relevantTo": "r"},
            "specDocs": ["brain/bookmarks/specs/sample.md"],
            "taskIds": [],
        }
        common.save_state(state, self.state_path)

        candidates = [self._make_record(bookmark_key)]

        # invoke_llm_json is the only place the LLM is called. If the fix is
        # wrong, the LLM will be invoked and the test will hit this mock and
        # fail.
        with patch.object(summarize_mod, "invoke_llm_json", side_effect=AssertionError("LLM should not be called for already-summarized items")):
            with patch("sys.stdin", io.StringIO(self._candidates_input(candidates))):
                with patch.object(sys, "argv", ["lobster_summarize.py", "--json", "--reviews-root", str(self.reviews_root)]):
                    rc = summarize_mod.main()

        self.assertEqual(rc, 0)
        after = common.load_state(self.state_path)["items"][bookmark_key]
        self.assertEqual(after["reviewStatus"], "spec_created", "reviewStatus must not be rewound")
        self.assertEqual(after["summaryDoc"], summary_rel)

    def test_skip_review_flag_skips_without_invoking_llm(self):
        """An item with skipReview=True is skipped regardless of state."""
        bookmark_key = "skip-review-key"
        state = common.load_state(self.state_path)
        state["items"][bookmark_key] = {
            "bookmarkKey": bookmark_key,
            "reviewStatus": "summarized",
        }
        common.save_state(state, self.state_path)

        candidates = [self._make_record(bookmark_key, skipReview=True)]

        with patch.object(summarize_mod, "invoke_llm_json", side_effect=AssertionError("LLM should not be called when skipReview is true")):
            with patch("sys.stdin", io.StringIO(self._candidates_input(candidates))):
                with patch.object(sys, "argv", ["lobster_summarize.py", "--json", "--reviews-root", str(self.reviews_root)]):
                    rc = summarize_mod.main()

        self.assertEqual(rc, 0)
        after = common.load_state(self.state_path)["items"][bookmark_key]
        self.assertEqual(after["reviewStatus"], "summarized", "skipReview should leave state alone")

    def test_fresh_item_without_summary_invokes_llm_and_writes_doc(self):
        """Sanity check: a brand-new item still goes through the LLM path."""
        bookmark_key = "fresh-key"
        record = self._make_record(bookmark_key)
        candidates = [record]

        llm_payload = {
            "headline": "h",
            "problem": "p",
            "approach": "a",
            "valueProposition": "v",
            "keyDetails": ["k1"],
            "relevantTo": "r",
            "constraints": [],
        }

        with patch.object(summarize_mod, "invoke_llm_json", return_value=llm_payload) as llm_mock, \
             patch.object(summarize_mod, "llm_provenance", return_value={"path": "test", "model": "test"}):
            with patch("sys.stdin", io.StringIO(self._candidates_input(candidates))):
                with patch.object(sys, "argv", ["lobster_summarize.py", "--json", "--reviews-root", str(self.reviews_root)]):
                    rc = summarize_mod.main()

        self.assertEqual(rc, 0)
        self.assertEqual(llm_mock.call_count, 1)
        after = common.load_state(self.state_path)["items"][bookmark_key]
        self.assertEqual(after["reviewStatus"], "summarized")
        self.assertTrue(after.get("summaryDoc"))

    def test_skipped_payload_carries_existing_review_status(self):
        """Downstream consumer (lobster_request_spec_approval) reads the
        reviewStatus emitted in the generated payload. For skipped items we
        must emit the *existing* status, not 'summarized', so the downstream
        step does not regress the item.
        """
        bookmark_key = "payload-key"
        summary_rel = self._write_summary_doc(bookmark_key)
        state = common.load_state(self.state_path)
        state["items"][bookmark_key] = {
            "bookmarkKey": bookmark_key,
            "reviewStatus": "approval_pending",
            "summaryDoc": summary_rel,
            "summary": {"headline": "h", "problem": "p", "approach": "a", "valueProposition": "v", "keyDetails": [], "relevantTo": "r"},
            "approvalId": "ap1234567",
        }
        common.save_state(state, self.state_path)
        candidates = [self._make_record(bookmark_key)]

        with patch.object(summarize_mod, "invoke_llm_json", side_effect=AssertionError("LLM should not be called")):
            with patch("sys.stdin", io.StringIO(self._candidates_input(candidates))):
                with patch.object(sys, "argv", ["lobster_summarize.py", "--json", "--reviews-root", str(self.reviews_root)]):
                    rc = summarize_mod.main()

        self.assertEqual(rc, 0)
        after = common.load_state(self.state_path)["items"][bookmark_key]
        self.assertEqual(after["reviewStatus"], "approval_pending")


if __name__ == "__main__":
    unittest.main()
