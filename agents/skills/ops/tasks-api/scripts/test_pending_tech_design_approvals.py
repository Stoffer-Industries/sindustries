#!/usr/bin/env python3
"""Unit tests for pending_tech_design_approvals.

Run with: python3 -m unittest agents/skills/ops/tasks-api/scripts/test_pending_tech_design_approvals.py
"""

from __future__ import annotations

import os
import sys
import unittest

# Make the sibling script importable
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

import pending_tech_design_approvals as p  # noqa: E402


class TaggedValuesTest(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(p.tagged_values([], "[tech-design]"), [])

    def test_starts_with_tag(self):
        comments = [
            {"text": "[tech-design] https://example.com/design.md"},
            {"text": "Some unrelated comment"},
        ]
        self.assertEqual(
            p.tagged_values(comments, "[tech-design]"),
            ["https://example.com/design.md"],
        )

    def test_substring_match_does_not_count(self):
        # The lobster's progress-checklist complaint contains the tag as a
        # SUBSTRING but not at the start. The old ad-hoc check matched this
        # as a false positive. The lobster's parser (and this script) does not.
        comments = [
            {
                "text": "[feature-task-progress-checklist]\n"
                "Missing task comment `[tech-design-approved] true`.\n"
                "Rowan already has an active task in `doing`."
            },
        ]
        self.assertEqual(
            p.tagged_values(comments, "[tech-design-approved]"),
            [],
        )


class TechDesignApprovedTest(unittest.TestCase):
    def test_lobster_complaint_is_not_approval(self):
        comments = [
            {
                "text": "[feature-task-progress-checklist]\n"
                "Missing task comment `[tech-design-approved] true`."
            },
        ]
        self.assertFalse(p.tech_design_approved({"comments": comments}))

    def test_bare_true_is_approval(self):
        comments = [{"text": "[tech-design-approved] true"}]
        self.assertTrue(p.tech_design_approved({"comments": comments}))

    def test_true_with_rationale_is_approval(self):
        comments = [
            {
                "text": "[tech-design-approved] true — Approved by Quinn on behalf of Tom 2026-06-30"
            }
        ]
        self.assertTrue(p.tech_design_approved({"comments": comments}))

    def test_uppercase_true_is_approval(self):
        comments = [{"text": "[tech-design-approved] TRUE"}]
        self.assertTrue(p.tech_design_approved({"comments": comments}))

    def test_explicit_false_is_not_approval(self):
        comments = [
            {"text": "[tech-design-approved] false — pending review"}
        ]
        self.assertFalse(p.tech_design_approved({"comments": comments}))

    def test_no_comments_is_not_approval(self):
        self.assertFalse(p.tech_design_approved({"comments": []}))


class TechDesignUrlTest(unittest.TestCase):
    def test_first_non_empty_url(self):
        comments = [
            {"text": "[tech-design]"},  # empty value, skipped
            {"text": "[tech-design] https://example.com/design.md"},
        ]
        self.assertEqual(
            p.tech_design_url({"comments": comments}),
            "https://example.com/design.md",
        )

    def test_no_url(self):
        self.assertIsNone(p.tech_design_url({"comments": []}))


class IsFeatureTaskTest(unittest.TestCase):
    def test_task_type_feature(self):
        self.assertTrue(p.is_feature_task({"taskType": "feature", "tags": []}))

    def test_feature_factory_tag(self):
        self.assertTrue(
            p.is_feature_task({"taskType": None, "tags": ["feature-factory"]})
        )

    def test_unrelated_task(self):
        self.assertFalse(p.is_feature_task({"taskType": "content", "tags": []}))

    def test_empty(self):
        self.assertFalse(p.is_feature_task({}))


if __name__ == "__main__":
    unittest.main()
