import importlib.util
import pathlib
import subprocess
import sys
import time
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

    def test_active_handoff_owned_by_agent_overrides_stale_progress(self):
        classification, reason = agent_task_queue.classify_task(
            implementation_task(
                assignee="Rowan",
                workflowGates=[{"owner": "Rowan", "state": "outstanding", "gate": "implementation"}],
                comments=[{"text": "Missing `[implementer-prs]` delivery."}],
            )
        )
        self.assertEqual(classification, "ACTIONABLE")
        self.assertIn("owned by Rowan", reason)

    def test_active_handoff_owned_by_other_agent_overrides_stale_progress(self):
        classification, reason = agent_task_queue.classify_task(
            implementation_task(
                assignee="Rowan",
                workflowGates=[{"owner": "Tom", "state": "outstanding", "gate": "spec"}],
                comments=[{
                    "text": "[code-task-progress-checklist]\n"
                    "Missing `[implementer-prs]` task comment with at least one PR URL."
                }],
            )
        )
        self.assertEqual(classification, "WAITING_EXTERNAL")
        self.assertIn("owned by Tom", reason)

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
                "attentionOwner",
                "attentionPages",
                "workflowGateOwner",
                "workflowGateTasks",
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

    def test_github_pr_detail_retries_transient_null_mergeable(self):
        with (
            patch.object(
                agent_task_queue,
                "_gh_api",
                side_effect=[
                    {"number": 42, "mergeable": None},
                    {"number": 42, "mergeable": True},
                ],
            ) as gh_api,
            patch.object(agent_task_queue.time, "sleep") as sleep,
        ):
            detail = agent_task_queue._fetch_github_pr_detail("~/.config/gh-rowan", "ROWAN_GITHUB_TOKEN", 42)

        self.assertTrue(detail["mergeable"])
        self.assertEqual(2, gh_api.call_count)
        sleep.assert_called_once_with(1)

    def test_github_pr_detail_does_not_retry_known_mergeable_value(self):
        with patch.object(
            agent_task_queue,
            "_gh_api",
            return_value={"number": 42, "mergeable": True},
        ) as gh_api, patch.object(agent_task_queue.time, "sleep") as sleep:
            detail = agent_task_queue._fetch_github_pr_detail("~/.config/gh-rowan", "ROWAN_GITHUB_TOKEN", 42)

        self.assertTrue(detail["mergeable"])
        gh_api.assert_called_once()
        sleep.assert_not_called()

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


    # ---- attentionOwners paging (task d8fbe750) ----

    def test_workflow_gate_owner_tasks_calls_current_gate_filter(self):
        with patch.object(
            agent_task_queue.tasks_api_client, "list_tasks", return_value=[]
        ) as list_tasks, patch.object(
            agent_task_queue.tasks_api_client,
            "get_base_url",
            return_value="http://test/api/v1",
        ):
            agent_task_queue.fetch_workflow_gate_owner_tasks("Ash")

        kwargs = list_tasks.call_args.kwargs
        self.assertEqual("Ash", kwargs["workflow_gate_owner"])
        self.assertEqual(
            ["open", "ready", "doing", "acceptance"], kwargs["status"]
        )
        self.assertEqual(200, kwargs["limit"])

    def test_empty_attention_current_ash_gate_is_actionable(self):
        gated = implementation_task(
            attentionOwners=[],
            workflowGates=[
                {"owner": "Ash", "state": "outstanding", "gate": "qa_agent"}
            ],
        )
        queue = agent_task_queue.build_work_queue(
            [],
            "Ash",
            [],
            [],
            workflow_gate_owner_tasks=[gated],
            workflow_gate_owner="Ash",
        )
        self.assertEqual("workflowGate", queue["topCandidate"]["kind"])
        self.assertEqual("qa_agent", queue["topCandidate"]["workflowGate"])
        self.assertEqual(1, len(queue["workflowGateTasks"]))

    def test_top_attention_owner_suppresses_gate_fallback(self):
        gated = implementation_task(
            attentionOwners=["Rowan", "Tom"],
            workflowGates=[
                {"owner": "Ash", "state": "outstanding", "gate": "qa_agent"}
            ],
        )
        items = agent_task_queue._build_workflow_gate_items("Ash", [gated], set())
        self.assertEqual([], items)

    def test_stale_and_future_gates_are_suppressed(self):
        stale = implementation_task(
            id="stale",
            status="doing",
            attentionOwners=[],
            workflowGates=[
                {"owner": "Ash", "state": "outstanding", "gate": "tech_design"}
            ],
        )
        future = implementation_task(
            id="future",
            status="doing",
            attentionOwners=[],
            workflowGates=[
                {"owner": "Ash", "state": "outstanding", "gate": "accepted"}
            ],
        )
        approved = implementation_task(
            id="approved",
            status="doing",
            attentionOwners=[],
            workflowGates=[
                {"owner": "Ash", "state": "approved", "gate": "qa_agent"}
            ],
        )
        self.assertEqual(
            [],
            agent_task_queue._build_workflow_gate_items(
                "Ash", [stale, future, approved], set()
            ),
        )

    def test_ash_cli_identity_is_supported(self):
        self.assertEqual(
            ("ashstoffer", "~/.config/gh-ash", "ASH_GITHUB_TOKEN"),
            agent_task_queue.GITHUB_IDENTITIES["ash"],
        )
        with patch.object(sys, "argv", ["agent_task_queue.py", "--assignee", "Ash"]),              patch.object(agent_task_queue, "fetch_agent_tasks", return_value=[]),              patch.object(agent_task_queue, "fetch_github_prs", return_value=[]),              patch.object(agent_task_queue, "fetch_linked_delivery_prs", return_value={}),              patch.object(agent_task_queue, "fetch_attention_owner_tasks", return_value=[]),              patch.object(agent_task_queue, "fetch_workflow_gate_owner_tasks", return_value=[]),              patch.object(agent_task_queue, "print_human"), \
             patch("builtins.print"):
            agent_task_queue.main()

    def test_attention_owner_tasks_calls_list_with_attention_owner_filter(self):
        with patch.object(
            agent_task_queue.tasks_api_client,
            "list_tasks",
            return_value=[],
        ) as list_tasks, patch.object(
            agent_task_queue.tasks_api_client,
            "get_base_url",
            return_value="http://test/api/v1",
        ):
            agent_task_queue.fetch_attention_owner_tasks("Quinn")

        kwargs = list_tasks.call_args.kwargs
        self.assertEqual(kwargs["attention_owner"], "Quinn")
        self.assertEqual(
            kwargs["status"], ["open", "ready", "doing", "acceptance"]
        )
        self.assertEqual(kwargs["limit"], 200)

    def test_attention_owner_fetch_hydrates_full_task_payload(self):
        with patch.object(
            agent_task_queue.tasks_api_client,
            "get_base_url",
            return_value="http://test/api/v1",
        ), patch.object(
            agent_task_queue.tasks_api_client,
            "list_tasks",
            return_value=[{"id": "task-1"}],
        ), patch.object(
            agent_task_queue.tasks_api_client,
            "get_task",
            return_value={"id": "task-1", "attentionOwners": ["Quinn"]},
        ):
            tasks = agent_task_queue.fetch_attention_owner_tasks("Quinn")
        self.assertEqual([{"id": "task-1", "attentionOwners": ["Quinn"]}], tasks)

    def test_attention_page_dedups_against_assignee_bucket(self):
        # Same task id returned through both surfaces must surface ONCE.
        shared_task = implementation_task(
            id="00000000-0000-0000-0000-000000000099",
            title="Already in my queue",
        )
        page_only = implementation_task(
            id="00000000-0000-0000-0000-0000000000aa",
            title="New attention page",
            attentionOwners=["Quinn", "Tom"],
        )
        task_queue = agent_task_queue.build_queue([shared_task])
        seen = {str(item.get("id") or "") for item in task_queue["items"]}
        items = agent_task_queue._build_attention_page_items(
            "Quinn",
            [
                {**shared_task, "title": "Already in my queue", "attentionOwners": ["Quinn"]},
                {**page_only, "title": "New attention page"},
            ],
            seen,
        )
        self.assertEqual(1, len(items))
        self.assertEqual("New attention page", items[0]["title"])

    def test_attention_page_items_carry_actionable_flag_and_owner(self):
        task = implementation_task(
            id="00000000-0000-0000-0000-0000000000bb",
            title="Paged task",
            attentionOwners=["Quinn", "Tom"],
        )
        items = agent_task_queue._build_attention_page_items("Quinn", [task], set())
        self.assertEqual(1, len(items))
        item = items[0]
        self.assertEqual("attentionPage", item["kind"])
        self.assertTrue(item["actionable"])
        self.assertEqual("ACTIONABLE", item["classification"])
        self.assertEqual("Quinn", item["topAttentionOwner"])

    def test_build_work_queue_includes_attention_pages_when_provided(self):
        tasks = [implementation_task()]
        attention_tasks = [
            implementation_task(
                id="00000000-0000-0000-0000-0000000000cc",
                title="Paged to Quinn",
                attentionOwners=["Quinn", "Tom"],
            )
        ]
        queue = agent_task_queue.build_work_queue(
            tasks,
            "Rowan",
            [],
            [],
            None,
            attention_owner_tasks=attention_tasks,
            attention_owner="Quinn",
        )
        self.assertEqual(1, len(queue["attentionPages"]))
        self.assertEqual("attentionPage", queue["attentionPages"][0]["kind"])
        self.assertEqual("Quinn", queue["attentionOwner"])
        kinds = [item["kind"] for item in queue["queue"]]
        self.assertIn("attentionPage", kinds)

    def test_attention_pages_rank_below_assignee_tasks(self):
        # The assignee task must be the topCandidate; the attentionPage
        # surfaces in the same queue but below assignee work.
        task = implementation_task(priority="urgent")
        attention_task = implementation_task(
            id="00000000-0000-0000-0000-0000000000dd",
            priority="urgent",
            title="Newly paged to Quinn",
            attentionOwners=["Quinn", "Tom"],
        )
        queue = agent_task_queue.build_work_queue(
            [task],
            "Rowan",
            [],
            [],
            None,
            attention_owner_tasks=[attention_task],
            attention_owner="Quinn",
        )
        self.assertEqual("task", queue["topCandidate"]["kind"])
        idx_task = next(i for i, item in enumerate(queue["queue"]) if item["kind"] == "task")
        idx_page = next(
            i for i, item in enumerate(queue["queue"]) if item["kind"] == "attentionPage"
        )
        self.assertLess(idx_task, idx_page)

    def test_attention_page_ignores_lower_escalation_slots(self):
        task = implementation_task(
            id="00000000-0000-0000-0000-0000000000ee",
            attentionOwners=["Rowan", "Quinn", "Tom"],
        )
        self.assertEqual([], agent_task_queue._build_attention_page_items("Quinn", [task], set()))

    def test_tom_is_actionable_only_when_terminal_position_zero(self):
        terminal = implementation_task(
            id="00000000-0000-0000-0000-0000000000f0",
            attentionOwners=["Tom"],
        )
        dormant = implementation_task(
            id="00000000-0000-0000-0000-0000000000f1",
            attentionOwners=["Quinn", "Tom"],
        )
        items = agent_task_queue._build_attention_page_items("Tom", [terminal, dormant], set())
        self.assertEqual([terminal["id"]], [item["id"] for item in items])
        self.assertEqual("Tom", items[0]["topAttentionOwner"])
        self.assertTrue(items[0]["actionable"])

    def test_terminal_tom_queue_needs_no_dormant_fallback(self):
        terminal = implementation_task(attentionOwners=["Tom"])
        queue = agent_task_queue.build_work_queue(
            [], "Tom", [], [], attention_owner_tasks=[terminal], attention_owner="Tom"
        )
        self.assertEqual("attentionPage", queue["topCandidate"]["kind"])
        self.assertEqual("Tom", queue["topCandidate"]["topAttentionOwner"])

    def test_assignee_task_waits_when_another_agent_is_top_attention_owner(self):
        task = implementation_task(attentionOwners=["Quinn", "Tom"])
        queue = agent_task_queue.build_queue([task], agent="Rowan")
        self.assertEqual("WAITING_EXTERNAL", queue["items"][0]["classification"])
        self.assertEqual("Quinn", queue["items"][0]["topAttentionOwner"])

    def test_assignee_task_is_actionable_when_assignee_is_repeated_top_owner(self):
        task = implementation_task(attentionOwners=["Rowan", "Ash", "Rowan", "Tom"])
        queue = agent_task_queue.build_queue([task], agent="Rowan")
        self.assertEqual("ACTIONABLE", queue["items"][0]["classification"])
        self.assertEqual("Rowan", queue["items"][0]["topAttentionOwner"])

    def test_build_work_queue_no_attention_pages_when_flag_unset(self):
        queue = agent_task_queue.build_work_queue(
            [implementation_task()],
            "Rowan",
            [],
            [],
        )
        self.assertEqual(None, queue["attentionOwner"])
        self.assertEqual([], queue["attentionPages"])


