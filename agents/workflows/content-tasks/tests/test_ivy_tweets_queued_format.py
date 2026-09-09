"""
Tests for the [ivy-tweets-queued] traceability comment format after the thread/standalone
split introduced for task 1016cbff (PR C).

The pre-existing IVY_TWEETS_QUEUED_RE in common.py (`^\[ivy-tweets-queued\]\s+theme:\s+\S`)
continues to gate the `doing -> acceptance` transition; these tests pin the new structure
the lobster guidance now asks Ivy to produce:
- Every entry tagged `(single)` or `(thread, N parts)` with N as the actual part count.
- Every entry includes a one-line purpose (AC5 audit trail).

The expected format is documented in `agents/definitions/ivy/HEARTBEAT.md` under
"Weekly tweet campaign" -> "Post the traceability comment".
"""

from __future__ import annotations

import re
import unittest
from typing import Any

import sys
from pathlib import Path

# Make `scripts.common` importable when running from the test runner.
SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from common import (  # noqa: E402
    IVY_TWEETS_QUEUED_RE,
    comment_text,
    has_ivy_tweets_queued,
    task_comments,
)


# Match `- <id> (single) — <purpose>` or `- <id> (thread, N parts) — <purpose>`.
ENTRY_LINE_RE = re.compile(
    r"^- (?P<id>[0-9a-fA-F-]{36}) "
    r"\((?P<kind>single|thread(?:, \d+ parts)?)\) "
    r"— (?P<purpose>.+)$"
)


def _comment(text: str, author: str = "Ivy") -> dict[str, Any]:
    return {"author": author, "text": text, "createdAt": "2026-09-09T05:00:00Z"}


def _task(comments: list[dict[str, Any]]) -> dict[str, Any]:
    return {"id": "1016cbff-7925-4beb-becf-3b833dd66578", "comments": comments}


class IvyTweetsQueuedFormatTest(unittest.TestCase):
    def test_minimal_valid_comment_passes_existing_gate(self) -> None:
        """The legacy regex must still match a comment that introduces (single)/(thread) tags."""
        text = (
            "[ivy-tweets-queued] theme: ship a 10-day calendar view\n"
            "- 11111111-1111-1111-1111-111111111111 (single) — opens with the build arc\n"
            "- 22222222-2222-2222-2222-222222222222 (thread, 3 parts) — deep-dive into the calendar\n"
        )
        self.assertTrue(bool(IVY_TWEETS_QUEUED_RE.match(text)))
        self.assertTrue(has_ivy_tweets_queued(_task([_comment(text)])))

    def test_every_entry_must_have_kind_tag_and_purpose(self) -> None:
        text = (
            "[ivy-tweets-queued] theme: ship a 10-day calendar view\n"
            "- 11111111-1111-1111-1111-111111111111 (single) — opens with the build arc\n"
            "- 22222222-2222-2222-2222-222222222222 (thread, 3 parts) — deep-dive into the calendar\n"
            "- 33333333-3333-3333-3333-333333333333 (single) — closes the week with the lesson\n"
        )
        comment = _comment(text)
        self.assertTrue(has_ivy_tweets_queued(_task([comment])))
        body_lines = comment_text(comment).splitlines()
        # Drop the theme line; only check entry lines.
        entry_lines = [ln for ln in body_lines if ln.startswith("- ")]
        self.assertEqual(len(entry_lines), 3)
        for line in entry_lines:
            self.assertRegex(
                line,
                ENTRY_LINE_RE,
                f"Entry line must be `- <id> (single|thread, N parts) — <purpose>`, got: {line!r}",
            )

    def test_thread_entry_requires_numeric_part_count(self) -> None:
        text = (
            "[ivy-tweets-queued] theme: ship a 10-day calendar view\n"
            "- 22222222-2222-2222-2222-222222222222 (thread, three parts) — deep-dive into the calendar\n"
        )
        comment = _comment(text)
        self.assertTrue(has_ivy_tweets_queued(_task([comment])))
        match = ENTRY_LINE_RE.match(comment_text(comment).splitlines()[1])
        self.assertIsNone(match, "thread entries must use a numeric part count, not a word")

    def test_entry_without_purpose_fails_format_check(self) -> None:
        text = (
            "[ivy-tweets-queued] theme: ship a 10-day calendar view\n"
            "- 11111111-1111-1111-1111-111111111111 (single)\n"
        )
        comment = _comment(text)
        self.assertTrue(has_ivy_tweets_queued(_task([comment])))
        line = comment_text(comment).splitlines()[1]
        self.assertIsNone(
            ENTRY_LINE_RE.match(line),
            "entries without a — purpose segment must not match the structured format",
        )

    def test_scattergun_fallback_uses_single_only(self) -> None:
        text = (
            "[ivy-tweets-queued] theme: none — no clear arc this week, scattergun of 4 strongest signals\n"
            "- 11111111-1111-1111-1111-111111111111 (single) — strongest signal of the week\n"
            "- 22222222-2222-2222-2222-222222222222 (single) — second-strongest signal\n"
        )
        self.assertTrue(has_ivy_tweets_queued(_task([_comment(text)])))
        lines = [ln for ln in comment_text(_comment(text)).splitlines() if ln.startswith("- ")]
        for line in lines:
            self.assertIn("(single)", line, "scattergun fallback may only emit (single) entries")

    def test_legacy_format_without_tags_still_passes_existing_gate(self) -> None:
        """Older comments that pre-date the (single)/(thread) tag requirement still satisfy the gate.

        The regex `IVY_TWEETS_QUEUED_RE` only checks the first line; we add this test so that
        historical comments continue to be accepted and don't block the lobster's sweep.
        """
        text = (
            "[ivy-tweets-queued] theme: ship a 10-day calendar view\n"
            "- 11111111-1111-1111-1111-111111111111 — opens with the build arc\n"
        )
        self.assertTrue(bool(IVY_TWEETS_QUEUED_RE.match(text)))
        self.assertTrue(has_ivy_tweets_queued(_task([_comment(text)])))

    def test_comment_with_only_theme_line_is_invalid(self) -> None:
        text = "[ivy-tweets-queued] theme: ship a 10-day calendar view\n"
        # The existing regex still matches the theme line; this test pins the new requirement
        # that the comment also carry at least one structured entry line.
        comment = _comment(text)
        self.assertTrue(has_ivy_tweets_queued(_task([comment])))
        entry_lines = [ln for ln in comment_text(comment).splitlines() if ln.startswith("- ")]
        self.assertEqual(entry_lines, [])


if __name__ == "__main__":
    unittest.main()
