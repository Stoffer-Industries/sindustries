#!/usr/bin/env python3
from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import patch

content_scripts = os.path.join(os.path.dirname(__file__), "..", "agents/workflows/content-tasks/scripts")
loaded_common = sys.modules.pop("common", None)
loaded_path = sys.path[:]
sys.path.insert(0, content_scripts)
try:
    import common as content_common  # noqa: E402
    import format_transition as content_format_transition  # noqa: E402
    from common import ANY_HEADING_RE, OWNER_HEADING_RE, PR_HEADING_RE  # noqa: E402
    from pr_transition import owner_heading_index, owner_sections  # noqa: E402
finally:
    sys.path[:] = loaded_path
    sys.modules.pop("common", None)
    if loaded_common is not None:
        sys.modules["common"] = loaded_common


DESCRIPTION = """**Source:** brain/content/sindustries-weekly-content/2026-07-31.md

---

## Quinn can execute
[PR #337](https://github.com/Stoffer-Industries/sindustries/pull/337)
- [x] ADD release — shipped update

## Needs Tom approval
[PR #338](https://github.com/Stoffer-Industries/sindustries/pull/338)
- [ ] EDIT experiment/gymtrack — publish it
"""


class ContentTaskHeadingTests(unittest.TestCase):
    def test_format_transition_imports_workspace_from_common(self):
        self.assertEqual(content_format_transition.WORKSPACE, content_common.WORKSPACE)
        self.assertEqual(
            content_common.TASKS_CLIENT_DIR,
            content_common._SINDUSTRIES_ROOT / "agents" / "skills" / "ops" / "tasks-api",
        )

    def test_owner_sections_preserve_heading_text_after_a_preceding_newline(self):
        sections = owner_sections(DESCRIPTION)

        self.assertEqual(len(sections), 2)
        self.assertEqual(sections[0][0].splitlines()[0], "## Quinn can execute")
        self.assertEqual(sections[1][0].splitlines()[0], "## Needs Tom approval")

    def test_explicit_owner_routes_map_to_their_headings(self):
        self.assertEqual(owner_heading_index(DESCRIPTION, "quinn"), 0)
        self.assertEqual(owner_heading_index(DESCRIPTION, "tom"), 1)

    def test_heading_patterns_do_not_consume_preceding_newlines(self):
        text = "intro\n\n## PR #337\n\n## Quinn can execute\n"

        for pattern in (PR_HEADING_RE, OWNER_HEADING_RE, ANY_HEADING_RE):
            match = pattern.search(text)
            self.assertIsNotNone(match)
            self.assertFalse(match.group(0).startswith("\n"))

    def test_tweets_queued_accepts_traceability_comment(self):
        task = {
            "comments": [
                {
                    "text": "[ivy-tweets-queued] theme: Agents as first-class users\n"
                    "- tweet-id — launch context"
                }
            ]
        }

        self.assertTrue(content_common.has_ivy_tweets_queued(task))

    def test_tweets_queued_rejects_blocker_text_that_mentions_tag(self):
        task = {
            "comments": [
                {
                    "text": "Tweet campaign is blocked; "
                    "`[ivy-tweets-queued]` remains pending."
                }
            ]
        }

        self.assertFalse(content_common.has_ivy_tweets_queued(task))

    @patch.object(content_common, "gh_api")
    def test_pr_routing_uses_rest_user_endpoints(self, gh_api):
        gh_api.side_effect = [
            {"assignees": [{"login": "ivystoffer"}]},
            {"users": [{"login": "stoff81"}]},
            [{"user": {"login": "quinnstoffer"}}],
        ]
        url = "https://github.com/Stoffer-Industries/sindustries/pull/337"

        self.assertEqual(content_common.gh_pr_assignees(url), ["ivystoffer"])
        self.assertEqual(content_common.gh_pr_reviewers(url), ["stoff81", "quinnstoffer"])
        self.assertEqual(
            [call.args[0] for call in gh_api.call_args_list],
            [
                "repos/Stoffer-Industries/sindustries/pulls/337",
                "repos/Stoffer-Industries/sindustries/pulls/337/requested_reviewers",
                "repos/Stoffer-Industries/sindustries/pulls/337/reviews",
            ],
        )


if __name__ == "__main__":
    unittest.main()