class GhApiTimeoutTest(unittest.TestCase):
    """WS1: per-call 10s timeout + graceful TimeoutExpired translation."""

    def setUp(self) -> None:
        agent_task_queue._VERBOSE = False

    def test_gh_api_passes_explicit_timeout_to_safe_run(self):
        with patch.object(agent_task_queue, "safe_run") as mock_safe_run:
            mock_safe_run.return_value.stdout = "[]"
            agent_task_queue._gh_api("~/.config/gh-test", "TOKEN", "/x")
        self.assertEqual(
            mock_safe_run.call_args.kwargs.get("timeout"),
            agent_task_queue._GH_API_TIMEOUT_SECONDS,
        )
        self.assertEqual(
            mock_safe_run.call_args.kwargs.get("timeout"), 10.0
        )

    def test_gh_api_translates_timeout_to_sentinel(self):
        with patch.object(
            agent_task_queue,
            "safe_run",
            side_effect=subprocess.TimeoutExpired(cmd="gh", timeout=10),
        ):
            with self.assertRaises(agent_task_queue._GhApiTimeout):
                agent_task_queue._gh_api("~/.config/gh-test", "TOKEN", "/x")

    def test_gh_api_does_not_swallow_called_process_error(self):
        with patch.object(
            agent_task_queue,
            "safe_run",
            side_effect=subprocess.CalledProcessError(
                returncode=1, cmd="gh", stderr="boom"
            ),
        ):
            with self.assertRaises(subprocess.CalledProcessError):
                agent_task_queue._gh_api("~/.config/gh-test", "TOKEN", "/x")


