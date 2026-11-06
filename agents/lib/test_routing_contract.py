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
import re
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

    def test_tier_examples_agree_with_the_model_rules(self):
        """A tier must not advertise a model the rules put on another tier."""
        for tier, entry in rc.TIERS.items():
            for example in entry["examples"]:
                if example.endswith("*"):
                    probe = example[:-1] + "probe"
                else:
                    probe = example
                resolved = rc.model_tier(probe)
                self.assertEqual(
                    tier,
                    resolved,
                    f"{example} is advertised as a {tier} example but the rules resolve it to {resolved}",
                )


class PreflightTest(unittest.TestCase):
    def test_empty_queue_skips_the_model_entirely(self):
        decision = rc.preflight({"queue": [], "topCandidate": None}, "heartbeat-scan", agent="Quinn")
        self.assertEqual(rc.DECISION_SKIP, decision.decision)
        self.assertEqual(rc.PREFILIGHT_TIER, decision.tier)
        self.assertFalse(decision.model_declared)
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
        self.assertFalse(decision.model_declared)

    def test_queued_work_proceeds_on_the_category_tier(self):
        queue = {"queue": [{"id": "a", "actionable": True, "classification": "ACTIONABLE"}]}
        decision = rc.preflight(queue, "heartbeat-scan", agent="Quinn")
        self.assertEqual(rc.DECISION_PROCEED, decision.decision)
        self.assertEqual("routine", decision.tier)
        self.assertTrue(decision.model_declared)
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

    def test_unclassified_category_has_its_own_column(self):
        state = rc.load_state(self.state_path)
        rc.record_decision(state, rc.preflight({"queue": [{"actionable": True}]}, "brand-new-work"), day="2026-11-06")
        counters = rc.daily_counts(state, "2026-11-06")["brand-new-work"]
        self.assertEqual(1, counters["unclassified"])
        rendered = rc.render_stats(state, "2026-11-06")
        self.assertIn("unclassified", rendered)

    def test_observed_tier_is_counted_next_to_the_declaration(self):
        state = rc.load_state(self.state_path)
        rc.record_observation(
            state,
            category="heartbeat-scan",
            declared_tier="routine",
            actual_tier="routine",
            actual_model="minimax-portal/MiniMax-M3",
            agent="Quinn",
            day="2026-11-06",
            kind="match",
        )
        counters = rc.daily_counts(state, "2026-11-06")["heartbeat-scan"]
        self.assertEqual(1, counters["observedRoutine"])
        self.assertEqual(0, counters["observedFrontier"])
        self.assertEqual(0, counters["violation"])

    def test_a_run_on_the_wrong_tier_is_visible_in_the_observed_column(self):
        state = rc.load_state(self.state_path)
        rc.record_observation(
            state,
            category="heartbeat-scan",
            declared_tier="routine",
            actual_tier="frontier",
            actual_model="openai/gpt-5.4",
            agent="Quinn",
            day="2026-11-06",
            kind="violation",
        )
        counters = rc.daily_counts(state, "2026-11-06")["heartbeat-scan"]
        self.assertEqual(1, counters["observedFrontier"])
        self.assertEqual(1, counters["violation"])

    def test_concurrent_writers_do_not_lose_counts(self):
        """Two writers on one state file must not drop each other's counts."""
        import subprocess

        script = (
            "import sys; sys.path.insert(0, %r)\n"
            "from agents.lib import routing_contract as rc\n"
            "def bump(state):\n"
            "    rc.record_decision(state, rc.preflight({'queue': [{'actionable': True}]}, 'heartbeat-scan'), day='2026-11-06')\n"
            "rc.mutate_state(%r, bump)\n"
        ) % (str(_REPO_ROOT), str(self.state_path))
        procs = [
            subprocess.Popen([sys.executable, "-c", script], cwd=str(_REPO_ROOT))
            for _ in range(8)
        ]
        for proc in procs:
            self.assertEqual(0, proc.wait(timeout=120))
        state = rc.load_state(self.state_path)
        self.assertEqual(
            8,
            rc.daily_counts(state, "2026-11-06")["heartbeat-scan"]["routine"],
            "concurrent writers lost counts",
        )

    def test_a_corrupt_state_file_is_archived_not_silently_replaced(self):
        self.state_path.write_text("{not json")
        rc.mutate_state(self.state_path, lambda state: rc.record_decision(
            state, rc.preflight({"queue": [{"actionable": True}]}, "heartbeat-scan"), day="2026-11-06"
        ))
        state = rc.load_state(self.state_path)
        self.assertIn("recoveredFrom", state)
        archived = pathlib.Path(state["recoveredFrom"])
        self.assertTrue(archived.exists(), "the corrupt file was not archived")
        self.assertIn("recovered", rc.render_stats(state, "2026-11-06"))

    def test_state_writes_use_a_unique_temp_file(self):
        """A fixed temp path is what let concurrent writers publish a truncated file."""
        state = rc.load_state(self.state_path)
        rc.save_state(state, self.state_path)
        leftovers = list(self.state_path.parent.glob("*.tmp"))
        self.assertEqual([], leftovers, "a temp file was left behind")


