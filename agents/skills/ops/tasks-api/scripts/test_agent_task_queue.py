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
        "assignee": "Rowan",
        "blocked": False,
        "dependencyBlocked": False,
        "comments": [],
        "approvals": [],
    }
    value.update(overrides)
    return value


def implementation_task(**overrides):
    value = task(
        comments=[{"text": "[tech-design] https://example.test/design"}],
        approvals=[{"type": "tech_design", "state": "approved", "owner": "Quinn"}],
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
        "state": "open",
        "draft": False,
        "merged_at": None,
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
                classification, reason = agent_task_queue.classify_task(
                    implementation_task(taskType=task_type)
                )
                self.assertEqual(classification, "ACTIONABLE")
                self.assertIn("delivery", reason)

    def test_doing_task_missing_delivery_is_actionable(self):
        classification, reason = agent_task_queue.classify_task(implementation_task(taskType="feature"))
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

    def test_closed_unmerged_implementer_pr_is_actionable(self):
        pr_url = "https://github.com/acme/repo/pull/1"
        classification, reason = agent_task_queue.classify_task(
            implementation_task(
                taskType="feature",
                comments=[
                    {"text": "[tech-design] https://example.test/design"},
                    {"text": "[tech-design-approved] true"},
                    {"text": f"[implementer-prs] {pr_url}"},
                ],
            ),
            {pr_url: pull_request(html_url=pr_url, state="closed", merged_at=None)},
        )
        self.assertEqual(classification, "ACTIONABLE")
        self.assertIn("closed without merge", reason)

    def test_open_review_requested_implementer_pr_is_waiting_external(self):
        pr_url = "https://github.com/acme/repo/pull/1"
        classification, reason = agent_task_queue.classify_task(
            implementation_task(
                taskType="feature",
                comments=[
                    {"text": "[tech-design] https://example.test/design"},
                    {"text": "[tech-design-approved] true"},
                    {"text": f"[implementer-prs] {pr_url}"},
                ],
            ),
            {
                pr_url: pull_request(
                    html_url=pr_url,
                    requested_reviewers=[{"login": "quinnstoffer"}],
                )
            },
        )
        self.assertEqual(classification, "WAITING_EXTERNAL")
        self.assertIn("waiting on review", reason)

    def test_open_without_tech_design_is_actionable(self):
        classification, reason = agent_task_queue.classify_task(task(status="open"))
        self.assertEqual(classification, "ACTIONABLE")
        self.assertIn("tech design", reason)

    def test_ready_without_tech_design_remains_defensive(self):
        classification, reason = agent_task_queue.classify_task(task(status="ready"))
        self.assertEqual(classification, "ACTIONABLE")
        self.assertIn("tech design", reason)

    def test_ready_with_design_waits_for_approval(self):
        classification, reason = agent_task_queue.classify_task(
            task(status="ready", comments=[{"text": "[tech-design] https://example.test/design"}])
        )
        self.assertEqual(classification, "WAITING_EXTERNAL")
        self.assertIn("approval", reason)

    def test_tech_design_approval_uses_structured_rows_only(self):
        self.assertTrue(
            agent_task_queue._tech_design_approved(
                {"approvals": [{"type": "tech_design", "state": "approved"}]}
            )
        )
        self.assertFalse(
            agent_task_queue._tech_design_approved(
                {
                    "comments": [{"text": "[tech-design-approved] true"}],
                    "approvals": [{"type": "tech_design", "state": "revoked"}],
                }
            )
        )

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
            ["open", "ready", "doing", "acceptance"],
        )
        self.assertIn("open", list_tasks.call_args.kwargs["status"])

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
                "queue",
                "topCandidate",
                "tasks",
                "actionableTaskCount",
                "techDesignApprovals",
                "reviewRequests",
                "authoredPrFeedback",
                "mergeCandidates",
            },
        )

    def test_unified_queue_selects_one_deterministic_top_candidate(self):
        feedback_pr = pull_request(
            reviews=[
                {
                    "user": {"login": "quinnstoffer"},
                    "state": "CHANGES_REQUESTED",
                    "submitted_at": "2026-01-01T00:00:00Z",
                }
            ]
        )
        queue = agent_task_queue.build_work_queue(
            [implementation_task(priority="urgent")],
            "Rowan",
            [feedback_pr],
            [{"id": "approval", "title": "Review design", "techDesignUrl": "https://design"}],
        )
        self.assertEqual("authoredPrFeedback", queue["topCandidate"]["kind"])
        self.assertEqual(
            ["authoredPrFeedback", "techDesignApproval", "task"],
            [item["kind"] for item in queue["queue"]],
        )

    def test_unified_queue_keeps_non_actionable_tasks_below_actionable_work(self):
        waiting_pr_url = "https://github.com/acme/repo/pull/99"
        queue = agent_task_queue.build_work_queue(
            [
                implementation_task(
                    title="Waiting",
                    comments=[
                        {"text": "[tech-design] https://example.test/design"},
                        {"text": "[tech-design-approved] true"},
                        {"text": f"[implementer-prs] {waiting_pr_url}"},
                    ],
                ),
                implementation_task(title="Action now"),
            ],
            "Rowan",
            [
                pull_request(
                    number=99,
                    html_url=waiting_pr_url,
                    requested_reviewers=[{"login": "quinnstoffer"}],
                )
            ],
        )
        self.assertEqual("Action now", queue["topCandidate"]["title"])
        self.assertTrue(queue["queue"][0]["actionable"])
        self.assertFalse(queue["queue"][-1]["actionable"])

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
