import importlib.util
import pathlib
import unittest

MODULE_PATH = pathlib.Path(__file__).with_name("agent_task_queue.py")
SPEC = importlib.util.spec_from_file_location("agent_task_queue", MODULE_PATH)
agent_task_queue = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(agent_task_queue)


def task(**overrides):
    value = {
        "id": "00000000-0000-0000-0000-000000000001",
        "title": "Example",
        "taskType": "code",
        "status": "doing",
        "priority": "high",
        "blocked": False,
        "dependencyBlocked": False,
        "comments": [],
    }
    value.update(overrides)
    return value


def implementation_task(**overrides):
    value = task(
        comments=[
            {"text": "[tech-design] https://example.test/design"},
            {"text": "[tech-design-approved] true"},
        ]
    )
    value.update(overrides)
    return value


class AgentTaskQueueTest(unittest.TestCase):
    def test_dependency_blocked_doing_does_not_consume_capacity(self):
        queue = agent_task_queue.build_queue(
            [
                implementation_task(id="blocked", dependencyBlocked=True),
                implementation_task(id="active-1"),
                implementation_task(id="active-2"),
            ],
            capacity=2,
        )

        self.assertEqual(queue["capacity"], {"activeDoing": 2, "limit": 2, "available": 0})
        blocked = next(item for item in queue["items"] if item["id"] == "blocked")
        self.assertEqual(blocked["classification"], "DEPENDENCY_BLOCKED")

    def test_explicitly_blocked_doing_does_not_consume_capacity(self):
        queue = agent_task_queue.build_queue([implementation_task(blocked=True)], capacity=2)
        self.assertEqual(queue["capacity"]["activeDoing"], 0)
        self.assertEqual(queue["items"][0]["classification"], "BLOCKED")

    def test_missing_implementer_prs_is_actionable_for_feature_and_code(self):
        for task_type in ("feature", "code"):
            with self.subTest(task_type=task_type):
                classification, reason = agent_task_queue.classify_task(implementation_task(taskType=task_type))
                self.assertEqual(classification, "ACTIONABLE")
                self.assertIn("delivery", reason)

    def test_progress_checklist_missing_implementer_prs_is_not_external_wait(self):
        classification, _ = agent_task_queue.classify_task(
            implementation_task(
                comments=[
                    {"text": "[tech-design] https://example.test/design"},
                    {"text": "[tech-design-approved] true"},
                    {
                        "text": "[code-task-progress-checklist]\n"
                        "Missing `[implementer-prs]` task comment with at least one PR URL."
                    },
                ]
            )
        )
        self.assertEqual(classification, "ACTIONABLE")

    def test_posted_implementer_prs_is_external_wait_candidate(self):
        classification, reason = agent_task_queue.classify_task(
            implementation_task(
                comments=[
                    {"text": "[tech-design] https://example.test/design"},
                    {"text": "[tech-design-approved] true"},
                    {"text": "[code-task-progress-checklist]\nMissing `[implementer-prs]` task comment."},
                    {"text": "[implementer-prs] https://github.com/acme/repo/pull/1"},
                ]
            )
        )
        self.assertEqual(classification, "WAITING_EXTERNAL")
        self.assertIn("verify PR", reason)

    def test_ready_without_tech_design_is_actionable(self):
        classification, reason = agent_task_queue.classify_task(task(status="ready"))
        self.assertEqual(classification, "ACTIONABLE")
        self.assertIn("tech design", reason)

    def test_ready_with_design_waits_for_approval(self):
        classification, reason = agent_task_queue.classify_task(
            task(status="ready", comments=[{"text": "[tech-design] https://example.test/design"}])
        )
        self.assertEqual(classification, "WAITING_EXTERNAL")
        self.assertIn("approval", reason)

    def test_code_task_waiver_waits_for_lobster_promotion(self):
        classification, reason = agent_task_queue.classify_task(
            task(status="ready", comments=[{"text": "[tech-design-not-required] small fix"}])
        )
        self.assertEqual(classification, "WAITING_EXTERNAL")
        self.assertIn("Lobster", reason)


if __name__ == "__main__":
    unittest.main()
