"""Focused tests for the prospect-finder artifact validator.

The validator is the deterministic half of the prospect-finder skill's
artifact contract: required sections, the per-prospect field set, the
score/reason pairing, the total, the ordering, and the review-queue agreement.
These tests pin that contract so a change to either side fails loudly.
"""

import importlib.util
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).parents[1] / "scripts" / "validate_prospect_artifact.py"
SPEC = importlib.util.spec_from_file_location("validate_prospect_artifact", MODULE_PATH)
validator = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(validator)

EXAMPLE_PATH = (
    pathlib.Path(__file__).parents[1] / "examples" / "prospect-shortlist-example.md"
)


def _artifact(coverage: str = "partial", confidence_note: bool = False) -> str:
    """Build a minimal artifact; `confidence_note` adds the thin-coverage note."""
    note = ""
    if confidence_note:
        note = "- **Confidence note:** Public signal coverage is thin.\n"

    return f"""# Prospect shortlist — example

## Run metadata

- **Date:** 2026-10-30
- **Initiative:** example-initiative
- **Input:** https://example.com/product
- **Search scope:** 1 venue
- **Sources checked:** 1

## ICP hypothesis

- **Buyer:** solo developer
- **Buying context:** no repeatable customer-acquisition step
- **Likely venues:** build-tool issue trackers
- **Exclusions:** agencies
- **Confidence:** medium

## Coverage note

- **Venues searched:** 1 tracker
- **Inaccessible:** none
- **Signal coverage:** {coverage}
{note}
## Prospect shortlist

### Prospect 1 — Example Buyer (@example-buyer)

- **Source:** https://forum.example.com/t/thread
- **Signal:** "Posted about the problem."
- **Fit:** 4 — exact problem match
- **Timing:** 3 — posted recently
- **Reachability:** 2 — forum only
- **Total:** 9
- **Opener:** "Draft referencing the signal."
- **Confidence:** medium
- **Caveats:** none
- **Review state:** proposed

## Review queue

- Prospect 1 — proposed

## Market-research handoff

- **Question answered:** where do buyers talk about this
- **Key implications:** issue trackers are the denser venue
- **Links:** `market-research.md`

## Approval boundary

No outreach was sent or scheduled. Tom acts on this shortlist manually.
"""


class ValidArtifactTest(unittest.TestCase):
    def test_minimal_artifact_has_no_violations(self):
        self.assertEqual(validator.validate_artifact(_artifact()), [])

    def test_checked_in_example_conforms(self):
        problems = validator.validate_artifact(EXAMPLE_PATH.read_text(encoding="utf-8"))
        self.assertEqual(problems, [], f"example artifact violates the contract: {problems}")


class RequiredSectionTest(unittest.TestCase):
    def test_missing_section_is_reported(self):
        text = _artifact().replace("## Review queue\n\n- Prospect 1 — proposed\n", "")
        problems = validator.validate_artifact(text)
        self.assertIn("missing required section: ## Review queue", problems)

    def test_missing_run_metadata_field_is_reported(self):
        text = _artifact().replace("- **Search scope:** 1 venue\n", "")
        problems = validator.validate_artifact(text)
        self.assertIn("Run metadata: missing field 'Search scope'", problems)

    def test_missing_icp_field_is_reported(self):
        text = _artifact().replace("- **Exclusions:** agencies\n", "")
        problems = validator.validate_artifact(text)
        self.assertIn("ICP hypothesis: missing field 'Exclusions'", problems)

    def test_missing_handoff_field_is_reported(self):
        text = _artifact().replace("- **Key implications:** issue trackers are the denser venue\n", "")
        problems = validator.validate_artifact(text)
        self.assertIn("Market-research handoff: missing field 'Key implications'", problems)


class ThinCoverageTest(unittest.TestCase):
    def test_thin_coverage_requires_confidence_note(self):
        problems = validator.validate_artifact(_artifact(coverage="thin"))
        self.assertTrue(
            any("no 'Confidence note' field is present" in problem for problem in problems),
            problems,
        )

    def test_thin_coverage_with_confidence_note_is_valid(self):
        problems = validator.validate_artifact(
            _artifact(coverage="thin", confidence_note=True)
        )
        self.assertEqual(problems, [])

    def test_unknown_coverage_value_is_reported(self):
        text = _artifact().replace("- **Signal coverage:** partial", "- **Signal coverage:** some")
        problems = validator.validate_artifact(text)
        self.assertTrue(
            any("Signal coverage must be one of" in problem for problem in problems), problems
        )


class ProspectFieldTest(unittest.TestCase):
    def test_missing_prospect_field_is_reported(self):
        text = _artifact().replace("- **Caveats:** none\n", "")
        problems = validator.validate_artifact(text)
        self.assertTrue(
            any("missing field 'Caveats'" in problem for problem in problems), problems
        )

    def test_non_url_source_is_reported(self):
        text = _artifact().replace(
            "- **Source:** https://forum.example.com/t/thread", "- **Source:** forum.example.com/t/thread"
        )
        problems = validator.validate_artifact(text)
        self.assertTrue(
            any("Source must be an absolute http(s) URL" in problem for problem in problems), problems
        )

    def test_invalid_review_state_is_reported(self):
        text = _artifact().replace("- **Review state:** proposed", "- **Review state:** maybe")
        problems = validator.validate_artifact(text)
        self.assertTrue(
            any("Review state must be one of" in problem for problem in problems), problems
        )

    def test_invalid_confidence_is_reported(self):
        text = _artifact().replace("- **Confidence:** medium", "- **Confidence:** very high")
        problems = validator.validate_artifact(text)
        self.assertTrue(
            any("Confidence must be one of" in problem for problem in problems), problems
        )


