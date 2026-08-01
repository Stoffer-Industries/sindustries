import importlib.util
import pathlib
import unittest
from unittest.mock import patch

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


def pull_request(**overrides):
    value = {
        "number": 42,
        "title": "feat: example",
        "html_url": "https://github.com/acme/repo/pull/42",
        "user": {"login": "rowanstoffer"},
        "requested_reviewers": [],
        "reviews": [],
        "check_runs": [
            {"status": "completed", "conclusion": "success"},
            {"status": "completed", "conclusion": "skipped"},
        ],
        "mergeable": True,
    }
    value.update(overrides)
    return value


class AgentTaskQueueTest(unittest.TestCase):
    def test_dependency_blocked_doing_is_classified(self):
        queue = agent_task_queue.build_queue(
            [implementation_task(id="blocked", dependencyBlocked=True)]
        )
        self.assertEqual(queue["items"][0]["classification"], "DEPENDENCY_BLOCKED")

    def test_explicitly_blocked_doing_is_classified(self):
        queue = agent_task_queue.build_queue([implementation_task(blocked=True)])
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

    def test_tech_design_approval_matches_lobster_exact_token_rule(self):
        accepted = (
            "[tech-design-approved] true",
            "  [tech-design-approved] TRUE rationale follows",
        )
        rejected = (
            "Missing task comment `[tech-design-approved] true`.",
            "[tech-design-approved] false",
            "[tech-design-approved] trueish",
            "[tech-design-approved]",
        )
        for text in accepted:
            with self.subTest(accepted=text):
                self.assertTrue(agent_task_queue._tech_design_approved([text]))
        for text in rejected:
            with self.subTest(rejected=text):
                self.assertFalse(agent_task_queue._tech_design_approved([text]))

    def test_checklist_approval_substring_does_not_promote_doing_task(self):
        classification, reason = agent_task_queue.classify_task(
            task(
                status="doing",
                comments=[
                    {"text": "[tech-design] https://example.test/design"},
                    {"text": "Missing task comment `[tech-design-approved] true`."},
                ],
            )
        )
        self.assertEqual(classification, "WAITING_EXTERNAL")
        self.assertIn("approval", reason)

    def test_code_task_waiver_waits_for_lobster_promotion(self):
        classification, reason = agent_task_queue.classify_task(
            task(status="ready", comments=[{"text": "[tech-design-not-required] small fix"}])
        )
        self.assertEqual(classification, "WAITING_EXTERNAL")
        self.assertIn("Lobster", reason)

    def test_content_task_doing_remains_actionable_with_delivery_comment(self):
        classification, reason = agent_task_queue.classify_task(
            task(
                taskType="content",
                status="doing",
                comments=[{"text": "[ivy-prs] https://github.com/acme/repo/pull/1"}],
            )
        )
        self.assertEqual(classification, "ACTIONABLE")
        self.assertIn("content task", reason)

    def test_content_task_acceptance_is_external_wait(self):
        classification, reason = agent_task_queue.classify_task(
            task(taskType="content", status="acceptance")
        )
        self.assertEqual(classification, "WAITING_EXTERNAL")
        self.assertIn("acceptance", reason)

    def test_untyped_doing_task_is_actionable_for_quinn(self):
        classification, reason = agent_task_queue.classify_task(
            task(taskType=None, status="doing")
        )
        self.assertEqual(classification, "ACTIONABLE")
        self.assertIn("task is in doing", reason)

    def test_untyped_acceptance_task_is_external_wait(self):
        classification, reason = agent_task_queue.classify_task(
            task(taskType=None, status="acceptance")
        )
        self.assertEqual(classification, "WAITING_EXTERNAL")
        self.assertIn("acceptance", reason)

    def test_fetch_keeps_open_untyped_ops_tasks_outside_active_classifier(self):
        with (
            patch.object(agent_task_queue.tasks_api_client, "list_tasks", return_value=[]) as list_tasks,
            patch.object(agent_task_queue.tasks_api_client, "get_base_url", return_value="http://test/api/v1"),
        ):
            agent_task_queue.fetch_agent_tasks("Quinn")

        self.assertEqual(
            list_tasks.call_args.kwargs["status"],
            ["ready", "doing", "acceptance"],
        )
        self.assertNotIn("open", list_tasks.call_args.kwargs["status"])

    def test_work_queue_exposes_all_read_only_queue_keys(self):
        queue = agent_task_queue.build_work_queue(
            [implementation_task()],
            "Rowan",
            [],
            [{"id": "approval"}],
        )
        self.assertEqual(
            set(queue),
            {
                "tasks",
                "actionableTaskCount",
                "techDesignApprovals",
                "reviewRequests",
                "authoredPrFeedback",
                "mergeCandidates",
            },
        )

    def test_review_requests_exclude_self_review(self):
        other = pull_request(
            user={"login": "ivystoffer"},
            requested_reviewers=[{"login": "quinnstoffer"}],
        )
        own = pull_request(
            user={"login": "quinnstoffer"},
            requested_reviewers=[{"login": "quinnstoffer"}],
        )
        queue = agent_task_queue.classify_github_prs("Quinn", [other, own])
        self.assertEqual([42], [item["number"] for item in queue["reviewRequests"]])

    def test_latest_changes_requested_review_drives_authored_feedback(self):
        pr = pull_request(
            reviews=[
                {
                    "user": {"login": "quinnstoffer"},
                    "state": "APPROVED",
                    "submitted_at": "2026-01-01T00:00:00Z",
                },
                {
                    "user": {"login": "quinnstoffer"},
                    "state": "CHANGES_REQUESTED",
                    "submitted_at": "2026-01-02T00:00:00Z",
                },
            ]
        )
        queue = agent_task_queue.classify_github_prs("Rowan", [pr])
        self.assertEqual(["quinnstoffer"], queue["authoredPrFeedback"][0]["changesRequestedBy"])
        self.assertEqual([], queue["mergeCandidates"])

    def test_rowan_merge_candidate_requires_quinn_approval_and_green_ci(self):
        approved = pull_request(
            reviews=[
                {
                    "user": {"login": "quinnstoffer"},
                    "state": "APPROVED",
                    "submitted_at": "2026-01-01T00:00:00Z",
                }
            ]
        )
        queue = agent_task_queue.classify_github_prs("Rowan", [approved])
        self.assertEqual([42], [item["number"] for item in queue["mergeCandidates"]])

        approved["check_runs"][0]["conclusion"] = "failure"
        self.assertEqual(
            [],
            agent_task_queue.classify_github_prs("Rowan", [approved])["mergeCandidates"],
        )

    def test_ivy_merge_candidate_uses_pr_specific_blocking_reviewer(self):
        pr = pull_request(
            title="content: weekly updates (Tom-approval)",
            user={"login": "ivystoffer"},
            reviews=[
                {
                    "user": {"login": "Stoff81"},
                    "state": "APPROVED",
                    "submitted_at": "2026-01-01T00:00:00Z",
                }
            ],
        )
        queue = agent_task_queue.classify_github_prs("Ivy", [pr])
        self.assertEqual(["stoff81"], queue["mergeCandidates"][0]["blockingApprovals"])

    def test_quinn_cannot_self_approve_a_merge_candidate(self):
        pr = pull_request(
            user={"login": "quinnstoffer"},
            requested_reviewers=[{"login": "quinnstoffer"}],
            reviews=[
                {
                    "user": {"login": "quinnstoffer"},
                    "state": "APPROVED",
                    "submitted_at": "2026-01-01T00:00:00Z",
                }
            ],
        )
        queue = agent_task_queue.classify_github_prs("Quinn", [pr])
        self.assertEqual([], queue["mergeCandidates"])

    def test_quinn_authored_pr_can_merge_after_non_self_approval(self):
        pr = pull_request(
            user={"login": "quinnstoffer"},
            reviews=[
                {
                    "user": {"login": "Stoff81"},
                    "state": "APPROVED",
                    "submitted_at": "2026-01-01T00:00:00Z",
                }
            ],
        )
        queue = agent_task_queue.classify_github_prs("Quinn", [pr])
        self.assertEqual(["stoff81"], queue["mergeCandidates"][0]["blockingApprovals"])


if __name__ == "__main__":
    unittest.main()