class ContractDocTest(unittest.TestCase):
    """The written contract and the code must not drift apart."""

    DOC = _REPO_ROOT / "docs" / "systems" / "model-routing-contract.md"

    def test_doc_category_table_matches_the_code(self):
        text = self.DOC.read_text()
        rows = re.findall(r"^\|\s*`([a-z0-9-]+)`\s*\|\s*([a-z]+)\s*\|$", text, flags=re.MULTILINE)
        self.assertTrue(rows, "no category table rows found in the contract doc")
        documented = {category: tier for category, tier in rows}
        self.assertEqual(
            documented,
            rc.CATEGORY_TIERS,
            "the contract doc's category table differs from CATEGORY_TIERS",
        )

    def test_doc_names_every_tier(self):
        text = self.DOC.read_text()
        for tier in rc.TIERS:
            self.assertIn(f"`{tier}`", text, f"tier {tier} is missing from the contract doc")

    def test_doc_model_examples_match_the_code(self):
        """The tier table's "Models in use" column must match TIERS[...]['examples']."""
        text = self.DOC.read_text()
        rows = re.findall(
            r"^\|\s*`([a-z]+)`\s*\|\s*[a-z-]+\s*\|\s*(.+?)\s*\|",
            text,
            flags=re.MULTILINE,
        )
        documented = {tier: models for tier, models in rows if tier in rc.TIERS}
        self.assertTrue(documented, "no tier table rows found in the contract doc")
        for tier, models in documented.items():
            parsed = set(re.findall(r"`([^`]+)`", models))
            self.assertEqual(
                set(rc.TIERS[tier]["examples"]),
                parsed,
                f"the contract doc's {tier} model list differs from TIERS",
            )


class EventLogTest(unittest.TestCase):
    def test_events_are_appended_as_json_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "events.jsonl"
            rc.append_event({"at": datetime.now(timezone.utc).isoformat(), "decision": "skip"}, path)
            rc.append_event({"at": datetime.now(timezone.utc).isoformat(), "decision": "proceed"}, path)
            lines = [line for line in path.read_text().splitlines() if line.strip()]
            self.assertEqual(2, len(lines))
            self.assertEqual("skip", json.loads(lines[0])["decision"])


