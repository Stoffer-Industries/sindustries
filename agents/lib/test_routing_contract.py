"""Tests for agents.lib.routing_contract — task d38c6aa5 (three-tier model routing).

Run from the repo root::

    python3 -m unittest agents.lib.test_routing_contract -v

The suite covers the three things the contract promises:

1. an empty (or fully blocked) queue routes to the preflight tier and invokes
   no model at all;
2. work categories resolve to exactly one tier, and unknown categories never
   downgrade to the cheap tier;
3. a run that lands on an unexpected tier is recorded as a routing violation
   rather than silently absorbed.
"""

from __future__ import annotations

import json
import pathlib
import sys
import tempfile
import unittest
from datetime import datetime, timezone

_REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from agents.lib import routing_contract as rc  # noqa: E402


class TierResolutionTest(unittest.TestCase):
    def test_every_declared_category_maps_to_a_real_tier(self):
        for category, tier in rc.CATEGORY_TIERS.items():
            self.assertIn(tier, rc.TIERS, f"{category} maps to unknown tier {tier}")

    def test_routine_categories_stay_off_the_expensive_tiers(self):
        for category in ("heartbeat-scan", "routine-summary", "low-risk-review", "background-cognition"):
            self.assertEqual("routine", rc.classify_category(category))

    def test_approved_coding_is_mid_tier_and_separate_from_both_ends(self):
        self.assertEqual("mid", rc.classify_category("approved-coding"))
        self.assertNotEqual("routine", rc.classify_category("approved-coding"))
        self.assertNotEqual("frontier", rc.classify_category("approved-coding"))

    def test_planning_and_escalation_are_frontier(self):
        self.assertEqual("frontier", rc.classify_category("planning"))
        self.assertEqual("frontier", rc.classify_category("escalation"))

    def test_unknown_category_never_downgrades_to_the_cheap_tier(self):
        self.assertEqual(rc.UNCLASSIFIED_TIER, rc.classify_category("something-new"))
        self.assertEqual("frontier", rc.classify_category("something-new"))
        self.assertFalse(rc.is_known_category("something-new"))

    def test_category_lookup_is_case_insensitive(self):
        self.assertEqual("routine", rc.classify_category("Heartbeat-Scan"))


class ModelTierTest(unittest.TestCase):
    def test_known_models_map_to_their_tier(self):
        self.assertEqual("routine", rc.model_tier("minimax-portal/MiniMax-M3"))
        self.assertEqual("mid", rc.model_tier("anthropic/claude-sonnet-5"))
        self.assertEqual("frontier", rc.model_tier("openai/gpt-5.4"))

    def test_unknown_model_is_not_assigned_a_tier(self):
        self.assertIsNone(rc.model_tier("some-vendor/unknown-model"))
        self.assertIsNone(rc.model_tier(""))


class PreflightTest(unittest.TestCase):
    def test_empty_queue_skips_the_model_entirely(self):
        decision = rc.preflight({"queue": [], "topCandidate": None}, "heartbeat-scan", agent="Quinn")
        self.assertEqual(rc.DECISION_SKIP, decision.decision)
        self.assertEqual(rc.PREFILIGHT_TIER, decision.tier)
        self.assertFalse(decision.model_invoked)
        self.assertEqual("empty-queue", decision.reason)

    def test_blocked_only_queue_is_treated_as_empty(self):
        queue = {
            "queue": [
                {"id": "a", "actionable": False, "classification": "BLOCKED"},
                {"id": "b", "actionable": False, "classification": "BLOCKED"},
            ]
        }
        decision = rc.preflight(queue, "heartbeat-scan")
        self.assertEqual(rc.DECISION_SKIP, decision.decision)
        self.assertFalse(decision.model_invoked)

    def test_queued_work_proceeds_on_the_category_tier(self):
        queue = {"queue": [{"id": "a", "actionable": True, "classification": "ACTIONABLE"}]}
        decision = rc.preflight(queue, "heartbeat-scan", agent="Quinn")
        self.assertEqual(rc.DECISION_PROCEED, decision.decision)
        self.assertEqual("routine", decision.tier)
        self.assertTrue(decision.model_invoked)
        self.assertEqual(1, decision.work_count)

    def test_queued_coding_work_proceeds_on_the_mid_tier(self):
        queue = {"queue": [{"id": "a", "actionable": True}]}
        decision = rc.preflight(queue, "approved-coding")
        self.assertEqual("mid", decision.tier)

    def test_unclassified_category_is_flagged_but_still_routes_somewhere(self):
        queue = {"queue": [{"id": "a", "actionable": True}]}
        decision = rc.preflight(queue, "brand-new-work")
        self.assertTrue(decision.unclassified)
        self.assertEqual("frontier", decision.tier)

    def test_unknown_decision_never_means_skip(self):
        decision = rc.unknown_decision("heartbeat-scan", agent="Quinn")
        self.assertEqual(rc.DECISION_UNKNOWN, decision.decision)
        self.assertFalse(decision.skipped)


