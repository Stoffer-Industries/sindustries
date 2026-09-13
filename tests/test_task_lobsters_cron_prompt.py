"""Regression tests for the Task Lobsters cron execution contract."""

import unittest
from pathlib import Path


PROMPT = (
    Path(__file__).resolve().parents[1]
    / "agents"
    / "crons"
    / "prompts"
    / "task-lobsters.md"
)


class TaskLobstersCronPromptTests(unittest.TestCase):
    @staticmethod
    def _prompt_text() -> str:
        return " ".join(PROMPT.read_text().split())

    def test_prompt_requires_foreground_completion_and_process_polling(self) -> None:
        prompt = self._prompt_text()

        self.assertIn("Run both lobster commands in the foreground", prompt)
        self.assertIn("poll that process with `process` until it exits", prompt)
        self.assertIn("Do not proceed to the next section or report success", prompt)

    def test_prompt_requires_both_lobsters_to_reach_terminal_states(self) -> None:
        prompt = self._prompt_text()

        self.assertIn("both lobster commands in the foreground", prompt)
        self.assertIn("each command to reach a terminal state", prompt)
        self.assertIn("one lobster's failure must not prevent the other lobster", prompt)


if __name__ == "__main__":
    unittest.main()
