#!/usr/bin/env python3
"""Tests for find_similar_tasks.py similarity scoring.

Run from repo root:
    python3 agents/skills/ops/tasks-api/tests/test_find_similar_tasks.py

These are pure-Python tests that don't require a live tasks API — they
import the scoring functions directly and feed synthetic task dicts.
"""

import os
import sys
import unittest

# Allow running from repo root or from the tests directory.
_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPT_DIR = os.path.abspath(os.path.join(_HERE, "..", "scripts"))
sys.path.insert(0, _SCRIPT_DIR)

from find_similar_tasks import tokenize, jaccard, score  # noqa: E402


class TokenizeTests(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(tokenize("Log gate failure analytics"), {"log", "gate", "failure", "analytics"})

    def test_lowercases(self):
        self.assertEqual(tokenize("LOG GATE"), {"log", "gate"})

    def test_strips_punctuation(self):
        self.assertEqual(tokenize("🔧 Log, gate — failure!"), {"log", "gate", "failure"})

    def test_empty(self):
        self.assertEqual(tokenize(""), set())
        self.assertEqual(tokenize(None), set())


class JaccardTests(unittest.TestCase):
    def test_identical(self):
        self.assertEqual(jaccard({"a", "b"}, {"a", "b"}), 1.0)

    def test_disjoint(self):
        self.assertEqual(jaccard({"a", "b"}, {"c", "d"}), 0.0)

    def test_partial(self):
        self.assertAlmostEqual(jaccard({"a", "b", "c"}, {"b", "c", "d"}), 0.5)

    def test_empty(self):
        self.assertEqual(jaccard(set(), {"a"}), 0.0)
        self.assertEqual(jaccard({"a"}, set()), 0.0)
        self.assertEqual(jaccard(set(), set()), 0.0)


class ScoreTests(unittest.TestCase):
    def test_identical_titles_score_high(self):
        t = {"title": "🔧 Log gate failure analytics", "tags": []}
        s, reasons = score(t, title="🔧 Log gate failure analytics", description="", tags=[])
        self.assertGreater(s, 0.4)
        self.assertTrue(any("title overlap" in r for r in reasons))

    def test_unrelated_titles_score_low(self):
        t = {"title": "🚗 Setup car pool rotation", "tags": []}
        s, _ = score(t, title="🔧 Log gate failure analytics", description="", tags=[])
        self.assertLess(s, 0.1)

    def test_shared_tags_boost_score(self):
        t = {"title": "Sing about ducks", "tags": ["rowan", "analytics"]}
        s, reasons = score(t, title="Sing about geese", description="", tags=["rowan", "analytics"])
        self.assertGreater(s, 0.1)
        self.assertTrue(any("shared tags" in r for r in reasons))

    def test_topic_tags_strong_signal(self):
        t = {"title": "Fix unrelated thing", "tags": ["topic:app-tasks"]}
        s, reasons = score(t, title="Fix something else", description="", tags=["topic:app-tasks"])
        self.assertGreater(s, 0.1)
        self.assertTrue(any("same topic" in r for r in reasons))

    def test_description_overlap_counts(self):
        t = {
            "title": "Different title",
            "description": "We need to log gate failures to a postgres analytics table",
            "tags": [],
        }
        s, reasons = score(
            t,
            title="Different title again",
            description="Log gate failures to postgres analytics",
            tags=[],
        )
        self.assertGreater(s, 0.05)
        self.assertTrue(any("description overlap" in r for r in reasons))

    def test_canonical_duplicate_pair(self):
        # The actual duplicated task pair from the bug report.
        # Task A is the narrow/Postgres-table version.
        # Task B is the broad/event-emission version.
        # They share enough tokens + topic that dedup should surface them.
        a = {
            "title": "🔧 Log gate failure analytics at post-merge for flow dashboard",
            "description": "At the post-merge stage the feature-task lobster writes gate failure breakdowns to a Postgres analytics table.",
            "tags": ["rowan", "analytics", "feature-factory"],
        }
        b_title = "🔧 Post-Merge Feature Factory Analytics"
        b_desc = "After a feature task reaches its terminal state, durable analytics events are emitted for the task's lifecycle."
        b_tags = ["rowan", "analytics"]
        s, reasons = score(a, title=b_title, description=b_desc, tags=b_tags)
        # Should be high enough to surface (>= 0.25 threshold).
        self.assertGreater(s, 0.25, f"Expected duplicate pair to score above threshold, got {s} with reasons {reasons}")
        self.assertTrue(any("title overlap" in r for r in reasons))

    def test_score_capped_at_one(self):
        # Identical everything should still cap at 1.0, not blow up.
        t = {
            "title": "Same title",
            "description": "Same description",
            "tags": ["topic:foo", "bar"],
        }
        s, _ = score(t, title="Same title", description="Same description", tags=["topic:foo", "bar"])
        self.assertLessEqual(s, 1.0)


if __name__ == "__main__":
    unittest.main()