def _deliverable_task(pr_number):
    """Build a task whose only comment posts `[implementer-prs] <url>` for `pr_number`."""
    return {
        "id": f"00000000-0000-0000-0000-{pr_number:012d}",
        "title": f"task {pr_number}",
        "taskType": "code",
        "status": "doing",
        "priority": "high",
        "assignee": "Rowan",
        "blocked": False,
        "dependencyBlocked": False,
        "comments": [
            {
                "text": "[implementer-prs] "
                f"https://github.com/Stoffer-Industries/sindustries/pull/{pr_number}"
            }
        ],
        "approvals": [],
    }


class FetchLinkedDeliveryPrsParallelTest(unittest.TestCase):
    """WS2 + WS1 integration: parallel fan-out + per-URL timeout tolerance."""

    def setUp(self) -> None:
        agent_task_queue._VERBOSE = False

    def test_linked_urls_run_in_parallel(self):
        per_call_delay = 0.2
        url_count = 8
        tasks = [_deliverable_task(100 + i) for i in range(url_count)]

        def slow_detail(_config_dir, _token_env, _pr_number):
            time.sleep(per_call_delay)
            return {
                "number": _pr_number,
                "html_url": f"https://github.com/Stoffer-Industries/sindustries/pull/{_pr_number}",
                "head": {"sha": f"sha-{_pr_number}"},
                "user": {"login": "rowanstoffer"},
                "mergeable": True,
            }

        def slow_reviews(_config_dir, _token_env, _pr_number):
            time.sleep(per_call_delay)
            return []

        def slow_checks(_config_dir, _token_env, _endpoint):
            time.sleep(per_call_delay)
            return {"check_runs": []}

        with patch.object(
            agent_task_queue, "_fetch_github_pr_detail", side_effect=slow_detail
        ), patch.object(
            agent_task_queue, "_fetch_reviews_tolerant", side_effect=slow_reviews
        ), patch.object(
            agent_task_queue, "_gh_api", side_effect=slow_checks
        ):
            started = time.monotonic()
            agent_task_queue.fetch_linked_delivery_prs("Rowan", tasks, [])
            elapsed = time.monotonic() - started

        # Sequential worst-case: 8 URLs * 3 calls * 0.2s = ~4.8s.
        # Parallel target: 3 * 0.2s + ThreadPool overhead = well under 1.5s.
        self.assertLess(
            elapsed,
            1.5,
            f"Parallel fan-out took {elapsed:.2f}s; "
            f"sequential would be ~{url_count * 3 * per_call_delay:.2f}s",
        )

    def test_linked_delivery_timeout_skips_url_not_aborts(self):
        tasks = [_deliverable_task(200 + i) for i in range(3)]
        call_count = {"n": 0}

        def flaky_detail(_config_dir, _token_env, pr_number):
            call_count["n"] += 1
            if call_count["n"] == 1:
                raise agent_task_queue._GhApiTimeout("simulated 10s timeout")
            return {
                "number": pr_number,
                "html_url": f"https://github.com/Stoffer-Industries/sindustries/pull/{pr_number}",
                "head": {"sha": f"sha-{pr_number}"},
                "user": {"login": "rowanstoffer"},
                "mergeable": True,
            }

        with patch.object(
            agent_task_queue, "_fetch_github_pr_detail", side_effect=flaky_detail
        ), patch.object(
            agent_task_queue, "_fetch_reviews_tolerant", return_value=[]
        ), patch.object(
            agent_task_queue, "_gh_api", return_value={"check_runs": []}
        ):
            out = agent_task_queue.fetch_linked_delivery_prs("Rowan", tasks, [])

        # Two of three URLs hydrate; the first URL's timeout skips it cleanly.
        self.assertEqual(len(out), 2)


class VerboseFlagTest(unittest.TestCase):
    """WS3: --verbose flag is registered on the parser and toggles the module flag."""

    def setUp(self) -> None:
        agent_task_queue._VERBOSE = False

    def test_verbose_flag_registered(self):
        parser = agent_task_queue.build_parser()
        parsed = parser.parse_args(["--assignee", "Rowan", "--verbose"])
        self.assertTrue(parsed.verbose)

    def test_default_verbose_false(self):
        parser = agent_task_queue.build_parser()
        parsed = parser.parse_args(["--assignee", "Rowan"])
        self.assertFalse(parsed.verbose)


if __name__ == "__main__":
    unittest.main()
