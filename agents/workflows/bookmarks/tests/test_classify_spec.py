#!/usr/bin/env python3
"""Unit tests for `classify_spec` (task `536e04fc`).

Six fixtures per the tech design: 2 feature, 2 code, 1 research, 1 ambiguous.
Asserts the deterministic fallback returns the right classification for each,
and that ambiguous input returns ``None``.
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
SCRIPTS = REPO / "agents" / "workflows" / "bookmarks" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))


def _load_classifier():
    spec = importlib.util.spec_from_file_location(
        "classify_spec", SCRIPTS / "classify_spec.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["classify_spec"] = module
    spec.loader.exec_module(module)
    return module


classify_spec = _load_classifier().classify_spec


FEATURE_SPEC_A = """\
---
title: Public signup with social login
type: feature
---

# Public signup with social login

A user-facing onboarding flow that lets visitors sign up with Google or
Apple instead of forcing an email+password form.

## Acceptance Criteria
- [ ] AC1: Ship Google and Apple OAuth on the public signup page.
- [ ] AC2: Pricing page reflects the new SSO-based plans.
"""


FEATURE_SPEC_B = """\
# Settings: notification preferences UX

Refines the existing notification settings page so customers can pick which
events trigger email vs. in-app messages. Customer-facing rollout gated
behind a feature flag.

## Acceptance Criteria
- [ ] AC1: New notification matrix UI.
"""


CODE_SPEC_A = """\
---
title: Split monolithic tasks route
type: code
---

# Split monolithic tasks route

Decompose `routes/tasks.ts` into `routes/tasks/{list,get,patch}.ts` so the
existing test coverage continues to apply per route.

## Acceptance Criteria
- [ ] AC1: Refactor lands with no behaviour change. CI gate stays green.
"""


CODE_SPEC_B = """\
# Add rust migration tooling

Tooling only — adds a `cargo migrate` subcommand plus unit-test coverage.
No user-facing change.
"""


RESEARCH_SPEC = """\
# Evaluate content-scheduler backends

A spike to compare Postgres LISTEN/NOTIFY vs. a dedicated queue (SQS,
pg-boss) for the content-scheduler event bus. Proof-of-concept with
benchmark numbers; no production change.

## Acceptance Criteria
- [ ] AC1: One-pager with the comparison matrix and a recommendation.
"""


AMBIGUOUS_SPEC = """\
# Misc bookmark pipeline cleanup

A grab-bag of small tweaks discovered while reviewing the pipeline.

## Acceptance Criteria
- [ ] AC1: Tidy up.
"""


class ClassifySpecTests(unittest.TestCase):
    def test_feature_via_frontmatter_type(self):
        self.assertEqual(classify_spec(FEATURE_SPEC_A), "feature")

    def test_feature_via_keywords(self):
        self.assertEqual(classify_spec(FEATURE_SPEC_B), "feature")

    def test_code_via_frontmatter_type(self):
        self.assertEqual(classify_spec(CODE_SPEC_A), "code")

    def test_code_via_keywords(self):
        self.assertEqual(classify_spec(CODE_SPEC_B), "code")

    def test_research_via_keywords(self):
        self.assertEqual(classify_spec(RESEARCH_SPEC), "research")

    def test_ambiguous_returns_none(self):
        self.assertIsNone(classify_spec(AMBIGUOUS_SPEC))

    def test_empty_body_returns_none(self):
        self.assertIsNone(classify_spec(""))
        self.assertIsNone(classify_spec("   \n  "))

    def test_heading_override_wins_over_frontmatter(self):
        body = (
            "---\n"
            "type: feature\n"
            "---\n"
            "\n"
            "## Spec type\n"
            "code\n"
        )
        self.assertEqual(classify_spec(body), "code")

    def test_invalid_heading_value_is_ignored(self):
        body = (
            "# Something\n"
            "\n"
            "## Spec type\n"
            "misc\n"
            "\n"
            "Mention a refactor and a unit test.\n"
        )
        # The heading value "misc" is not in ALLOWED_TYPES, so the classifier
        # should fall through to keyword scoring. With refactor + unit test
        # keywords, expect "code".
        self.assertEqual(classify_spec(body), "code")

    def test_frontmatter_value_outside_allowed_set_is_ignored(self):
        body = (
            "---\n"
            "type: bogus\n"
            "---\n"
            "\n"
            "Mention a spike.\n"
        )
        self.assertEqual(classify_spec(body), "research")


if __name__ == "__main__":
    unittest.main()