class ViolationTest(unittest.TestCase):
    def test_matching_run_is_not_a_violation(self):
        self.assertIsNone(rc.check_declaration("routine", actual_model="minimax-portal/MiniMax-M3"))

    def test_routine_work_on_the_frontier_tier_is_a_violation(self):
        violation = rc.check_declaration("routine", actual_model="openai/gpt-5.4")
        self.assertIsNotNone(violation)
        self.assertEqual("violation", violation["kind"])
        self.assertEqual("routine", violation["declaredTier"])
        self.assertEqual("frontier", violation["actualTier"])

    def test_unmeasurable_run_is_reported_as_unmeasured(self):
        violation = rc.check_declaration("routine", actual_model=None)
        self.assertEqual("unmeasured", violation["kind"])


class CounterStateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state_path = pathlib.Path(self.tmp.name) / "counters.json"

    def test_skipped_pass_counts_under_the_preflight_bucket(self):
        state = rc.load_state(self.state_path)
        decision = rc.preflight({"queue": []}, "heartbeat-scan")
        rc.record_decision(state, decision, day="2026-11-06")
        counters = rc.daily_counts(state, "2026-11-06")["heartbeat-scan"]
        self.assertEqual(1, counters["preflight"])
        self.assertEqual(0, counters["routine"])
        self.assertEqual(0, counters["frontier"])

    def test_proceeded_pass_counts_under_its_tier(self):
        state = rc.load_state(self.state_path)
        decision = rc.preflight({"queue": [{"actionable": True}]}, "heartbeat-scan")
        rc.record_decision(state, decision, day="2026-11-06")
        counters = rc.daily_counts(state, "2026-11-06")["heartbeat-scan"]
        self.assertEqual(1, counters["routine"])
        self.assertEqual(0, counters["preflight"])

    def test_frontier_counts_are_visible_per_category_per_day(self):
        state = rc.load_state(self.state_path)
        for _ in range(3):
            decision = rc.preflight({"queue": [{"actionable": True}]}, "planning")
            rc.record_decision(state, decision, day="2026-11-06")
        counts = rc.daily_counts(state, "2026-11-06")
        self.assertEqual(3, counts["planning"]["frontier"])

        rc.record_decision(state, decision, day="2026-11-07")
        self.assertEqual(3, rc.daily_counts(state, "2026-11-06")["planning"]["frontier"])
        self.assertEqual(1, rc.daily_counts(state, "2026-11-07")["planning"]["frontier"])

    def test_violation_is_counted_and_kept_in_a_bounded_list(self):
        state = rc.load_state(self.state_path)
        for _ in range(60):
            rc.record_violation(
                state,
                {
                    "kind": "violation",
                    "declaredTier": "routine",
                    "actualTier": "frontier",
                    "actualModel": "openai/gpt-5.4",
                    "category": "heartbeat-scan",
                    "agent": "Quinn",
                },
                day="2026-11-06",
            )
        counters = rc.daily_counts(state, "2026-11-06")["heartbeat-scan"]
        self.assertEqual(60, counters["violation"])
        self.assertLessEqual(len(state["violations"]), 50)

    def test_state_round_trips_through_disk(self):
        state = rc.load_state(self.state_path)
        rc.record_decision(state, rc.preflight({"queue": []}, "heartbeat-scan"), day="2026-11-06")
        rc.save_state(state, self.state_path)
        reloaded = rc.load_state(self.state_path)
        self.assertEqual(1, rc.daily_counts(reloaded, "2026-11-06")["heartbeat-scan"]["preflight"])

    def test_corrupt_state_file_falls_back_to_an_empty_state(self):
        self.state_path.write_text("{not json")
        state = rc.load_state(self.state_path)
        self.assertEqual({}, rc.daily_counts(state, "2026-11-06"))

    def test_stats_render_names_the_day_and_the_categories(self):
        state = rc.load_state(self.state_path)
        rc.record_decision(state, rc.preflight({"queue": [{"actionable": True}]}, "heartbeat-scan"), day="2026-11-06")
        rendered = rc.render_stats(state, "2026-11-06")
        self.assertIn("2026-11-06", rendered)
        self.assertIn("heartbeat-scan", rendered)
        self.assertIn("routine", rendered)


