from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
import unittest


SCRIPT = Path(__file__).parents[1] / "run_if_criteria_met.py"


class RunIfCriteriaMetTests(unittest.TestCase):
    def run_script(self, envelope: dict, *command: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--", *command],
            input=json.dumps(envelope),
            text=True,
            capture_output=True,
            check=False,
        )

    def test_false_criteria_preserves_previous_envelope_without_running_command(self):
        envelope = {"criteriaMet": False, "actionTaken": "blocked"}
        result = self.run_script(
            envelope,
            sys.executable,
            "-c",
            "raise SystemExit('must not run')",
        )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), envelope)

    def test_true_criteria_runs_next_stage_with_previous_envelope_on_stdin(self):
        result = self.run_script(
            {"criteria_met": True, "action_taken": "clear"},
            sys.executable,
            "-c",
            "import json,sys; print(json.dumps({'received': json.load(sys.stdin)['action_taken']}))",
        )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), {"received": "clear"})

    def test_missing_criteria_is_rejected(self):
        result = self.run_script({"actionTaken": "unknown"}, sys.executable, "-c", "pass")

        self.assertEqual(result.returncode, 2)
        self.assertIn("missing boolean criteriaMet", result.stderr)


if __name__ == "__main__":
    unittest.main()
