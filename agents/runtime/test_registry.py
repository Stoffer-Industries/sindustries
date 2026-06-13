from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agents.runtime.registry import (
    RegistryDataError,
    RegistryTransitionError,
    get_run,
    initialize_registry,
    list_active_runs,
    register_run,
    update_status,
)


class RegistryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.registry_path = Path(self.temporary_directory.name) / "registry.json"
        initialize_registry(self.registry_path)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def register(self, run_id: str = "run-1") -> dict:
        return register_run(
            run_id=run_id,
            agent_id="rowan",
            task_label="Add registry",
            branch_name="feat/registry",
            worktree_path="/tmp/registry",
            session_id="session-1",
            registry_path=self.registry_path,
        )

    def test_register_get_and_list_active(self) -> None:
        self.register()
        self.assertEqual(get_run("run-1", self.registry_path)["agentId"], "rowan")
        self.assertEqual([run["runId"] for run in list_active_runs(self.registry_path)], ["run-1"])

    def test_valid_transition_and_terminal_filter(self) -> None:
        self.register()
        update_status("run-1", "running", registry_path=self.registry_path)
        update_status("run-1", "completed", registry_path=self.registry_path)
        self.assertEqual(list_active_runs(self.registry_path), [])

    def test_blocked_requires_reason_and_retry_increments_count(self) -> None:
        self.register()
        update_status("run-1", "running", registry_path=self.registry_path)
        with self.assertRaises(RegistryDataError):
            update_status("run-1", "blocked", registry_path=self.registry_path)
        blocked = update_status(
            "run-1",
            "blocked",
            blockedReason="tmux session exited",
            registry_path=self.registry_path,
        )
        self.assertEqual(blocked["blockedReason"], "tmux session exited")
        with self.assertRaises(RegistryTransitionError):
            update_status("run-1", "running", registry_path=self.registry_path)
        retried = update_status(
            "run-1", "running", retry=True, registry_path=self.registry_path
        )
        self.assertEqual(retried["retryCount"], 1)
        self.assertIsNone(retried["blockedReason"])

    def test_failed_retry_is_explicit(self) -> None:
        self.register()
        update_status("run-1", "failed", registry_path=self.registry_path)
        with self.assertRaises(RegistryTransitionError):
            update_status("run-1", "running", registry_path=self.registry_path)
        retried = update_status(
            "run-1", "registered", retry=True, registry_path=self.registry_path
        )
        self.assertEqual(retried["retryCount"], 1)

    def test_malformed_and_missing_registry_raise_clear_errors(self) -> None:
        missing = self.registry_path.with_name("missing.json")
        with self.assertRaisesRegex(RegistryDataError, "does not exist"):
            list_active_runs(missing)
        self.registry_path.write_text("{broken", encoding="utf-8")
        with self.assertRaisesRegex(RegistryDataError, "malformed JSON"):
            list_active_runs(self.registry_path)

    def test_invalid_existing_record_blocks_writes(self) -> None:
        self.register()
        data = json.loads(self.registry_path.read_text(encoding="utf-8"))
        del data["runs"]["run-1"]["sessionId"]
        self.registry_path.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaisesRegex(RegistryDataError, "missing fields"):
            register_run(
                run_id="run-2",
                agent_id="rowan",
                task_label="Second",
                branch_name="feat/second",
                worktree_path="/tmp/second",
                session_id="session-2",
                registry_path=self.registry_path,
            )


if __name__ == "__main__":
    unittest.main()
