from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
import unittest


CONTENT_TASK_DIR = Path(__file__).resolve().parents[1] / "agents/workflows/content-task"


def load_content_task_modules():
    saved_common = sys.modules.get("common")
    try:
        common_spec = importlib.util.spec_from_file_location(
            "common",
            CONTENT_TASK_DIR / "common.py",
        )
        common_module = importlib.util.module_from_spec(common_spec)
        sys.modules["common"] = common_module
        assert common_spec.loader is not None
        common_spec.loader.exec_module(common_module)

        transition_spec = importlib.util.spec_from_file_location(
            "content_task_pr_transition",
            CONTENT_TASK_DIR / "pr_transition.py",
        )
        transition_module = importlib.util.module_from_spec(transition_spec)
        assert transition_spec.loader is not None
        transition_spec.loader.exec_module(transition_module)
        return transition_module
    finally:
        if saved_common is None:
            sys.modules.pop("common", None)
        else:
            sys.modules["common"] = saved_common


class OwnerSectionHeadingTests(unittest.TestCase):
    def test_nested_acceptance_criteria_heading_stays_in_owner_section(self):
        module = load_content_task_modules()
        description = (
            "## Quinn can execute\n"
            "### Acceptance Criteria\n"
            "- [ ] ADD system/example - implement it\n\n"
            "## Needs Tom approval\n"
            "- [ ] Approve launch\n\n"
            "## Defer\n"
            "- [ ] Not part of Tom's section\n"
        )

        sections = module.owner_sections(description)

        self.assertEqual(len(sections), 2)
        self.assertIn("ADD system/example", sections[0][0])
        self.assertIn("Approve launch", sections[1][0])
        self.assertNotIn("Not part of Tom's section", sections[1][0])


if __name__ == "__main__":
    unittest.main()
