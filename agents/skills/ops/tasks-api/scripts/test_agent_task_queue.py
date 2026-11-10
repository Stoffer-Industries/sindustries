import argparse
import contextlib
import importlib.util
import io
import os
import pathlib
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

from agents.lib import github_cli

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

    def test_dependency_blocked_overrides_matching_attention_owner(self):
        # Task d37681e1 (2026-10-08): an attentionOwners[0] note directed the
        # implementer to proceed with delivery work while the task was still
        # dependencyBlocked. Per agents/skills/ops/attention-owner-routing/
        # SKILL.md, a position-0 slot overrides routing classification only,
        # never the dependency gate itself.
        task = implementation_task(
            dependencyBlocked=True,
            attentionOwners=["Rowan"],
        )
        queue = agent_task_queue.build_queue([task], agent="Rowan")
        item = queue["items"][0]
        self.assertEqual(item["classification"], "DEPENDENCY_BLOCKED")
        self.assertEqual(item["topAttentionOwner"], "Rowan")

    def test_matching_attention_owner_remains_actionable_when_not_dependency_blocked(self):
        # Confirms the fix is scoped to the blocked case only: a normal
        # attentionOwners[0] handoff (no incomplete dependency) must still be
        # ACTIONABLE for the matching agent, exactly as before this change.
        task = implementation_task(
            dependencyBlocked=False,
            attentionOwners=["Rowan"],
        )
        queue = agent_task_queue.build_queue([task], agent="Rowan")
        item = queue["items"][0]
        self.assertEqual(item["classification"], "ACTIONABLE")
        self.assertEqual(item["reason"], "top attention owner is Rowan")
        self.assertEqual(queue["actionableCount"], 1)

    def test_dependency_blocked_task_is_still_visible_in_queue_not_dropped(self):
        # DEPENDENCY_BLOCKED items must remain in the queue for visibility
        # (e.g. Tom/Quinn auditing state) — only actionableCount excludes
        # them, the item itself is never removed from `items`.
        task = implementation_task(
            id="blocked-visible",
            dependencyBlocked=True,
            attentionOwners=["Rowan"],
        )
        queue = agent_task_queue.build_queue([task], agent="Rowan")
        self.assertEqual(len(queue["items"]), 1)
        self.assertEqual(queue["items"][0]["id"], "blocked-visible")
        self.assertEqual(queue["actionableCount"], 0)

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

    def test_delivery_checklist_stays_assignee_actionable_without_attention_row(self):
        pr_url = "https://github.com/acme/repo/pull/1"
        classification, reason = agent_task_queue.classify_task(
            implementation_task(
                taskType="feature",
                comments=[
                    {"text": "[tech-design] https://example.test/design"},
                    {"text": "[implementer-prs] " + pr_url},
                    {
                        "text": "[feature-task-progress-checklist]\n"
                        "AC evidence needs correction before QA can act."
                    },
                ],
            ),
            delivery_prs={pr_url: pull_request(state="closed", merged_at="2026-10-10T00:00:00Z")},
        )
        self.assertEqual(classification, "ACTIONABLE")
        self.assertIn("merged", reason)

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

    def test_delivery_posted_after_stale_checklist_uses_live_pr_state(self):
        """A Lobster checklist is a snapshot. Delivery posted afterwards wins.

        Regression: the "missing `[implementer-prs]`" checklist check ran before
        the delivery check, so a task whose checklist predates its
        `[implementer-prs]` comment was pinned ACTIONABLE forever with a reason
        that contradicted the live evidence.
        """
        pr_url = "https://github.com/acme/repo/pull/1"
        classification, reason = agent_task_queue.classify_task(
            implementation_task(
                comments=[
                    {"text": "[tech-design] https://example.test/design"},
                    {
                        "text": "[code-task-progress-checklist]\n"
                        "Missing `[implementer-prs]` task comment with at least one PR URL."
                    },
                    {"text": "[implementer-prs] " + pr_url},
                ]
            ),
            delivery_prs={
                pr_url: pull_request(
                    html_url=pr_url,
                    requested_reviewers=[{"login": "quinnstoffer"}],
                )
            },
        )
        self.assertEqual(classification, "WAITING_EXTERNAL")
        self.assertIn("waiting on review", reason)

    def test_stale_checklist_does_not_mask_merged_delivery(self):
        pr_url = "https://github.com/acme/repo/pull/1"
        classification, reason = agent_task_queue.classify_task(
            implementation_task(
                comments=[
                    {"text": "[tech-design] https://example.test/design"},
                    {
                        "text": "[code-task-progress-checklist]\n"
                        "Missing `[implementer-prs]` task comment with at least one PR URL."
                    },
                    {"text": "[implementer-prs] " + pr_url},
                ]
            ),
            delivery_prs={
                pr_url: pull_request(state="closed", merged_at="2026-10-10T00:00:00Z")
            },
        )
        self.assertEqual(classification, "ACTIONABLE")
        self.assertIn("merged", reason)

    def test_checklist_still_actionable_when_no_delivery_posted(self):
        """The fix must not disarm the checklist signal for genuinely undelivered work."""
        classification, reason = agent_task_queue.classify_task(
            implementation_task(
                comments=[
                    {"text": "[tech-design] https://example.test/design"},
                    {
                        "text": "[code-task-progress-checklist]\n"
                        "Missing `[implementer-prs]` task comment with at least one PR URL."
                    },
                ]
            )
        )
        self.assertEqual(classification, "ACTIONABLE")
        self.assertIn("implementer delivery is missing", reason)

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

    def test_pending_tech_design_approvals_scopes_to_active_statuses(self):
        """Regression: an empty status list means NO filter.

        ``pending_approvals.list_tasks`` treats ``[]`` as "no status filter",
        which pulled terminal tasks into Quinn's approval queue. Task
        ``91864257`` (status=done, tech_design REVOKED, accepted APPROVED) was
        surfaced as a phantom approval for 124+ consecutive heartbeats.
        """
        with (
            patch.object(agent_task_queue.pending_approvals, "list_tasks", return_value=[]) as list_tasks,
            patch.object(agent_task_queue.tasks_api_client, "get_base_url", return_value="http://test/api/v1"),
        ):
            agent_task_queue.fetch_pending_tech_design_approvals()

        statuses = list_tasks.call_args.args[1]
        self.assertEqual(statuses, list(agent_task_queue.ACTIVE_STATUSES))
        self.assertTrue(statuses)
        for terminal in ("done", "accepted", "archived"):
            self.assertNotIn(terminal, statuses)

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
                "authoredPrConflicts",
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

    def test_authored_merge_conflict_is_actionable_queue_item(self):
        pr = pull_request(mergeable=False, mergeable_state="dirty")

        queue = agent_task_queue.classify_github_prs("Rowan", [pr])

        self.assertEqual(
            [{
                "id": "acme/repo#42",
                "repo": "acme/repo",
                "number": 42,
                "title": "feat: example",
                "url": "https://github.com/acme/repo/pull/42",
                "mergeState": "dirty",
                "reason": "authored PR has merge conflicts; rebase onto the base branch",
                "nextAction": "rebase, preserve both sides of content conflicts, push, and re-request review",
            }],
            queue["authoredPrConflicts"],
        )
        self.assertEqual([], queue["mergeCandidates"])

    def test_authored_merge_conflict_outranks_waiting_task(self):
        pr = pull_request(mergeable=False, mergeable_state="dirty")

        queue = agent_task_queue.build_work_queue(
            [implementation_task(status="acceptance")], "Rowan", [pr]
        )

        self.assertEqual("authoredPrConflict", queue["topCandidate"]["kind"])
        self.assertTrue(queue["topCandidate"]["actionable"])

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
            detail = agent_task_queue._fetch_github_pr_detail(
                "~/.config/gh-rowan",
                "ROWAN_GITHUB_TOKEN",
                "Stoffer-Industries/sindustries",
                42,
            )

        self.assertTrue(detail["mergeable"])
        self.assertEqual(2, gh_api.call_count)
        sleep.assert_called_once_with(1)

    def test_github_pr_detail_does_not_retry_known_mergeable_value(self):
        with patch.object(
            agent_task_queue,
            "_gh_api",
            return_value={"number": 42, "mergeable": True},
        ) as gh_api, patch.object(agent_task_queue.time, "sleep") as sleep:
            detail = agent_task_queue._fetch_github_pr_detail(
                "~/.config/gh-rowan",
                "ROWAN_GITHUB_TOKEN",
                "Stoffer-Industries/sindustries",
                42,
            )

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
        self.assertEqual(["stoff81"], queue["mergeCandidates"][0]["approvedBy"])

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
        # The non-self approver must be a real blocking reviewer. Tom is
        # visibility-only (see VISIBILITY_ONLY_REVIEWERS), so he is NOT a valid
        # merge gate here -- covered separately below.
        pr = pull_request(
            user={"login": "quinnstoffer"},
            reviews=[
                {
                    "user": {"login": "rowanstoffer"},
                    "state": "APPROVED",
                    "submitted_at": "2026-01-01T00:00:00Z",
                }
            ],
        )
        queue = agent_task_queue.classify_github_prs("Quinn", [pr])
        self.assertEqual(["rowanstoffer"], queue["mergeCandidates"][0]["approvedBy"])

    def test_tom_visibility_approval_alone_does_not_unblock_quinn_pr(self):
        # pr-process/SKILL.md: "do not wait for Tom's PR approval". Tom's
        # review exists for inbox visibility and must never gate merge
        # eligibility, so a Tom-only approval yields no merge candidate.
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
        self.assertEqual(
            [], agent_task_queue.classify_github_prs("Quinn", [pr])["mergeCandidates"]
        )

    def test_tom_approval_title_marker_opts_back_into_merge_gating(self):
        pr = pull_request(
            title="fix(tasks-api): tighten gate (Tom-approval)",
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
        self.assertEqual(["stoff81"], queue["mergeCandidates"][0]["approvedBy"])

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

    def test_gate_owner_is_returned_as_next_actor_without_persisting_attention(self):
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
        item = queue["workflowGateTasks"][0]
        self.assertEqual("Ash", item["workflowGateOwner"])
        self.assertIsNone(item["topAttentionOwner"])
        self.assertEqual("workflowGate", queue["topCandidate"]["kind"])

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

    def test_lox_cli_identity_is_supported_for_attention_owner_queue(self):
        self.assertEqual(
            ("loxstoffer", "~/.config/gh-lox", "LOX_GITHUB_TOKEN"),
            agent_task_queue.GITHUB_IDENTITIES["lox"],
        )
        with patch.object(sys, "argv", ["agent_task_queue.py", "--assignee", "Lox"]), \
             patch.object(agent_task_queue, "fetch_agent_tasks", return_value=[]), \
             patch.object(agent_task_queue, "fetch_github_prs", return_value=[]), \
             patch.object(agent_task_queue, "fetch_linked_delivery_prs", return_value={}), \
             patch.object(agent_task_queue, "fetch_attention_owner_tasks", return_value=[]), \
             patch.object(agent_task_queue, "fetch_workflow_gate_owner_tasks", return_value=[]), \
             patch.object(agent_task_queue, "print_human"), \
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
        github_cli._reset_credential_cache_for_tests()
        self.addCleanup(github_cli._reset_credential_cache_for_tests)

    def _usable_credentials(self):
        """A resolved credential, so `_gh_api` reaches the endpoint call.

        Task a30b8fe6 resolves the credential before the endpoint call. These
        tests exercise the endpoint path itself (timeout translation, error
        propagation, proxy stripping), so the credential resolution is
        stubbed rather than probed.
        """
        return github_cli.GhCredentials(
            source="env-token",
            token="ghp_stubbedtokenvalue12",
            login="rowanstoffer",
            reason=None,
        )

    def test_gh_api_passes_explicit_timeout_to_safe_run(self):
        with patch.object(
            agent_task_queue,
            "resolve_gh_credentials",
            return_value=self._usable_credentials(),
        ):
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
            "resolve_gh_credentials",
            return_value=self._usable_credentials(),
        ):
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
            "resolve_gh_credentials",
            return_value=self._usable_credentials(),
        ):
            with patch.object(
                agent_task_queue,
                "safe_run",
                side_effect=subprocess.CalledProcessError(
                    returncode=1, cmd="gh", stderr="boom"
                ),
            ):
                with self.assertRaises(subprocess.CalledProcessError):
                    agent_task_queue._gh_api("~/.config/gh-test", "TOKEN", "/x")

    def test_gh_api_strips_proxy_env_so_gh_bypasses_the_secret_egress_proxy(self):
        # `gh` is a Go binary; on macOS it does not honour SSL_CERT_FILE/
        # CURL_CA_BUNDLE/NODE_EXTRA_CA_CERTS. The ambient HTTP_PROXY/
        # HTTPS_PROXY route every outbound call through OpenClaw's local
        # secret-egress proxy, whose TLS certificate `gh` correctly refuses
        # to trust -- causing an identical x509 failure for every agent
        # (Rowan, Ash, Quinn, Ivy), not a per-agent credential problem
        # (2026-10-11). `_gh_api` must strip the proxy vars before shelling
        # out so `gh` connects to github.com directly.
        proxy_env = {
            "HTTP_PROXY": "http://openclaw:secret@127.0.0.1:64554",
            "HTTPS_PROXY": "http://openclaw:secret@127.0.0.1:64554",
            "http_proxy": "http://openclaw:secret@127.0.0.1:64554",
            "https_proxy": "http://openclaw:secret@127.0.0.1:64554",
            "PATH": "/usr/bin",
        }
        with patch.dict(os.environ, proxy_env, clear=True):
            with patch.object(
                agent_task_queue,
                "resolve_gh_credentials",
                return_value=self._usable_credentials(),
            ):
                with patch.object(agent_task_queue, "safe_run") as mock_safe_run:
                    mock_safe_run.return_value.stdout = "[]"
                    agent_task_queue._gh_api("~/.config/gh-test", "TOKEN", "/x")
        called_args = mock_safe_run.call_args.args[0]
        self.assertTrue(called_args[0].endswith("agents/lib/github-cli.sh"))
        called_env = mock_safe_run.call_args.kwargs.get("env")
        self.assertNotIn("GH_TOKEN", called_env)
        self.assertNotIn("GITHUB_TOKEN", called_env)
        self.assertEqual(called_env.get("PATH"), "/usr/bin")


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

        def slow_detail(_config_dir, _token_env, _repo, _pr_number):
            time.sleep(per_call_delay)
            return {
                "number": _pr_number,
                "html_url": f"https://github.com/Stoffer-Industries/sindustries/pull/{_pr_number}",
                "head": {"sha": f"sha-{_pr_number}"},
                "user": {"login": "rowanstoffer"},
                "mergeable": True,
            }

        def slow_reviews(_config_dir, _token_env, _repo, _pr_number):
            time.sleep(per_call_delay)
            return []

        def slow_checks(_config_dir, _token_env, _repo, _sha):
            time.sleep(per_call_delay)
            return {"check_runs": []}

        with patch.object(
            agent_task_queue, "_fetch_github_pr_detail", side_effect=slow_detail
        ), patch.object(
            agent_task_queue, "_fetch_reviews_tolerant", side_effect=slow_reviews
        ), patch.object(
            agent_task_queue, "_fetch_check_runs", side_effect=slow_checks
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

        def flaky_detail(_config_dir, _token_env, _repo, pr_number):
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
            agent_task_queue, "_fetch_check_runs", return_value={"check_runs": []}
        ):
            out = agent_task_queue.fetch_linked_delivery_prs("Rowan", tasks, [])

        # Two of three URLs hydrate; the first URL's timeout skips it cleanly.
        self.assertEqual(len(out), 2)


