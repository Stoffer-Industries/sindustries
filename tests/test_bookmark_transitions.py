from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "agents/workflows/bookmarks/scripts"))

import io
import json
from unittest.mock import patch

import check_transitions
import common
import lobster_summarize as summarize_mod


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


class SummarizeTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.state_path = self.root / "brain" / "state" / "bookmark-review-state.json"
        self.reviews_root = self.root / "brain" / "bookmarks" / "summaries"
        self.bookmark = {
            "bookmarkKey": "abc123",
            "path": "brain/bookmarks/infra/sample.md",
            "topic": "infra",
            "source": "x",
            "title": "Sample Bookmark",
            "link": "https://example.com",
            "tags": ["agents"],
            "type": "infra",
            "dateArchived": "2026-06-12",
            "bodyExcerpt": "A practical note about agent design.",
        }

    def tearDown(self):
        self.tempdir.cleanup()

    def _fake_summary(self, _prompt, _payload, _schema):
        return {
            "headline": "A local-first agent memory tool",
            "problem": "Agents lose context across sessions",
            "approach": "SQLite-backed local archive",
            "valueProposition": "Cheap, offline, queryable",
            "keyDetails": ["Uses SQLite", "Works offline"],
            "relevantTo": "Solo builders using OpenClaw",
            "constraints": ["Twitter-only corpus"],
            "signalQuality": "high",
        }

    def test_summarize_writes_summary_doc_and_updates_state(self):
        stdin = io.StringIO(json.dumps({"candidates": [self.bookmark]}))
        stdout = io.StringIO()

        with patch.object(summarize_mod, "STATE_PATH", self.state_path), \
             patch.object(summarize_mod, "REVIEWS_ROOT", self.reviews_root), \
             patch.object(summarize_mod, "WORKSPACE", self.root), \
             patch.object(summarize_mod, "invoke_llm_json", side_effect=self._fake_summary), \
             patch.object(summarize_mod, "llm_provenance", return_value={"path": "test", "model": "unit"}):
            with patch("sys.stdin", stdin), patch("sys.stdout", stdout), \
                 patch.object(sys, "argv", ["summarize.py", "--json"]):
                rc = summarize_mod.main()

        self.assertEqual(rc, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["summaries"][0]["reviewStatus"], "summarized")

        state = common.load_state(self.state_path)
        item = state["items"]["abc123"]
        self.assertEqual(item["reviewStatus"], "summarized")
        self.assertNotIn("signalQuality", item["summary"])
        self.assertIn("summaryDoc", item)

        doc_path = self.root / item["summaryDoc"]
        self.assertTrue(doc_path.exists())
        content = doc_path.read_text()
        self.assertIn("A local-first agent memory tool", content)
        self.assertNotIn("Signal Quality", content)

    def test_summarize_skips_item_with_existing_summary_on_disk(self):
        # Pre-populate state + doc so the skip-if-exists path is taken
        state = common.state_template()
        doc_rel = "brain/reviews/infra/sample-bookmark-abc123.md"
        (self.root / doc_rel).parent.mkdir(parents=True, exist_ok=True)
        (self.root / doc_rel).write_text("# existing summary\n")
        state["items"]["abc123"] = {
            "bookmarkKey": "abc123",
            "reviewStatus": "summarized",
            "summaryDoc": doc_rel,
        }
        common.save_state(state, self.state_path)

        stdin = io.StringIO(json.dumps({"candidates": [self.bookmark]}))
        stdout = io.StringIO()
        mock_llm = unittest.mock.MagicMock(side_effect=AssertionError("should not call LLM"))

        with patch.object(summarize_mod, "STATE_PATH", self.state_path), \
             patch.object(summarize_mod, "REVIEWS_ROOT", self.reviews_root), \
             patch.object(summarize_mod, "WORKSPACE", self.root), \
             patch.object(summarize_mod, "invoke_llm_json", mock_llm):
            with patch("sys.stdin", stdin), patch("sys.stdout", stdout), \
                 patch.object(sys, "argv", ["summarize.py", "--json"]):
                rc = summarize_mod.main()

        self.assertEqual(rc, 0)
        mock_llm.assert_not_called()

    def test_filter_curation_routes_by_curation_score(self):
        """filter_curation routes on curation.score + freshness, not reviewStatus.

        New model: the verdict lives in item.curation. The status is just
        where the item is in the pipeline. Items with a fresh high-score
        curation go to implement; low-score go to monitoring; missing
        curation goes to monitoring (heartbeat will refresh); terminal
        statuses go to reviewed.
        """
        import lobster_list_curations as filter_curation
        state = common.state_template()

        # Fresh curation, high score → implement
        state["items"]["high_score"] = {
            "bookmarkKey": "high_score",
            "reviewStatus": "summarized",
            "curation": {
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "topic": "brain",
                "score": 8.5,
                "reasoning": "test",
                "relevanceScores": [],
                "activeTopics": ["brain"],
                "threshold": 7.0,
            },
        }

        # Fresh curation, low score → monitoring
        state["items"]["low_score"] = {
            "bookmarkKey": "low_score",
            "reviewStatus": "summarized",
            "curation": {
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "topic": "brain",
                "score": 3.0,
                "reasoning": "test",
                "relevanceScores": [],
                "activeTopics": ["brain"],
                "threshold": 7.0,
            },
        }

        # No curation → monitoring (heartbeat will refresh)
        state["items"]["no_curation"] = {
            "bookmarkKey": "no_curation",
            "reviewStatus": "summarized",
        }

        # Terminal status → reviewed (curation ignored)
        state["items"]["tasked"] = {
            "bookmarkKey": "tasked",
            "reviewStatus": "tasked",
            "curation": {
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "topic": "brain",
                "score": 10.0,
                "reasoning": "test",
                "relevanceScores": [],
                "activeTopics": ["brain"],
                "threshold": 7.0,
            },
        }

        state["items"]["needs_research"] = {
            "bookmarkKey": "needs_research",
            "reviewStatus": "summarized",
            "curation": {
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "topic": "brain",
                "score": 8.0,
                "reasoning": "Dense reference material that needs manual review.",
                "relevanceScores": [],
                "activeTopics": ["brain"],
                "threshold": 7.0,
            },
        }

        common.save_state(state, self.state_path)

        summaries = [
            {"bookmarkKey": "high_score"},
            {"bookmarkKey": "low_score"},
            {"bookmarkKey": "no_curation"},
            {"bookmarkKey": "tasked"},
            {"bookmarkKey": "needs_research"},
        ]
        stdin = io.StringIO(json.dumps({"summaries": summaries}))
        stdout = io.StringIO()

        with patch.object(filter_curation, "STATE_PATH", self.state_path):
            with patch("sys.stdin", stdin), patch("sys.stdout", stdout), \
                 patch.object(sys, "argv", ["filter_curation.py"]):
                rc = filter_curation.main()

        self.assertEqual(rc, 0)
        payload = json.loads(stdout.getvalue())

        def in_bucket(bucket, key):
            return any(i["bookmarkKey"] == key for i in payload[bucket])

        self.assertTrue(in_bucket("implement", "high_score"))
        self.assertTrue(in_bucket("monitoring", "low_score"))
        self.assertTrue(in_bucket("monitoring", "no_curation"))
        self.assertTrue(in_bucket("reviewed", "tasked"))
        self.assertTrue(in_bucket("needs_research", "needs_research"))

        updated_state = common.load_state(self.state_path)
        self.assertEqual(
            updated_state["items"]["needs_research"]["reviewStatus"],
            "needs_research",
        )
        transitions = [
            json.loads(line)
            for line in self.state_path.with_name(
                "bookmark-transitions.jsonl"
            ).read_text().splitlines()
        ]
        self.assertTrue(any(
            transition["key"] == "needs_research"
            and transition["to"] == "needs_research"
            and transition["reason"] == "curation flagged as broad reference material"
            for transition in transitions
        ))


if __name__ == "__main__":
    unittest.main()