class DeclarationRecordTest(unittest.TestCase):
    """AC7 — the declaration is recorded alongside the invocation."""

    def test_recorded_decision_keeps_the_declared_tier(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = rc.load_state(pathlib.Path(tmp) / "counters.json")
            decision = rc.preflight({"queue": [{"actionable": True}]}, "approved-coding")
            rc.record_decision(state, decision, day="2026-11-06")
            counters = rc.daily_counts(state, "2026-11-06")["approved-coding"]
            self.assertEqual(1, counters["mid"])
            self.assertEqual(0, counters["routine"])
            self.assertEqual(0, counters["frontier"])


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

    def test_trigger_mode_does_not_fire_on_an_empty_queue(self):
        """`fire:false` is the only construction where an empty pass is free."""
        with tempfile.TemporaryDirectory() as tmp:
            queue_file = pathlib.Path(tmp) / "queue.json"
            queue_file.write_text(json.dumps({"queue": []}))
            proc = self._run(
                [
                    "--agent", "Quinn",
                    "--category", "heartbeat-scan",
                    "--mode", "trigger",
                    "--queue-file", str(queue_file),
                    "--state-file", str(pathlib.Path(tmp) / "counters.json"),
                    "--event-log", str(pathlib.Path(tmp) / "events.jsonl"),
                ]
            )
            self.assertEqual(0, proc.returncode, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertFalse(payload["fire"])
            self.assertIn("state", payload)
            self.assertNotIn("message", payload)

    def test_trigger_mode_fires_with_a_self_contained_message(self):
        with tempfile.TemporaryDirectory() as tmp:
            queue_file = pathlib.Path(tmp) / "queue.json"
            queue_file.write_text(json.dumps({"queue": [{"actionable": True, "id": "x"}]}))
            proc = self._run(
                [
                    "--agent", "Quinn",
                    "--category", "heartbeat-scan",
                    "--mode", "trigger",
                    "--queue-file", str(queue_file),
                    "--state-file", str(pathlib.Path(tmp) / "counters.json"),
                    "--event-log", str(pathlib.Path(tmp) / "events.jsonl"),
                ]
            )
            self.assertEqual(0, proc.returncode, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertTrue(payload["fire"])
            self.assertIn("routine", payload["message"])

    def test_trigger_mode_fails_open_when_the_queue_cannot_be_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            queue_file = pathlib.Path(tmp) / "queue.json"
            queue_file.write_text("{not json")
            proc = self._run(
                [
                    "--agent", "Quinn",
                    "--mode", "trigger",
                    "--queue-file", str(queue_file),
                    "--state-file", str(pathlib.Path(tmp) / "counters.json"),
                    "--event-log", str(pathlib.Path(tmp) / "events.jsonl"),
                ]
            )
            self.assertEqual(0, proc.returncode, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertTrue(payload["fire"], "a broken queue read must never mute the pass")

    def test_record_actual_counts_the_observed_tier(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = pathlib.Path(tmp) / "counters.json"
            proc = self._run(
                [
                    "--record-actual",
                    "--agent", "Quinn",
                    "--category", "heartbeat-scan",
                    "--declared-tier", "routine",
                    "--actual-model", "minimax-portal/MiniMax-M3",
                    "--state-file", str(state_file),
                    "--event-log", str(pathlib.Path(tmp) / "events.jsonl"),
                ]
            )
            self.assertEqual(0, proc.returncode, proc.stderr)
            self.assertIn("match", proc.stdout)
            state = rc.load_state(state_file)
            counters = rc.daily_counts(state)["heartbeat-scan"]
            self.assertEqual(1, counters["observedRoutine"])

    def test_record_actual_without_a_category_lands_in_the_global_bucket(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = pathlib.Path(tmp) / "counters.json"
            proc = self._run(
                [
                    "--record-actual",
                    "--agent", "Quinn",
                    "--declared-tier", "routine",
                    "--actual-model", "openai/gpt-5.4",
                    "--state-file", str(state_file),
                    "--event-log", str(pathlib.Path(tmp) / "events.jsonl"),
                ]
            )
            self.assertEqual(0, proc.returncode, proc.stderr)
            state = rc.load_state(state_file)
            counts = rc.daily_counts(state)
            self.assertNotIn("heartbeat-scan", counts, "an uncategorised run was mis-filed")
            self.assertEqual(1, counts["__global__"]["observedFrontier"])


class HeartbeatWiringTest(unittest.TestCase):
    """AC7 — the declaration must be recorded next to the invocation.

    The heartbeat is the only caller of ``--record-actual``; if the agent
    definition stops calling it, the counters silently fall back to
    declarations only.
    """

    HEARTBEAT = _REPO_ROOT / "agents" / "definitions" / "quinn" / "HEARTBEAT.md"

    def test_the_heartbeat_records_what_actually_ran(self):
        text = self.HEARTBEAT.read_text()
        self.assertIn("--record-actual", text, "the heartbeat never records the actual tier")
        self.assertIn("--declared-tier", text, "the heartbeat records the actual tier without a declaration")

    def test_the_heartbeat_does_not_hardcode_one_category(self):
        text = self.HEARTBEAT.read_text()
        self.assertNotIn(
            "--category heartbeat-scan",
            text,
            "the heartbeat hardcodes a single work category, so every pass looks the same",
        )


if __name__ == "__main__":
    unittest.main()