class ScoreRuleTest(unittest.TestCase):
    def test_score_without_reason_is_reported(self):
        text = _artifact().replace("- **Fit:** 4 — exact problem match", "- **Fit:** 4")
        problems = validator.validate_artifact(text)
        self.assertTrue(
            any("Fit must be '<0-5> - <one-line reason>'" in problem for problem in problems), problems
        )

    def test_score_with_empty_reason_is_reported(self):
        text = _artifact().replace("- **Fit:** 4 — exact problem match", "- **Fit:** 4 - ")
        problems = validator.validate_artifact(text)
        self.assertTrue(any("Fit must be" in problem for problem in problems), problems)

    def test_out_of_range_score_is_reported(self):
        text = _artifact().replace("- **Fit:** 4 — exact problem match", "- **Fit:** 9 — too high")
        problems = validator.validate_artifact(text)
        self.assertTrue(any("Fit score 9 is outside 0-5" in problem for problem in problems), problems)

    def test_total_must_equal_score_sum(self):
        text = _artifact().replace("- **Total:** 9", "- **Total:** 11")
        problems = validator.validate_artifact(text)
        self.assertTrue(
            any("Total 11 does not equal the sum of the scores (9)" in problem for problem in problems),
            problems,
        )


class OrderingAndReviewQueueTest(unittest.TestCase):
    def test_descending_order_is_required(self):
        text = _artifact()
        lower = """### Prospect 2 — Lower (@lower)

- **Source:** https://forum.example.com/t/other
- **Signal:** "Posted about the problem."
- **Fit:** 1 — weak match
- **Timing:** 1 — no timing signal
- **Reachability:** 1 — hard to reach
- **Total:** 3
- **Opener:** "Draft referencing the signal."
- **Confidence:** low
- **Caveats:** none
- **Review state:** proposed

"""
        # Insert the lower-scoring prospect before the higher-scoring one.
        text = text.replace("### Prospect 1 — Example Buyer", lower + "### Prospect 1 — Example Buyer")
        problems = validator.validate_artifact(text)
        self.assertTrue(
            any("must be ordered by Total, descending" in problem for problem in problems), problems
        )

    def test_review_queue_state_must_match_prospect_state(self):
        text = _artifact().replace("- Prospect 1 — proposed", "- Prospect 1 — keep")
        problems = validator.validate_artifact(text)
        self.assertTrue(
            any(
                "Review queue: 'Prospect 1' is 'keep' but the prospect's Review state is 'proposed'"
                in problem
                for problem in problems
            ),
            problems,
        )

    def test_review_queue_missing_prospect_is_reported(self):
        text = _artifact().replace(
            "## Review queue\n\n- Prospect 1 — proposed\n", "## Review queue\n\n- (empty)\n"
        )
        problems = validator.validate_artifact(text)
        self.assertTrue(
            any("Review queue: no entry for 'Prospect 1'" in problem for problem in problems), problems
        )


class ApprovalBoundaryTest(unittest.TestCase):
    def test_missing_no_send_statement_is_reported(self):
        text = _artifact().replace(
            "No outreach was sent or scheduled. Tom acts on this shortlist manually.",
            "Outreach may follow.",
        )
        problems = validator.validate_artifact(text)
        self.assertTrue(
            any("must state that 'no outreach was sent or scheduled'" in problem for problem in problems),
            problems,
        )


class EmptyFieldTest(unittest.TestCase):
    def test_empty_required_field_is_reported(self):
        text = _artifact().replace("- **Caveats:** none", "- **Caveats:**  ")
        problems = validator.validate_artifact(text)
        self.assertTrue(any("field 'Caveats' is empty" in problem for problem in problems), problems)


class OpenerPersonalisationTest(unittest.TestCase):
    def _two_prospect_artifact(self, second_opener: str) -> str:
        second = f"""### Prospect 2 — Second Example (@second-example)

- **Source:** https://forum.example.com/t/other-thread
- **Signal:** "Also posted about the problem."
- **Fit:** 3 — related match
- **Timing:** 2 — older signal
- **Reachability:** 1 — hard to reach
- **Total:** 6
- **Opener:** {second_opener}
- **Confidence:** low
- **Caveats:** none
- **Review state:** proposed

"""
        text = _artifact()
        # Append the second (lower-scoring) prospect so the list stays ordered
        # by Total, descending.
        text = text.replace("## Review queue", second + "## Review queue")
        text = text.replace(
            "## Review queue\n\n- Prospect 1 — proposed\n",
            "## Review queue\n\n- Prospect 1 — proposed\n- Prospect 2 — proposed\n",
        )
        return text

    def test_duplicate_opener_across_prospects_is_reported(self):
        text = self._two_prospect_artifact('"Draft referencing the signal."')
        problems = validator.validate_artifact(text)
        self.assertTrue(
            any("Opener is identical to" in problem for problem in problems), problems
        )

    def test_distinct_opener_per_prospect_is_valid(self):
        text = self._two_prospect_artifact(
            '"A different opener that responds to the other signal."'
        )
        problems = validator.validate_artifact(text)
        self.assertEqual(problems, [])


class EmptyShortlistTest(unittest.TestCase):
    def test_shortlist_without_prospects_is_reported(self):
        text = _artifact()
        start = text.index("## Prospect shortlist")
        end = text.index("## Review queue")
        text = text[:start] + "## Prospect shortlist\n\n" + text[end:]
        problems = validator.validate_artifact(text)
        self.assertTrue(
            any("no prospect blocks found" in problem for problem in problems), problems
        )


if __name__ == "__main__":
    unittest.main()