class IdentityDegradeTest(unittest.TestCase):
    """PR #851: unprovisioned/broken GitHub identity degrades, never raises.

    Regression coverage for the `_GhApiTimeout` gap found in review: the
    original guard caught only `subprocess.CalledProcessError`, so a hung
    `gh api` still took the whole JSON queue down.
    """

    def setUp(self) -> None:
        agent_task_queue._VERBOSE = False
        agent_task_queue._PR_HYDRATION_DEGRADE_REASON = None

    def tearDown(self) -> None:
        agent_task_queue._PR_HYDRATION_DEGRADE_REASON = None

    @staticmethod
    def _patched_main(fetch_github_prs_side_effect=None):
        """Common `main()` patch stack; returns the started patcher stack.

        `fetch_github_prs` is mocked with a side effect that writes the
        module-level degrade reason, because that IS the real contract: the
        function itself decides the reason and `main()` only reads it.
        """
        stack = contextlib.ExitStack()
        for name, value in (
            ("_is_identity_provisioned", True),
            ("fetch_agent_tasks", []),
            ("fetch_pending_tech_design_approvals", []),
            ("fetch_linked_delivery_prs", []),
            ("fetch_attention_owner_tasks", []),
            ("fetch_workflow_gate_owner_tasks", []),
            ("build_work_queue", {"queue": []}),
        ):
            stack.enter_context(
                patch.object(agent_task_queue, name, return_value=value)
            )
        if fetch_github_prs_side_effect is None:

            def _no_degrade(_agent, _repos=None):
                agent_task_queue._PR_HYDRATION_DEGRADE_REASON = None
                return []

            stack.enter_context(
                patch.object(
                    agent_task_queue, "fetch_github_prs", side_effect=_no_degrade
                )
            )
        else:
            stack.enter_context(
                patch.object(
                    agent_task_queue,
                    "fetch_github_prs",
                    side_effect=fetch_github_prs_side_effect,
                )
            )
        parser = stack.enter_context(patch.object(agent_task_queue, "build_parser"))
        parser.return_value.parse_args.return_value = argparse.Namespace(
            assignee="Rowan",
            json=True,
            verbose=False,
            attention_owner=None,
            repos=None,
        )
        stack.enter_context(patch.object(agent_task_queue, "print"))
        return stack

    def test_identity_provisioned_true_when_only_profile_dir_exists(self):
        """Profile-only agents (Rowan has no ROWAN_GITHUB_TOKEN) stay provisioned."""
        with patch.object(
            agent_task_queue.pathlib.Path, "is_dir", return_value=True
        ), patch.dict(os.environ, {"ROWAN_GITHUB_TOKEN": ""}):
            self.assertTrue(agent_task_queue._is_identity_provisioned("Rowan"))

    def test_identity_provisioned_true_when_only_token_env_exists(self):
        """Token-without-profile-dir agents stay provisioned too (the `or`)."""
        with patch.object(
            agent_task_queue.pathlib.Path, "is_dir", return_value=False
        ), patch.dict(os.environ, {"ROWAN_GITHUB_TOKEN": "secret"}, clear=False):
            self.assertTrue(agent_task_queue._is_identity_provisioned("Rowan"))

    def test_identity_not_provisioned_when_neither_present(self):
        with patch.object(
            agent_task_queue.pathlib.Path, "is_dir", return_value=False
        ), patch.dict(os.environ, {"ROWAN_GITHUB_TOKEN": ""}):
            self.assertFalse(agent_task_queue._is_identity_provisioned("Rowan"))

    def test_fetch_github_prs_returns_empty_when_unprovisioned(self):
        with patch.object(
            agent_task_queue, "_is_identity_provisioned", return_value=False
        ), patch.object(agent_task_queue, "_gh_api") as gh:
            self.assertEqual(agent_task_queue.fetch_github_prs("Rowan"), [])
            gh.assert_not_called()

    def test_fetch_github_prs_returns_empty_on_called_process_error(self):
        err = subprocess.CalledProcessError(4, ["gh"])
        with patch.object(
            agent_task_queue, "_is_identity_provisioned", return_value=True
        ), patch.object(agent_task_queue, "_gh_api", side_effect=err):
            self.assertEqual(agent_task_queue.fetch_github_prs("Rowan"), [])

    def test_fetch_github_prs_returns_empty_on_gh_api_timeout(self):
        """Guards finding #1: _GhApiTimeout is NOT a CalledProcessError subclass.

        `exc.returncode` would AttributeError inside the handler, so this also
        proves the message interpolation survives the timeout path.
        """
        self.assertFalse(
            issubclass(agent_task_queue._GhApiTimeout, subprocess.CalledProcessError)
        )
        with patch.object(
            agent_task_queue, "_is_identity_provisioned", return_value=True
        ), patch.object(
            agent_task_queue,
            "_gh_api",
            side_effect=agent_task_queue._GhApiTimeout("gh api exceeded 45s"),
        ):
            self.assertEqual(agent_task_queue.fetch_github_prs("Rowan"), [])

    def test_fetch_github_prs_sets_degrade_reason_when_unprovisioned(self):
        """The unprovisioned precondition must record *why* hydration degraded."""
        agent_task_queue._PR_HYDRATION_DEGRADE_REASON = None
        with patch.object(
            agent_task_queue, "_is_identity_provisioned", return_value=False
        ):
            self.assertEqual(agent_task_queue.fetch_github_prs("Rowan"), [])
        self.assertEqual(
            agent_task_queue._PR_HYDRATION_DEGRADE_REASON, "unprovisioned"
        )

    def test_fetch_github_prs_sets_degrade_reason_on_gh_api_timeout(self):
        """Rowan's Important finding: a provisioned identity that fails `gh api`
        produced an envelope byte-identical to 'no open PRs'."""
        agent_task_queue._PR_HYDRATION_DEGRADE_REASON = None
        with patch.object(
            agent_task_queue, "_is_identity_provisioned", return_value=True
        ), patch.object(
            agent_task_queue,
            "_gh_api",
            side_effect=agent_task_queue._GhApiTimeout("gh api exceeded 10s"),
        ):
            self.assertEqual(agent_task_queue.fetch_github_prs("Rowan"), [])
        reason = agent_task_queue._PR_HYDRATION_DEGRADE_REASON
        self.assertIsNotNone(reason, "provisioned-but-failing must not be silent")
        self.assertTrue(reason.startswith("gh-api-failure"), reason)
        self.assertIn("timed out", reason)

    def test_fetch_github_prs_sets_degrade_reason_on_called_process_error(self):
        """A revoked/expired token surfaces as a non-zero `gh api` exit."""
        agent_task_queue._PR_HYDRATION_DEGRADE_REASON = None
        with patch.object(
            agent_task_queue, "_is_identity_provisioned", return_value=True
        ), patch.object(
            agent_task_queue,
            "_gh_api",
            side_effect=subprocess.CalledProcessError(4, "gh"),
        ):
            self.assertEqual(agent_task_queue.fetch_github_prs("Rowan"), [])
        reason = agent_task_queue._PR_HYDRATION_DEGRADE_REASON
        self.assertTrue(reason.startswith("gh-api-failure"), reason)
        self.assertIn("exit 4", reason)
        self.assertIn("Stoffer-Industries/sindustries", reason)

    def test_fetch_github_prs_leaves_degrade_reason_unset_on_success(self):
        """Happy path stays unmarked so callers keep the real 'no open PRs' signal."""
        agent_task_queue._PR_HYDRATION_DEGRADE_REASON = None
        with patch.object(
            agent_task_queue, "_is_identity_provisioned", return_value=True
        ), patch.object(agent_task_queue, "_gh_api", return_value=[]):
            self.assertEqual(agent_task_queue.fetch_github_prs("Rowan"), [])
        self.assertIsNone(agent_task_queue._PR_HYDRATION_DEGRADE_REASON)

    def test_main_emits_pr_hydration_degraded_with_reason(self):
        """The reason must survive into the JSON envelope callers actually read."""
        def _degraded(_agent, _repos=None):
            agent_task_queue._PR_HYDRATION_DEGRADE_REASON = "gh-api-failure: exit 4"
            return []

        with self._patched_main(_degraded):
            agent_task_queue.main()
            queue = agent_task_queue.build_work_queue.return_value
            self.assertEqual(queue["prHydrationDegraded"], "gh-api-failure: exit 4")

    def test_main_emits_pr_hydration_degraded_when_unprovisioned(self):
        def _unprovisioned(_agent, _repos=None):
            agent_task_queue._PR_HYDRATION_DEGRADE_REASON = "unprovisioned"
            return []

        with self._patched_main(_unprovisioned):
            with patch.object(
                agent_task_queue, "_is_identity_provisioned", return_value=False
            ):
                agent_task_queue.main()
            queue = agent_task_queue.build_work_queue.return_value
            self.assertEqual(queue["prHydrationDegraded"], "unprovisioned")
            self.assertNotIn("identityNotProvisioned", queue)

    def test_main_omits_pr_hydration_degraded_when_healthy(self):
        with self._patched_main():
            agent_task_queue.main()
            queue = agent_task_queue.build_work_queue.return_value
            self.assertNotIn("prHydrationDegraded", queue)

    def test_main_exposes_credential_source_and_reason_in_the_envelope(self):
        """AC4: the envelope must say which credential was used, and why not.

        A silent empty projection must never be confusable with an empty work
        queue, so the caller can tell whether GitHub was reached at all.
        """
        credentials = github_cli.GhCredentials(
            source="none",
            token=None,
            login=None,
            reason="no-valid-credential",
        )
        with self._patched_main():
            with patch.object(
                agent_task_queue,
                "resolve_gh_credentials",
                return_value=credentials,
            ):
                agent_task_queue.main()
            queue = agent_task_queue.build_work_queue.return_value
            self.assertEqual(queue["credentialSource"], "none")
            self.assertEqual(queue["credentialReason"], "no-valid-credential")

    def test_main_exposes_the_resolved_credential_source_when_healthy(self):
        """AC4: the envelope names the credential source that was used."""
        credentials = github_cli.GhCredentials(
            source="keyring",
            token=None,
            login="rowanstoffer",
            reason=None,
        )
        with self._patched_main():
            with patch.object(
                agent_task_queue,
                "resolve_gh_credentials",
                return_value=credentials,
            ):
                agent_task_queue.main()
            queue = agent_task_queue.build_work_queue.return_value
            self.assertEqual(queue["credentialSource"], "keyring")
            self.assertIsNone(queue["credentialReason"])

    def test_main_resets_degrade_reason_between_runs(self):
        """Module global must not leak a stale degrade into a later clean run."""
        agent_task_queue._PR_HYDRATION_DEGRADE_REASON = "gh-api-failure: exit 1"

        def _degraded(_agent, _repos=None):
            agent_task_queue._PR_HYDRATION_DEGRADE_REASON = "unprovisioned"
            return []

        with self._patched_main(_degraded):
            agent_task_queue.main()
            queue = agent_task_queue.build_work_queue.return_value
            self.assertEqual(queue["prHydrationDegraded"], "unprovisioned")
            # Second run is healthy: the stale reason must not resurface.
            with self._patched_main():
                agent_task_queue.main()
                queue = agent_task_queue.build_work_queue.return_value
                self.assertNotIn("prHydrationDegraded", queue)


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


