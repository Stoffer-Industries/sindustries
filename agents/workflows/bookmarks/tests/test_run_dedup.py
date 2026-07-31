#!/usr/bin/env python3
"""Regression test for run.py's is_all_deduped() dedup detection.

Bug history: run.py previously required *every* blockedPackages entry to
carry the reason string "approval already pending for topic" for the dedup
(waiting_on_approval) path to trigger. But:
  1. request_topic_approval.py never emits that string \u2014 it emits
     "approval already pending globally".
  2. Even after fixing the string, requiring all() to match is wrong: when
     more than one ready package exists, only the *first* is blocked with
     "approval already pending globally" \u2014 the rest are blocked with the
     unrelated "single approval per run policy" reason.

Both defects combined meant the dedup path was unreachable whenever a
global approval lock was held and more than one package was ready. Every
cron run instead fell through to the ambiguous needs_approval branch with
an empty approvals list, which sent the (MiniMax) cron agent into a long
reasoning loop trying to reconcile "needs_approval" against an empty
approvals array \u2014 causing the 2026-08-01 Bookmark Review Lobster error
streak (cron 1d8a3cf1, 3 consecutive "Agent couldn't generate a response").

Fix: is_all_deduped() now uses any() instead of all(), and checks the
reason string request_topic_approval.py actually emits.
"""
from __future__ import annotations

import sys
from pathlib import Path

THIS_DIR = Path(__file__).resolve().parent
WORKFLOW_DIR = THIS_DIR.parent
if str(WORKFLOW_DIR) not in sys.path:
    sys.path.insert(0, str(WORKFLOW_DIR))

import unittest

from run import is_all_deduped  # noqa: E402


class TestIsAllDeduped(unittest.TestCase):
    def test_single_blocked_package_matches(self):
        approval_result = {
            "approvals": [],
            "blockedPackages": [
                {"reason": "approval already pending globally"},
            ],
        }
        self.assertTrue(is_all_deduped(approval_result))

    def test_mixed_blocked_reasons_still_dedups(self):
        """Reproduces the real 2026-08-01 payload shape: one package blocked
        globally, others blocked by the unrelated single-approval-per-run cap.
        Prior code (all()) failed this case."""
        approval_result = {
            "approvals": [],
            "blockedPackages": [
                {"reason": "single approval per run policy"},
                {"reason": "approval already pending globally"},
            ],
        }
        self.assertTrue(is_all_deduped(approval_result))

    def test_new_approvals_present_is_not_deduped(self):
        approval_result = {
            "approvals": [{"topic": "outreach"}],
            "blockedPackages": [
                {"reason": "approval already pending globally"},
            ],
        }
        self.assertFalse(is_all_deduped(approval_result))

    def test_no_global_lock_reason_is_not_deduped(self):
        approval_result = {
            "approvals": [],
            "blockedPackages": [
                {"reason": "single approval per run policy"},
                {"reason": "no spec docs — spec needs to be written before approval can be requested"},
            ],
        }
        self.assertFalse(is_all_deduped(approval_result))

    def test_stale_reason_string_no_longer_matches(self):
        """The old (wrong) reason string request_topic_approval.py never emits
        should NOT match \u2014 guards against silently reintroducing the bug."""
        approval_result = {
            "approvals": [],
            "blockedPackages": [
                {"reason": "approval already pending for topic"},
            ],
        }
        self.assertFalse(is_all_deduped(approval_result))

    def test_empty_blocked_packages(self):
        approval_result = {"approvals": [], "blockedPackages": []}
        self.assertFalse(is_all_deduped(approval_result))


if __name__ == "__main__":
    unittest.main()
