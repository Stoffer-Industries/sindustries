"""Self-tests for the model-eval harness.

These run in CI and call no model. They exist so the harness cannot rot into
something that looks like a working eval suite:

- every case loads and declares what it needs
- every case's grader separates its known-good control from its known-bad one
  (a grader that passes everything would report every model as excellent, and
  one that fails everything would report every model as useless)
- the graders themselves behave as their contracts say
"""

from __future__ import annotations

import json
import pathlib
import sys
import tempfile
import unittest

EVALS_ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO_ROOT = EVALS_ROOT.parents[1]
for path in (str(EVALS_ROOT), str(REPO_ROOT / "agents" / "lib")):
    if path not in sys.path:
        sys.path.insert(0, path)

from case_registry import (  # noqa: E402  (path set above)
    CaseError,
    compose_prompt,
    load_all_cases,
    load_case,
    validate_controls,
)
from graders import (  # noqa: E402  (path set above)
    GradeResult,
    GraderError,
    _feature_task_binary,
    grade,
)
from invoke import _extract_text  # noqa: E402  (path set above)

# The runner is a script, so load it by path under a distinct name rather than
# `import run`, which would be ambiguous.
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location("eval_runner", EVALS_ROOT / "run.py")
harness = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(harness)


class CaseLoadingTests(unittest.TestCase):
    def test_every_case_loads(self):
        cases = load_all_cases()
        self.assertGreaterEqual(len(cases), 3, "the seed eval set should have at least three cases")

    def test_case_ids_are_unique(self):
        ids = [case.id for case in load_all_cases()]
        self.assertEqual(len(ids), len(set(ids)), f"duplicate case ids: {ids}")

    def test_every_case_declares_its_requirements(self):
        for case in load_all_cases():
            with self.subTest(case=case.id):
                self.assertTrue(case.prompt.strip(), "a case needs a prompt")
                self.assertTrue(case.description.strip(), "a case needs a description")
                self.assertTrue(case.prompt_files, "a case needs at least one fixture")
                for path in case.prompt_files:
                    self.assertTrue(path.exists(), f"missing prompt fixture: {path}")
                self.assertTrue(
                    case.control_must_pass.exists(), "missing known-good control"
                )
                self.assertTrue(
                    case.control_must_fail.exists(), "missing known-bad control"
                )

    def test_missing_case_file_is_reported_not_ignored(self):
        with self.assertRaises(CaseError):
            load_case(EVALS_ROOT / "cases" / "no-such-case")

    def test_case_transport_is_loaded(self):
        for case in load_all_cases():
            with self.subTest(case=case.id):
                self.assertIn(case.transport, ("infer", "agent"))

    def test_invalid_transport_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            case_dir = pathlib.Path(temp_dir) / "bad-case"
            case_dir.mkdir()
            (case_dir / "case.json").write_text(
                """{
  "id": "bad-case",
  "title": "Bad case",
  "description": "Bad case",
  "prompt": "prompt",
  "prompt_files": [],
  "grader": "expected_findings",
  "grader_config": {},
  "controls": {"must_pass": [], "must_fail": []},
  "transport": "carrier-pigeon"
}
"""
            )
            with self.assertRaises(CaseError):
                load_case(case_dir)

    def test_large_case_uses_a_transport_that_accepts_its_prompt(self):
        from invoke import MAX_PROMPT_BYTES

        for case in load_all_cases():
            with self.subTest(case=case.id):
                prompt_size = len(compose_prompt(case).encode("utf-8"))
                if prompt_size <= MAX_PROMPT_BYTES:
                    continue
                self.assertEqual(
                    case.transport,
                    "agent",
                    f"{case.id} is {prompt_size} bytes, too large for infer",
                )


class ModelEnvelopeTests(unittest.TestCase):
    def test_agent_transport_envelope_final_is_read(self):
        payload = {
            "ok": True,
            "status": "ok",
            "final": "The focused tests pass.",
            "payloads": [{"text": "The focused tests pass."}],
        }
        self.assertEqual(_extract_text(payload), "The focused tests pass.")

    def test_agent_transport_envelope_payload_is_read_without_final(self):
        payload = {"ok": True, "status": "ok", "payloads": [{"text": "Ready."}]}
        self.assertEqual(_extract_text(payload), "Ready.")


