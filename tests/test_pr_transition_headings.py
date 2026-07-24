from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
import unittest


CONTENT_TASK_DIR = Path(__file__).resolve().parents[1] / "agents/workflows/content-tasks/scripts"


def load_content_task_modules():
    saved_common = sys.modules.get("common")
    try:
        common_spec = importlib.util.spec_from_file_location(
            "common",
            CONTENT_TASK_DIR / "common.py",
        )
        common_module = importlib.util.module_from_spec(common_spec)
        sys.modules["common"] = common_module
        assert common_spec.loader is not None
        common_spec.loader.exec_module(common_module)

        transition_spec = importlib.util.spec_from_file_location(
            "content_task_pr_transition",
            CONTENT_TASK_DIR / "pr_transition.py",
        )
        transition_module = importlib.util.module_from_spec(transition_spec)
        assert transition_spec.loader is not None
        transition_spec.loader.exec_module(transition_module)
        return transition_module
    finally:
        if saved_common is None:
            sys.modules.pop("common", None)
        else:
            sys.modules["common"] = saved_common


class OwnerSectionHeadingTests(unittest.TestCase):
    def test_nested_acceptance_criteria_heading_stays_in_owner_section(self):
        module = load_content_task_modules()
        description = (
            "## Quinn can execute\n"
            "### Acceptance Criteria\n"
            "- [ ] ADD system/example - implement it\n\n"
            "## Needs Tom approval\n"
            "- [ ] Approve launch\n\n"
            "## Defer\n"
            "- [ ] Not part of Tom's section\n"
        )

        sections = module.owner_sections(description)

        self.assertEqual(len(sections), 2)
        self.assertIn("ADD system/example", sections[0][0])
        self.assertIn("Approve launch", sections[1][0])
        self.assertNotIn("Not part of Tom's section", sections[1][0])


def load_common_module():
    """Load the content-task common module and return it (kept in sys.modules)."""
    common_spec = importlib.util.spec_from_file_location(
        "common",
        CONTENT_TASK_DIR / "common.py",
    )
    common_module = importlib.util.module_from_spec(common_spec)
    sys.modules["common"] = common_module
    assert common_spec.loader is not None
    common_spec.loader.exec_module(common_module)
    return common_module


class WeeklyContentTweetGateTests(unittest.TestCase):
    def test_weekly_review_title_is_detected(self):
        common_module = load_common_module()

        weekly = {"title": "SIndustries website content - 2026-07-24 weekly review (Tom approved)"}
        legacy = {"title": "SIndustries weekly content updates - 2026-06-26"}
        other = {"title": "content: add homepage hero copy"}

        self.assertTrue(common_module.task_is_weekly_content(weekly))
        self.assertTrue(common_module.task_is_weekly_content(legacy))
        self.assertFalse(common_module.task_is_weekly_content(other))

    def test_tweets_queued_comment_detection(self):
        common_module = load_common_module()

        without = {"comments": [{"text": "[ivy-prs] quinn: https://github.com/Stoffer-Industries/sindustries/pull/1"}]}
        with_comment = {
            "comments": [
                {"text": "[ivy-prs] quinn: https://github.com/Stoffer-Industries/sindustries/pull/1"},
                {"text": "[ivy-tweets-queued] theme: agent factory\n- abc123 - first tweet"},
            ]
        }

        self.assertFalse(common_module.has_ivy_tweets_queued(without))
        self.assertTrue(common_module.has_ivy_tweets_queued(with_comment))

    def test_non_weekly_task_is_not_gated_by_tweets_comment(self):
        # sanity check: task_is_weekly_content is what gates the failure - a normal
        # content task must not require the tweets-queued comment.
        common_module = load_common_module()

        normal = {"title": "content: update stack list", "comments": []}
        self.assertFalse(common_module.task_is_weekly_content(normal))
        self.assertFalse(common_module.has_ivy_tweets_queued(normal))


if __name__ == "__main__":
    unittest.main()
