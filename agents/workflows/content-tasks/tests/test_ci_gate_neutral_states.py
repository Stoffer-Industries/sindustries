"""
Regression coverage for the CI gate rollup used by the content-task lobster.

Bug (found via task 80dd4479 / PR #819): deploy-gated jobs are routinely SKIPPED
or CANCELLED on changes that do not touch them. `gh_pr_ci_state` listed CANCELLED
among hard failure states, and `ci_failures_for_pr` reported every non-SUCCESS
check verbatim. PR #819 has green merge gates plus deploy-only skipped/cancelled
runs, so the rollup returned FAILURE and the lobster kept `criteria_met=false`,
blocking a task whose delivery evidence was in fact complete.

Fixed semantics:
- SKIPPED / CANCELLED are NEUTRAL. They never decide the rollup on their own.
- Hard failures (FAILURE/FAILED/ERROR/TIMED_OUT/ACTION_REQUIRED) win outright.
- Pending outranks success, so an in-flight check is never reported as a pass.
- At least one real SUCCESS + only neutral states => SUCCESS.
- An all-neutral rollup stays UNKNOWN (nothing ran to justify a pass).
- `ci_failures_for_pr` no longer names neutral checks as failures.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from common import CI_FAILURE_STATES, CI_NEUTRAL_STATES, CI_PENDING_STATES, gh_pr_ci_state  # noqa: E402
import pr_transition  # noqa: E402


def _checks(*states: str) -> list[dict[str, str]]:
    return [{"name": f"check-{i}", "state": state} for i, state in enumerate(states)]


def _rollup(checks: list[dict[str, str]]) -> str:
    """Reimplement the fixed rollup locally so ci_failures tests stay hermetic."""
    states = [c["state"] for c in checks]
    if not states:
        return "UNKNOWN"
    if any(s in CI_FAILURE_STATES for s in states):
        return "FAILURE"
    if any(s in CI_PENDING_STATES for s in states):
        return "PENDING"
    substantive = [s for s in states if s not in CI_NEUTRAL_STATES]
    if substantive and all(s == "SUCCESS" for s in substantive):
        return "SUCCESS"
    return "UNKNOWN"


class GhPrCiStateTests(unittest.TestCase):
    def _state(self, *states: str) -> str:
        # gh_pr_ci_state lives in `common` and resolves gh_pr_ci_checks from the
        # same module namespace, so patching the source module is sufficient.
        with mock.patch("common.gh_pr_ci_checks", return_value=_checks(*states)):
            return gh_pr_ci_state("https://github.com/o/r/pull/1")

    def test_no_checks_is_unknown(self) -> None:
        self.assertEqual(self._state(), "UNKNOWN")

    def test_pr819_shape_succeeds(self) -> None:
        """The real PR #819 rollup: green merge gates + deploy-gated noise."""
        states = ["SUCCESS"] * 9 + ["SKIPPED"] * 20 + ["CANCELLED"]
        self.assertEqual(self._state(*states), "SUCCESS")

    def test_cancelled_alone_is_neutral_not_failure(self) -> None:
        self.assertEqual(self._state("SUCCESS", "CANCELLED"), "SUCCESS")

    def test_skipped_and_cancelled_never_alone_imply_success(self) -> None:
        self.assertEqual(self._state("SKIPPED", "CANCELLED"), "UNKNOWN")

    def test_all_skipped_is_unknown(self) -> None:
        self.assertEqual(self._state("SKIPPED", "SKIPPED"), "UNKNOWN")

    def test_hard_failure_beats_success_and_neutral(self) -> None:
        self.assertEqual(self._state("SUCCESS", "SKIPPED", "FAILURE"), "FAILURE")

    def test_timeout_is_a_hard_failure(self) -> None:
        self.assertEqual(self._state("SUCCESS", "TIMED_OUT"), "FAILURE")

    def test_pending_outranks_success(self) -> None:
        self.assertEqual(self._state("SUCCESS", "PENDING"), "PENDING")

    def test_pending_outranks_neutral_only_rollup(self) -> None:
        self.assertEqual(self._state("SKIPPED", "IN_PROGRESS"), "PENDING")

    def test_mixed_success_and_skipped_is_success(self) -> None:
        self.assertEqual(self._state("SUCCESS", "SKIPPED"), "SUCCESS")


class CiFailuresForPrTests(unittest.TestCase):
    def _failures(self, *states: str):
        checks = _checks(*states)
        # pr_transition imported both helpers by value, so patch them where used.
        with mock.patch.object(pr_transition, "gh_pr_ci_checks", return_value=checks):
            with mock.patch.object(pr_transition, "gh_pr_ci_state", return_value=_rollup(checks)):
                return pr_transition.ci_failures_for_pr("https://github.com/o/r/pull/1")

    def test_pr819_shape_reports_no_failures(self) -> None:
        failures, _checks_out = self._failures(*(["SUCCESS"] * 9 + ["SKIPPED"] * 20 + ["CANCELLED"]))
        self.assertEqual(failures, [], f"expected no failures, got {failures}")

    def test_cancelled_is_not_reported_as_failure(self) -> None:
        failures, _ = self._failures("SUCCESS", "CANCELLED")
        self.assertEqual(failures, [])

    def test_real_failure_is_still_reported(self) -> None:
        failures, _ = self._failures("SUCCESS", "FAILURE")
        self.assertEqual(len(failures), 1)
        self.assertIn("FAILURE", failures[0])

    def test_neutral_states_are_declared_neutral(self) -> None:
        self.assertEqual(CI_NEUTRAL_STATES, {"SKIPPED", "CANCELLED"})


if __name__ == "__main__":
    unittest.main()