class MultiRepoScanTest(unittest.TestCase):
    """Task 7fba23bf: the queue projects every configured repo, and every
    emitted PR identifies its own repository.

    The failure these tests exist to prevent: a hardcoded single repo made
    `Stoffer-Industries/workspace` structurally unreachable, so four open
    workspace PRs requesting Rowan reported as `reviewRequests: []` — the
    "empty list means no coverage" false-clean shape, three times.
    """

    SINDUSTRIES = "Stoffer-Industries/sindustries"
    WORKSPACE = "Stoffer-Industries/workspace"

    def setUp(self) -> None:
        agent_task_queue._VERBOSE = False
        agent_task_queue._PR_HYDRATION_DEGRADE_REASON = None
        agent_task_queue._REPO_COVERAGE = {}

    def tearDown(self) -> None:
        agent_task_queue._PR_HYDRATION_DEGRADE_REASON = None
        agent_task_queue._REPO_COVERAGE = {}

    @staticmethod
    def _summary(number, repo, author="quinnstoffer", requested=("rowanstoffer",)):
        return {
            "number": number,
            "title": f"pr {number}",
            "html_url": f"https://github.com/{repo}/pull/{number}",
            "user": {"login": author},
            "requested_reviewers": [{"login": login} for login in requested],
        }

    @staticmethod
    def _fake_gh_api(calls, list_payloads):
        """Record every endpoint and answer the queue's endpoint shapes."""

        def _api(_config_dir, _token_env, endpoint):
            calls.append(endpoint)
            if endpoint.endswith("/pulls?state=open&per_page=100"):
                repo = endpoint.split("/")[1] + "/" + endpoint.split("/")[2]
                payload = list_payloads.get(repo, [])
                if isinstance(payload, Exception):
                    raise payload
                return payload
            if "/pulls/" in endpoint and endpoint.endswith("/reviews?per_page=100"):
                return []
            if "/check-runs?per_page=100" in endpoint:
                return {"check_runs": []}
            if "/pulls/" in endpoint:
                number = int(endpoint.rsplit("/", 1)[1])
                repo = endpoint.split("/")[1] + "/" + endpoint.split("/")[2]
                return {
                    "number": number,
                    "title": f"pr {number}",
                    "html_url": f"https://github.com/{repo}/pull/{number}",
                    "user": {"login": "quinnstoffer"},
                    "requested_reviewers": [{"login": "rowanstoffer"}],
                    "reviews": [],
                    "head": {"sha": f"sha-{number}"},
                    "mergeable": True,
                    "state": "open",
                    "draft": False,
                }
            raise AssertionError(f"unexpected endpoint: {endpoint}")

        return _api

    def test_scan_covers_every_configured_repo(self):
        calls = []
        payloads = {
            self.SINDUSTRIES: [self._summary(1, self.SINDUSTRIES)],
            self.WORKSPACE: [self._summary(2, self.WORKSPACE)],
        }
        with patch.object(
            agent_task_queue, "_is_identity_provisioned", return_value=True
        ), patch.object(
            agent_task_queue, "_gh_api", side_effect=self._fake_gh_api(calls, payloads)
        ):
            agent_task_queue.fetch_github_prs("Rowan")

        listed = {
            endpoint.split("/")[1] + "/" + endpoint.split("/")[2]
            for endpoint in calls
            if endpoint.endswith("/pulls?state=open&per_page=100")
        }
        self.assertEqual({self.SINDUSTRIES, self.WORKSPACE}, listed)

    def test_every_github_endpoint_targets_a_configured_repo(self):
        """No call site may target a repo outside the configured set."""
        calls = []
        payloads = {
            self.SINDUSTRIES: [self._summary(1, self.SINDUSTRIES)],
            self.WORKSPACE: [self._summary(2, self.WORKSPACE)],
        }
        with patch.object(
            agent_task_queue, "_is_identity_provisioned", return_value=True
        ), patch.object(
            agent_task_queue, "_gh_api", side_effect=self._fake_gh_api(calls, payloads)
        ):
            agent_task_queue.fetch_github_prs("Rowan")

        configured = {self.SINDUSTRIES, self.WORKSPACE}
        for endpoint in calls:
            self.assertTrue(endpoint.startswith("repos/"), endpoint)
            owner, name = endpoint.split("/")[1:3]
            self.assertIn(f"{owner}/{name}", configured, endpoint)

    def test_repo_qualified_ids_coexist_across_repos(self):
        """`workspace#83` and `sindustries#83` must not overwrite each other."""
        first = pull_request(
            number=83,
            html_url=f"https://github.com/{self.SINDUSTRIES}/pull/83",
            repo=self.SINDUSTRIES,
            user={"login": "quinnstoffer"},
            requested_reviewers=[{"login": "rowanstoffer"}],
        )
        second = pull_request(
            number=83,
            html_url=f"https://github.com/{self.WORKSPACE}/pull/83",
            repo=self.WORKSPACE,
            user={"login": "quinnstoffer"},
            requested_reviewers=[{"login": "rowanstoffer"}],
        )
        queue = agent_task_queue.classify_github_prs("Rowan", [first, second])
        ids = [item["id"] for item in queue["reviewRequests"]]
        self.assertEqual([f"{self.SINDUSTRIES}#83", f"{self.WORKSPACE}#83"], sorted(ids))
        repos = {item["repo"] for item in queue["reviewRequests"]}
        self.assertEqual({self.SINDUSTRIES, self.WORKSPACE}, repos)

    def test_linked_delivery_pr_is_fetched_from_its_own_repo(self):
        """A delivery link into the workspace repo is hydrated from that repo."""
        calls = []
        task = {
            "id": "00000000-0000-0000-0000-0000000000aa",
            "title": "linked",
            "taskType": "code",
            "status": "doing",
            "priority": "high",
            "assignee": "Rowan",
            "comments": [
                {
                    "text": "[implementer-prs] "
                    f"https://github.com/{self.WORKSPACE}/pull/88"
                }
            ],
            "approvals": [],
        }
        payloads = {}
        with patch.object(
            agent_task_queue, "_gh_api", side_effect=self._fake_gh_api(calls, payloads)
        ):
            out = agent_task_queue.fetch_linked_delivery_prs(
                "Rowan", [task], [], repos=[self.SINDUSTRIES, self.WORKSPACE]
            )

        self.assertTrue(
            any(
                endpoint.startswith(f"repos/{self.WORKSPACE}/pulls/")
                for endpoint in calls
            ),
            calls,
        )
        self.assertFalse(
            any(
                endpoint.startswith(f"repos/{self.SINDUSTRIES}/pulls/")
                for endpoint in calls
            ),
            calls,
        )
        self.assertEqual(1, len(out))

    def test_repo_coverage_reports_every_configured_repo(self):
        calls = []
        with patch.object(
            agent_task_queue, "_is_identity_provisioned", return_value=True
        ), patch.object(
            agent_task_queue, "_gh_api", side_effect=self._fake_gh_api(calls, {})
        ):
            agent_task_queue.fetch_github_prs("Rowan")

        rows = agent_task_queue._repo_coverage_rows(
            list(agent_task_queue.DEFAULT_SCANNED_REPOS)
        )
        self.assertEqual(
            list(agent_task_queue.DEFAULT_SCANNED_REPOS), [row["repo"] for row in rows]
        )
        for row in rows:
            self.assertEqual("ok", row["status"])
            self.assertIsNone(row["reason"])

    def test_failed_repo_fetch_is_reported_not_silently_empty(self):
        """One repo's failure degrades that repo only — and is reported."""
        calls = []
        payloads = {
            self.SINDUSTRIES: subprocess.CalledProcessError(4, ["gh"]),
            self.WORKSPACE: [self._summary(2, self.WORKSPACE)],
        }
        with patch.object(
            agent_task_queue, "_is_identity_provisioned", return_value=True
        ), patch.object(
            agent_task_queue, "_gh_api", side_effect=self._fake_gh_api(calls, payloads)
        ):
            prs = agent_task_queue.fetch_github_prs("Rowan")

        rows = {row["repo"]: row for row in agent_task_queue._repo_coverage_rows(
            list(agent_task_queue.DEFAULT_SCANNED_REPOS)
        )}
        self.assertEqual("degraded", rows[self.SINDUSTRIES]["status"])
        self.assertIn("exit 4", rows[self.SINDUSTRIES]["reason"])
        self.assertEqual("ok", rows[self.WORKSPACE]["status"])
        # The healthy repo still projects.
        self.assertEqual(1, len(prs))
        self.assertEqual(self.WORKSPACE, prs[0]["repo"])

    def test_every_emitted_pr_item_identifies_its_repo(self):
        prs = [
            pull_request(
                number=83,
                html_url=f"https://github.com/{self.WORKSPACE}/pull/83",
                repo=self.WORKSPACE,
                user={"login": "quinnstoffer"},
                requested_reviewers=[{"login": "rowanstoffer"}],
            )
        ]
        queue = agent_task_queue.classify_github_prs("Rowan", prs)
        for collection in (
            "reviewRequests",
            "authoredPrConflicts",
            "authoredPrFeedback",
            "mergeCandidates",
        ):
            for item in queue[collection]:
                self.assertTrue(item["repo"], item)
                self.assertEqual(f"{item['repo']}#{item['number']}", item["id"])
                self.assertIn(item["repo"], item["url"])

    def test_no_hardcoded_single_repo_constant(self):
        """Tripwire: the single-repo constant is gone, not merely unused."""
        self.assertIsNone(getattr(agent_task_queue, "REPO", None))

    def test_repo_set_is_validated(self):
        """A malformed repo name is a hard error, never a silent skip."""
        with self.assertRaises(ValueError):
            agent_task_queue._normalize_scanned_repos(["not-a-repo"])
        with self.assertRaises(ValueError):
            agent_task_queue._normalize_scanned_repos(["owner/name/extra"])
        self.assertEqual(
            ["owner/name"],
            agent_task_queue._normalize_scanned_repos(["owner/name", "owner/name"]),
        )

    def test_linked_delivery_outside_configured_repos_is_reported(self):
        """An unconfigured delivery repo is fetched AND reported, not swallowed."""
        calls = []
        task = {
            "id": "00000000-0000-0000-0000-0000000000ab",
            "title": "linked",
            "taskType": "code",
            "status": "doing",
            "priority": "high",
            "assignee": "Rowan",
            "comments": [
                {
                    "text": "[implementer-prs] "
                    "https://github.com/Other-Org/other-repo/pull/7"
                }
            ],
            "approvals": [],
        }
        with patch.object(
            agent_task_queue, "_gh_api", side_effect=self._fake_gh_api(calls, {})
        ):
            agent_task_queue.fetch_linked_delivery_prs(
                "Rowan", [task], [], repos=[self.SINDUSTRIES]
            )

        rows = {row["repo"]: row for row in agent_task_queue._repo_coverage_rows(
            [self.SINDUSTRIES]
        )}
        self.assertIn("Other-Org/other-repo", rows)
        self.assertEqual("degraded", rows["Other-Org/other-repo"]["status"])
        self.assertEqual(
            "linked-delivery-repo-not-configured",
            rows["Other-Org/other-repo"]["reason"],
        )


