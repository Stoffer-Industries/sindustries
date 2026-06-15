import importlib.util
import pathlib
import unittest
from unittest.mock import patch


MODULE_PATH = pathlib.Path(__file__).parents[1] / "task_transition_check.py"
SPEC = importlib.util.spec_from_file_location("task_transition_check", MODULE_PATH)
task_transition_check = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(task_transition_check)


class PrTestsPassingTest(unittest.TestCase):
    @patch.object(task_transition_check, "github_check_runs")
    @patch.object(task_transition_check, "github_commit_status")
    def test_zero_legacy_statuses_falls_back_to_green_check_runs(
        self, commit_status, check_runs
    ):
        commit_status.return_value = {"state": "pending", "total_count": 0}
        check_runs.return_value = {
            "check_runs": [
                {
                    "name": "test",
                    "status": "completed",
                    "conclusion": "success",
                }
            ]
        }

        passing, message = task_transition_check.pr_tests_passing(
            "Stoffer-Industries", "sindustries", "abc123", "token"
        )

        self.assertTrue(passing)
        self.assertEqual(message, "")
        check_runs.assert_called_once_with(
            "Stoffer-Industries", "sindustries", "abc123", "token"
        )

    @patch.object(task_transition_check, "github_check_runs")
    @patch.object(task_transition_check, "github_commit_status")
    def test_zero_legacy_statuses_reports_failed_check_run(
        self, commit_status, check_runs
    ):
        commit_status.return_value = {"state": "pending", "total_count": 0}
        check_runs.return_value = {
            "check_runs": [
                {
                    "name": "test",
                    "status": "completed",
                    "conclusion": "failure",
                }
            ]
        }

        passing, message = task_transition_check.pr_tests_passing(
            "Stoffer-Industries", "sindustries", "abc123", "token"
        )

        self.assertFalse(passing)
        self.assertEqual(message, "Check failed: test")


if __name__ == "__main__":
    unittest.main()