class EventLogTest(unittest.TestCase):
    def test_events_are_appended_as_json_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "events.jsonl"
            rc.append_event({"at": datetime.now(timezone.utc).isoformat(), "decision": "skip"}, path)
            rc.append_event({"at": datetime.now(timezone.utc).isoformat(), "decision": "proceed"}, path)
            lines = [line for line in path.read_text().splitlines() if line.strip()]
            self.assertEqual(2, len(lines))
            self.assertEqual("skip", json.loads(lines[0])["decision"])


class CliTest(unittest.TestCase):
    """The CLI is the scheduler-facing surface; check its two output shapes."""

    def _run(self, argv, cwd=None):
        import subprocess

        script = _REPO_ROOT / "agents" / "cron" / "routing_preflight.py"
        proc = subprocess.run(
            [sys.executable, str(script), *argv],
            capture_output=True,
            text=True,
            cwd=str(cwd or _REPO_ROOT),
            timeout=120,
        )
        return proc

    def test_empty_queue_probe_prints_the_silent_token_on_stdout(self):
        with tempfile.TemporaryDirectory() as tmp:
            queue_file = pathlib.Path(tmp) / "queue.json"
            queue_file.write_text(json.dumps({"queue": []}))
            proc = self._run(
                [
                    "--agent", "Quinn",
                    "--category", "heartbeat-scan",
                    "--queue-file", str(queue_file),
                    "--state-file", str(pathlib.Path(tmp) / "counters.json"),
                    "--event-log", str(pathlib.Path(tmp) / "events.jsonl"),
                ]
            )
            self.assertEqual(0, proc.returncode, proc.stderr)
            self.assertEqual("NO_REPLY", proc.stdout.strip())
            self.assertIn("empty-queue", proc.stderr)

    def test_queued_work_probe_reports_the_declared_tier(self):
        with tempfile.TemporaryDirectory() as tmp:
            queue_file = pathlib.Path(tmp) / "queue.json"
            queue_file.write_text(json.dumps({"queue": [{"actionable": True, "id": "x"}]}))
            proc = self._run(
                [
                    "--agent", "Quinn",
                    "--category", "heartbeat-scan",
                    "--queue-file", str(queue_file),
                    "--state-file", str(pathlib.Path(tmp) / "counters.json"),
                    "--event-log", str(pathlib.Path(tmp) / "events.jsonl"),
                ]
            )
            self.assertEqual(0, proc.returncode, proc.stderr)
            self.assertIn("proceed", proc.stdout)
            self.assertIn("tier=routine", proc.stdout)

    def test_heartbeat_mode_prints_the_queue_with_the_decision_attached(self):
        with tempfile.TemporaryDirectory() as tmp:
            queue_file = pathlib.Path(tmp) / "queue.json"
            queue_file.write_text(json.dumps({"queue": [{"actionable": True, "id": "x"}]}))
            proc = self._run(
                [
                    "--agent", "Quinn",
                    "--mode", "heartbeat",
                    "--queue-file", str(queue_file),
                    "--state-file", str(pathlib.Path(tmp) / "counters.json"),
                    "--event-log", str(pathlib.Path(tmp) / "events.jsonl"),
                ]
            )
            self.assertEqual(0, proc.returncode, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertIn("routingDecision", payload)
            self.assertEqual("routine", payload["routingDecision"]["tier"])
            self.assertEqual(1, len(payload["queue"]))

    def test_broken_queue_file_fails_open_instead_of_skipping(self):
        with tempfile.TemporaryDirectory() as tmp:
            queue_file = pathlib.Path(tmp) / "queue.json"
            queue_file.write_text("{not json")
            proc = self._run(
                [
                    "--agent", "Quinn",
                    "--queue-file", str(queue_file),
                    "--state-file", str(pathlib.Path(tmp) / "counters.json"),
                    "--event-log", str(pathlib.Path(tmp) / "events.jsonl"),
                ]
            )
            self.assertEqual(0, proc.returncode, proc.stderr)
            self.assertIn("PREFLIGHT-UNKNOWN", proc.stderr)
            self.assertNotEqual("NO_REPLY", proc.stdout.strip())


if __name__ == "__main__":
    unittest.main()