class GhTokenProbeFallbackTest(unittest.TestCase):
    """Task 76f00654: a stale token env var must not silently empty the queue.

    AC1 — stale env token plus a working keyring credential returns the same
    data as env unset; AC2 — a working env token behaves unchanged; AC3 — no
    env token and no keyring keeps the current failure mode; AC4 — the probe
    failure names its cause on stderr.

    Task a30b8fe6 moved the probe into the shared resolver in
    `agents/lib/github_cli.py`. The probe now runs there while the endpoint
    call stays in the queue module, so one stub has to patch both references
    to observe the whole exchange.
    """

    TOKEN_ENV = "ROWAN_GITHUB_TOKEN"
    STALE = "ghp_staleTokenValue1234567890"

    def setUp(self) -> None:
        agent_task_queue._VERBOSE = False
        github_cli._reset_credential_cache_for_tests()
        self.addCleanup(github_cli._reset_credential_cache_for_tests)

    def _patch_gh(self, runner):
        """Patch the `gh` runner in every module that shells out to `gh`."""
        stack = contextlib.ExitStack()
        stack.enter_context(
            patch.object(agent_task_queue, "safe_run", side_effect=runner)
        )
        stack.enter_context(patch.object(github_cli, "safe_run", side_effect=runner))
        return stack

    def _fake_gh(
        self,
        *,
        accept_token: bool,
        keyring_ok: bool = False,
        endpoint_stdout: str = "[]",
    ):
        """Return (calls, runner) for a stubbed `gh`.

        The resolver probes two candidates. The env-token candidate carries
        `OPENCLAW_GH_TOKEN` and authenticates only when `accept_token` is
        set; the keyring candidate carries no token and authenticates only
        when `keyring_ok` is set. The endpoint call always succeeds, which
        models the working credential the fallback is meant to reach.
        """
        calls: list[dict] = []

        def _runner(cmd, **kwargs):
            env = kwargs.get("env") or {}
            presented = env.get("OPENCLAW_GH_TOKEN")
            is_probe = "user" in cmd
            calls.append({"cmd": list(cmd), "token": presented, "probe": is_probe})
            if is_probe:
                if presented is not None:
                    ok = accept_token
                else:
                    ok = keyring_ok
                return subprocess.CompletedProcess(
                    cmd,
                    0 if ok else 1,
                    stdout="rowanstoffer\n" if ok else "",
                    stderr="" if ok else "gh: Bad credentials (HTTP 401)",
                )
            return subprocess.CompletedProcess(cmd, 0, stdout=endpoint_stdout, stderr="")

        return calls, _runner

    def test_stale_token_falls_back_to_the_keyring_and_still_returns_data(self):
        calls, runner = self._fake_gh(
            accept_token=False,
            keyring_ok=True,
            endpoint_stdout='[{"number": 958}]',
        )
        with patch.dict(os.environ, {self.TOKEN_ENV: self.STALE}, clear=False):
            with self._patch_gh(runner):
                result = agent_task_queue._gh_api(
                    "~/.config/gh-test", self.TOKEN_ENV, "/x"
                )
        self.assertEqual(result, [{"number": 958}])
        probes = [call for call in calls if call["probe"]]
        endpoints = [call for call in calls if not call["probe"]]
        # The env token is probed first, then the keyring candidate.
        self.assertEqual(len(probes), 2)
        self.assertEqual(probes[0]["token"], self.STALE)
        self.assertIsNone(probes[1]["token"])
        self.assertEqual(len(endpoints), 1)
        self.assertIsNone(endpoints[0]["token"])

    def test_working_token_is_still_injected(self):
        calls, runner = self._fake_gh(accept_token=True)
        with patch.dict(os.environ, {self.TOKEN_ENV: self.STALE}, clear=False):
            with self._patch_gh(runner):
                result = agent_task_queue._gh_api(
                    "~/.config/gh-test", self.TOKEN_ENV, "/x"
                )
        self.assertEqual(result, [])
        endpoints = [call for call in calls if not call["probe"]]
        self.assertEqual(len(endpoints), 1)
        self.assertEqual(endpoints[0]["token"], self.STALE)

    def test_no_token_keeps_the_current_failure_mode(self):
        calls: list[list] = []

        def _runner(cmd, **kwargs):
            calls.append(list(cmd))
            raise subprocess.CalledProcessError(
                returncode=1, cmd=cmd, stderr="gh: not authenticated"
            )

        env = {k: v for k, v in os.environ.items() if k != self.TOKEN_ENV}
        with patch.dict(os.environ, env, clear=True):
            with self._patch_gh(_runner):
                with self.assertRaises(subprocess.CalledProcessError):
                    agent_task_queue._gh_api("~/.config/gh-test", self.TOKEN_ENV, "/x")
        # The keyring candidate is probed once and fails, so the call fails
        # closed instead of silently degrading to an empty projection.
        self.assertEqual(len(calls), 1)
        self.assertIn("user", calls[0])

    def test_probe_failure_names_its_cause_on_stderr(self):
        calls, runner = self._fake_gh(accept_token=False)
        stderr = io.StringIO()
        with patch.dict(os.environ, {self.TOKEN_ENV: self.STALE}, clear=False):
            with self._patch_gh(runner):
                with contextlib.redirect_stderr(stderr):
                    with self.assertRaises(subprocess.CalledProcessError):
                        agent_task_queue._gh_api(
                            "~/.config/gh-test", self.TOKEN_ENV, "/x"
                        )
        message = stderr.getvalue()
        self.assertIn(self.TOKEN_ENV, message)
        self.assertIn("falling back", message)
        self.assertIn("~/.config/gh-test", message)
        self.assertIn("HTTP 401", message)
        self.assertNotIn(self.STALE, message)

    def test_probe_detail_redacts_token_shaped_values(self):
        def _runner(cmd, **kwargs):
            if "user" in cmd:
                return subprocess.CompletedProcess(
                    cmd, 1, stdout="", stderr=f"gh: Bad credentials ({self.STALE})"
                )
            return subprocess.CompletedProcess(cmd, 0, stdout="[]", stderr="")

        stderr = io.StringIO()
        with patch.dict(os.environ, {self.TOKEN_ENV: self.STALE}, clear=False):
            with self._patch_gh(_runner):
                with contextlib.redirect_stderr(stderr):
                    with self.assertRaises(subprocess.CalledProcessError):
                        agent_task_queue._gh_api(
                            "~/.config/gh-test", self.TOKEN_ENV, "/x"
                        )
        message = stderr.getvalue()
        self.assertNotIn(self.STALE, message)
        self.assertIn("***", message)

    def test_probe_runs_once_per_process(self):
        calls, runner = self._fake_gh(accept_token=True)
        with patch.dict(os.environ, {self.TOKEN_ENV: self.STALE}, clear=False):
            with self._patch_gh(runner):
                agent_task_queue._gh_api("~/.config/gh-test", self.TOKEN_ENV, "/x")
                agent_task_queue._gh_api("~/.config/gh-test", self.TOKEN_ENV, "/y")
        probes = [call for call in calls if call["probe"]]
        self.assertEqual(len(probes), 1)
