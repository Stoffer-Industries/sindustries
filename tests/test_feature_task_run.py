import importlib.util
import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch


REPO = Path(__file__).resolve().parents[1]
RUNNER = REPO / "agents" / "workflows" / "feature-task" / "run.py"


def load_runner():
    spec = importlib.util.spec_from_file_location("feature_task_run", RUNNER)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class FeatureTaskRunTests(unittest.TestCase):
    def test_reconciliation_refusal_is_reported_without_failing_wrapper(self):
        runner = load_runner()
        reconciliation = {
            "returncode": 0,
            "stdout": '{"criteriaMet":false}',
            "stderr": "",
            "envelope": {
                "criteriaMet": False,
                "reason": "No matching active task for orphan spec",
            },
        }
        stdout = io.StringIO()

        with (
            patch.object(runner, "run_brain_spec_approval_reconciliation", return_value=reconciliation),
            patch.object(runner, "discover_tasks", return_value=[]),
            patch.object(sys, "argv", [str(RUNNER)]),
            redirect_stdout(stdout),
        ):
            exit_code = runner.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["errors"], [])
        self.assertEqual(payload["brainSpecApprovalReconciliation"], reconciliation)

    def test_reconciliation_execution_error_still_fails_wrapper(self):
        runner = load_runner()
        reconciliation = {
            "returncode": 1,
            "stdout": "",
            "stderr": "reconciliation failed",
            "error": "reconciliation failed",
        }
        stdout = io.StringIO()

        with (
            patch.object(runner, "run_brain_spec_approval_reconciliation", return_value=reconciliation),
            patch.object(runner, "discover_tasks", return_value=[]),
            patch.object(sys, "argv", [str(RUNNER)]),
            redirect_stdout(stdout),
        ):
            exit_code = runner.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 1)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["errors"], [reconciliation])


if __name__ == "__main__":
    unittest.main()