class FeatureTaskBinaryTests(unittest.TestCase):
    def test_stale_binary_is_not_selected(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            crate = pathlib.Path(temp_dir)
            source = crate / "src" / "ac_parsing.rs"
            source.parent.mkdir()
            source.write_text("fn main() {}\n")
            stale = crate / "target" / "debug" / "feature-task"
            stale.parent.mkdir(parents=True)
            stale.write_text("old")
            source_mtime = source.stat().st_mtime
            stale.touch()
            import os

            os.utime(stale, (source_mtime - 10, source_mtime - 10))
            self.assertIsNone(_feature_task_binary(crate))

    def test_current_binary_is_selected(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            crate = pathlib.Path(temp_dir)
            source = crate / "src" / "ac_parsing.rs"
            source.parent.mkdir()
            source.write_text("fn main() {}\n")
            current = crate / "target" / "debug" / "feature-task"
            current.parent.mkdir(parents=True)
            current.write_text("current")
            self.assertEqual(_feature_task_binary(crate), current)


class ControlValidationTests(unittest.TestCase):
    """The guard that makes a score mean something."""

    def test_every_grader_separates_its_controls(self):
        for case in load_all_cases():
            with self.subTest(case=case.id):
                validation = validate_controls(case)
                self.assertTrue(
                    validation.ok,
                    f"{case.id}: grader does not discriminate its controls: "
                    f"{validation.problems}",
                )
                self.assertTrue(
                    validation.must_pass.passed,
                    f"{case.id}: the known-good control must pass",
                )
                self.assertFalse(
                    validation.must_fail.passed,
                    f"{case.id}: the known-bad control must fail",
                )

    def test_a_grader_that_passes_everything_is_reported_as_broken(self):
        """A grader that cannot fail is not a grader."""
        case = load_case(EVALS_ROOT / "cases" / "planted-defect-review")
        # Grade the known-good control against a config whose expectations can
        # never be met. A grader that still passes has no discriminating power.
        config = dict(case.grader_config)
        config["expected_findings"] = [
            {"id": "impossible", "any_of": ["this-string-appears-in-no-response"]}
        ]
        result = grade(case.control_must_pass.read_text(), case.directory, config)
        self.assertFalse(
            result.passed,
            "a grader that passes a response missing every expected finding is broken",
        )


class GraderContractTests(unittest.TestCase):
    def test_expected_findings_grader_reports_misses_and_false_positives(self):
        case = load_case(EVALS_ROOT / "cases" / "planted-defect-review")
        config = case.grader_config
        expected = config["expected_findings"]
        first = expected[0]["any_of"][0]
        forbidden = config["must_not_mention"][0]["any_of"][0]
        response = f"I found one thing: {first}. I also flagged {forbidden}."

        result = grade(response, case.directory, config)
        self.assertIsInstance(result, GradeResult)
        self.assertEqual(len(result.detail["found"]), 1)
        self.assertEqual(len(result.detail["missed"]), len(expected) - 1)
        self.assertEqual(result.detail["falsePositives"], [config["must_not_mention"][0]["id"]])
        self.assertFalse(result.passed, "a false positive must fail the case")

    def test_a_grader_crash_is_not_a_zero_score(self):
        case = load_case(EVALS_ROOT / "cases" / "planted-defect-review")
        with self.assertRaises(GraderError):
            grade("anything", case.directory, {"grader": "no-such-grader"})

    def test_unknown_grader_is_an_error_not_a_pass(self):
        with self.assertRaises(GraderError):
            grade("anything", EVALS_ROOT, {"grader": "no-such-grader"})

    def test_task_scoped_lobster_control_passes(self):
        case = load_case(EVALS_ROOT / "cases" / "lobster-ac-compliance")
        response = """## Acceptance Criteria

### Task a384d6ac — Prospect scoring

- [x] AC1: Prospect list is ordered by fit score descending, and the top N can be selected without re-running the pipeline. (🧪 testID: test_validate_prospect_artifact - ordering)
- [x] AC2: Each retained prospect cites the public source URL it was extracted from, and the shortlist names the signal that justified including it. (🧪 testID: test_validate_prospect_artifact - source citation)
- [x] AC3: Each prospect carries a fit, a timing, and a reachability score, and each score has a one-line reason. (🧪 testID: test_validate_prospect_artifact - score reasons)
- [x] AC4: When public-signal coverage for a category is thin, the shortlist says so explicitly rather than presenting a confident-looking list. (🧪 testID: test_validate_prospect_artifact - coverage warning)
- [x] AC5: The durable shortlist artifact format is documented in `docs/systems/prospect-finder-artifact.md`. (📄 not code: documented in docs/systems/prospect-finder-artifact.md)
"""
        result = grade(response, case.directory, case.grader_config)
        self.assertTrue(result.passed, result.detail)
        self.assertEqual(result.detail["failures"], [])


class PromptCompositionTests(unittest.TestCase):
    def test_fixture_contents_are_inlined(self):
        """The infer transport has no tools, so fixtures must be in the prompt."""
        case = load_case(EVALS_ROOT / "cases" / "planted-defect-review")
        prompt = compose_prompt(case)
        self.assertIn(case.prompt, prompt)
        for path in case.prompt_files:
            body = path.read_text()
            self.assertIn(
                body.strip().splitlines()[0],
                prompt,
                f"fixture {path.name} was not inlined into the prompt",
            )


if __name__ == "__main__":
    unittest.main()


class ResultPersistenceTests(unittest.TestCase):
    """Every attempt is recorded, not only the ones that scored.

    A run that failed to reach the model is still the latest truth about that
    model and case. Persisting only the successes leaves the previous score
    sitting in the scorecard, so it claims a pass that did not happen — a
    green that does not mean anything, which is the failure this harness
    exists to prevent.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self._original_root = harness.RESULTS_ROOT
        harness.RESULTS_ROOT = pathlib.Path(self._tmp.name)
        self.addCleanup(setattr, harness, "RESULTS_ROOT", self._original_root)

    def test_a_failed_run_is_persisted(self):
        harness.persist_record(
            {
                "case": "lobster-ac-compliance",
                "model": "minimax-portal__MiniMax-M3.1-Flash",
                "status": "model_error",
                "error": "Connection error",
            }
        )
        path = (
            pathlib.Path(self._tmp.name)
            / "minimax-portal__MiniMax-M3.1-Flash"
            / "lobster-ac-compliance.json"
        )
        self.assertTrue(path.exists(), "a failed run left no record")
        record = json.loads(path.read_text())
        self.assertEqual(record["status"], "model_error")

    def test_a_later_failure_replaces_an_earlier_pass(self):
        harness.persist_record(
            {
                "case": "lobster-ac-compliance",
                "model": "minimax-portal__MiniMax-M3.1-Flash",
                "status": "ok",
                "passed": True,
                "score": 1.0,
            }
        )
        harness.persist_record(
            {
                "case": "lobster-ac-compliance",
                "model": "minimax-portal__MiniMax-M3.1-Flash",
                "status": "model_error",
                "error": "Connection error",
            }
        )
        path = (
            pathlib.Path(self._tmp.name)
            / "minimax-portal__MiniMax-M3.1-Flash"
            / "lobster-ac-compliance.json"
        )
        record = json.loads(path.read_text())
        self.assertEqual(
            record["status"],
            "model_error",
            "the scorecard still shows the earlier pass after a later failure",
        )

    def test_every_record_carries_a_timestamp(self):
        harness.persist_record(
            {
                "case": "lobster-ac-compliance",
                "model": "anthropic__claude-sonnet-5",
                "status": "ok",
                "passed": True,
                "score": 1.0,
                "recordedAt": harness._now(),
            }
        )
        path = (
            pathlib.Path(self._tmp.name)
            / "anthropic__claude-sonnet-5"
            / "lobster-ac-compliance.json"
        )
        record = json.loads(path.read_text())
        self.assertIn("recordedAt", record)
