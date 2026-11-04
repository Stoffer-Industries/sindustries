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

import pathlib
import sys
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
from graders import GradeResult, GraderError, grade  # noqa: E402  (path set above)


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
