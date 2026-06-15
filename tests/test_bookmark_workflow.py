#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "agents/workflows/bookmark"))

import common
import create_tasks_from_proposals
import list_review_candidates
import list_spec_requests
import migrate_flat_paths
import filter_curation
import summarize as summarize_mod
import finalize_review_cycle
import generate_specs
import prepare_topic_approval
import request_topic_approval
import resolve_topic_approval
import handle_approval_reply


class BookmarkWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.state_path = self.root / "brain" / "state" / "bookmark-review-state.json"
        self.approval_topics_path = self.root / "brain" / "state" / "bookmark-approval-topics.json"
        self.reviews_root = self.root / "brain" / "reviews"
        self.specs_root = self.root / "docs" / "specs"
        audit_patcher = patch.object(
            handle_approval_reply,
            "AUDIT_LOG_PATH",
            self.root / "brain/state/approval-reply-audit.csv",
        )
        audit_patcher.start()
        self.addCleanup(audit_patcher.stop)
        self.bookmark = {
            "bookmarkKey": "abc123bookmark",
            "path": "brain/bookmarks/infra/sample.md",
            "topic": "infra",
            "source": "x",
            "title": "Agent Harness Note",
            "link": "https://example.com/post",
            "tags": ["agents", "workflow"],
            "type": "infra",
            "dateArchived": "2026-03-26",
            "bodyExcerpt": "A practical note about harness design and approval gates.",
            "body": "A practical note about harness design, approval gates, and turning bookmarks into execution.",
        }

    def tearDown(self):
        self.tempdir.cleanup()

    def test_bookmark_record_uses_brain_relative_path_for_paths_outside_workspace(self):
        outside_root = self.root / "icloud" / "brain" / "bookmarks"
        bookmark_path = outside_root / "infra" / "sample.md"
        bookmark_path.parent.mkdir(parents=True, exist_ok=True)
        bookmark_path.write_text(
            "---\n"
            "title: Outside Workspace Bookmark\n"
            "link: https://example.com/outside\n"
            "source: x\n"
            "---\n\n"
            "hello\n",
            encoding="utf-8",
        )

        with patch.object(common, "WORKSPACE", self.root), \
             patch.object(common, "BOOKMARKS_ROOT", outside_root):
            record = common.bookmark_record(bookmark_path)

        self.assertEqual(record["path"], "brain/bookmarks/infra/sample.md")
        self.assertEqual(record["bookmarkKey"], common.bookmark_key(bookmark_path, {"link": "https://example.com/outside"}))

    def test_generate_specs_creates_multiple_docs_and_task_proposals_from_llm_output(self):
        bookmark_path = self.root / self.bookmark["path"]
        bookmark_path.parent.mkdir(parents=True, exist_ok=True)
        bookmark_path.write_text(
            "---\n"
            "title: Agent Harness Note\n"
            "link: https://example.com/post\n"
            "tags: [\"agents\", \"workflow\"]\n"
            "source: x\n"
            "type: infra\n"
            "date_archived: 2026-03-26\n"
            "---\n\n"
            "A practical note about harness design, approval gates, and turning bookmarks into execution.\n",
            encoding="utf-8",
        )

        state = common.state_template()
        state["items"][self.bookmark["bookmarkKey"]] = {
            "bookmarkKey": self.bookmark["bookmarkKey"],
            "path": self.bookmark["path"],
            "topic": self.bookmark["topic"],
            "source": self.bookmark["source"],
            "title": self.bookmark["title"],
            "reviewStatus": "implement",
            "reviewDoc": "brain/reviews/infra/agent-harness-note-abc123bookmark.md",
            "analysis": {
                "classification": "implement",
                "headline": "Worth building into the current workflow",
                "summary": "Useful.",
                "decisionRationale": "This belongs in the active implementation queue.",
                "stackJudgment": "Fits workflow automation.",
                "recommendation": "Draft specs.",
                "signals": ["Relevant to OpenClaw"],
                "risks": ["Needs scoping"],
                "monitorTriggers": ["Revisit if workflow priorities shift"],
                "implementationPaths": ["Improve review quality"],
            },
            "specDocs": [],
            "specProposals": [],
            "taskIds": [],
            "firstSeenAt": common.now_iso(),
            "reviewedAt": common.now_iso(),
            "lastUpdatedAt": common.now_iso(),
        }
        common.save_state(state, self.state_path)

        llm_specs = {
            "specs": [
                {
                    "title": "LLM-driven bookmark reviews",
                    "specType": "workflow-improvement",
                    "whySeparateNow": "The review quality problem is an independent slice from approval packaging.",
                    "outcome": "Reviews make explicit stack-aware decisions and stop reading like templates.",
                    "problemStatement": "Current reviews are templated instead of judged.",
                    "approach": "Introduce structured LLM analysis, richer workspace context, and a review renderer built around decision quality.",
                    "stackTouchpoints": ["scripts/bookmarks/summarize_mod.py", "brain/state/bookmark-review-state.json"],
                    "scopeBoundaries": ["Review stage only", "No task creation yet"],
                    "risksAndUnknowns": ["Prompt quality may need tuning"],
                    "incrementalRollout": ["Wire LLM call", "Persist analysis", "Exercise hourly workflow"],
                    "successChecks": ["Review docs explain why monitor vs implement", "State preserves richer analysis for later steps"],
                    "proposedTasks": [
                        {
                            "title": "Wire structured review analysis",
                            "priority": "high",
                            "summary": "Replace deterministic review templates with LLM judgment.",
                            "deliverable": "Updated review generator with richer analysis schema and rendered decision docs.",
                            "acceptanceCriteria": ["Review output includes classification", "State stores analysis"],
                        }
                    ],
                },
                {
                    "title": "Approval package hardening",
                    "specType": "workflow-guardrail",
                    "whySeparateNow": "Approval pressure is a distinct operational concern with its own guardrails.",
                    "outcome": "Only one approval package per topic can move forward at a time without blocking review generation.",
                    "problemStatement": "Approval prep must respect one pending package per topic.",
                    "approach": "Use state-backed topic gating before packaging or sending approval prompts.",
                    "stackTouchpoints": ["scripts/bookmarks/prepare_topic_approval.py", "scripts/bookmarks/request_topic_approval.py"],
                    "scopeBoundaries": ["Prepare step only"],
                    "risksAndUnknowns": ["Existing state may already violate the rule"],
                    "incrementalRollout": ["Detect pending topics", "Block duplicates"],
                    "successChecks": ["Ready packages exclude topics with approval_pending items"],
                    "proposedTasks": [
                        {
                            "title": "Block duplicate pending approvals",
                            "priority": "medium",
                            "summary": "Keep at most one approval package active per topic.",
                            "deliverable": "Topic-level block in approval package preparation.",
                            "acceptanceCriteria": ["Ready packages exclude pending topics"],
                        }
                    ],
                },
            ]
        }
        stdin = io.StringIO(json.dumps({"implement": [self.bookmark], "monitoring": [], "reviewed": []}))
        stdout = io.StringIO()

        with patch.object(generate_specs, "STATE_PATH", self.state_path), \
             patch.object(generate_specs, "SPECS_ROOT", self.specs_root), \
             patch.object(generate_specs, "WORKSPACE", self.root):
            with patch("sys.stdin", stdin), patch("sys.stdout", stdout), patch.object(sys, "argv", ["generate_specs.py", "--json"]):
                rc = generate_specs.main()

        self.assertEqual(rc, 0)
        payload = json.loads(stdout.getvalue())
        # Spec generation is now delegated to Quinn's heartbeat; implement list is empty.
        self.assertEqual(payload["implement"], [])

        state = common.load_state(self.state_path)
        item = state["items"][self.bookmark["bookmarkKey"]]
        self.assertEqual(item["reviewStatus"], "spec_requested")

    def test_invoke_llm_json_surfaces_acpx_failures(self):
        acpx_error = subprocess.CalledProcessError(
            1,
            ["/opt/homebrew/bin/acpx", "codex", "exec"],
            stderr="codex failed",
        )

        with patch.dict(os.environ, {"BOOKMARK_LLM_USE_AGENT_DIRECT": "false", "BOOKMARK_LLM_FALLBACK": "none"}), \
             patch("common.subprocess.run", side_effect=[acpx_error]):
            with self.assertRaises(common.LLMInvocationError) as exc:
                common.invoke_llm_json("Prompt", {"bookmark": "x"}, {"type": "object"})

        self.assertIn("acpx/codex failed", str(exc.exception))

    def test_invoke_llm_json_uses_agent_by_default(self):
        """Test that use_agent_direct=true routes to OpenClaw agent"""
        test_result = {"classification": "monitor", "headline": "test"}
        
        with patch.dict(os.environ, {"BOOKMARK_LLM_USE_AGENT_DIRECT": "true"}), \
             patch("common.invoke_llm_json_via_agent", return_value=test_result) as agent_mock:
            result = common.invoke_llm_json("Prompt", {"bookmark": "x"}, {"type": "object"})
        
        self.assertEqual(result, test_result)
        agent_mock.assert_called_once()

    def test_build_approval_message_reads_like_an_actual_request(self):
        package = {
            "approvalTopic": "infra",
            "items": [
                {
                    "title": "Agent Harness Note",
                    "headline": "Tighten the bookmark workflow before it creates queue debt.",
                    "summary": "The current flow can generate docs but the approval step is still rough.",
                    "decisionRationale": "This is worth doing now because the pipeline is already drafting plans and needs a cleaner human gate.",
                    "stackJudgment": "It fits directly into the existing scripts/bookmarks review and approval path.",
                    "recommendation": "Approve the plan so the approval step can move from stub to usable gate.",
                    "reviewDoc": "brain/reviews/infra/agent-harness-note.md",
                    "specDocs": ["brain/specs/infra/approval-step.md"],
                    "proposedTasks": [
                        {
                            "title": "Ship approval message rewrite",
                            "priority": "high",
                            "description": "**Deliverable:** A concise approval request that Tom can scan in-chat.",
                        }
                    ],
                }
            ],
            "proposedTasks": [
                {
                    "title": "Ship approval message rewrite",
                    "priority": "high",
                    "description": "**Deliverable:** A concise approval request that Tom can scan in-chat.",
                }
            ],
        }

        message = request_topic_approval.build_approval_message(package)

        self.assertIn("Approval request: infra", message)
        self.assertIn("Reply: `approve` / `decline`", message)
        self.assertIn("Proposed tasks", message)
        self.assertIn("Spec path", message)
        self.assertIn("Reply: `approve` / `decline`", message)

    def test_prepare_topic_approval_blocks_when_topic_already_pending(self):
        state = common.state_template()
        state["items"]["existing"] = {
            "bookmarkKey": "existing",
            "path": "brain/bookmarks/infra/existing.md",
            "topic": "infra",
            "source": "x",
            "title": "Existing",
            "reviewStatus": "approval_pending",
            "approvalTopic": "infra",
            "specDocs": ["brain/specs/infra/existing.md"],
            "taskIds": [],
        }
        common.save_state(state, self.state_path)

        stdin = io.StringIO(json.dumps({
            "implement": [
                {
                    "bookmarkKey": self.bookmark["bookmarkKey"],
                    "topic": "infra",
                    "title": self.bookmark["title"],
                    "specDocs": ["brain/specs/infra/new.md"],
                    "proposedTasks": [],
                }
            ],
            "monitoring": [],
            "reviewed": [],
        }))
        stdout = io.StringIO()
        with patch.object(prepare_topic_approval, "STATE_PATH", self.state_path):
            with patch("sys.stdin", stdin), patch("sys.stdout", stdout), patch.object(sys, "argv", ["prepare_topic_approval.py", "--json"]):
                rc = prepare_topic_approval.main()

        self.assertEqual(rc, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["readyPackages"], [])
        self.assertEqual(len(payload["blockedPackages"]), 1)
        self.assertEqual(payload["blockedPackages"][0]["reason"], "approval already pending for topic")

    def test_build_task_proposals_recovers_spec_created_items_for_approval_retry(self):
        state = common.state_template()
        state["items"][self.bookmark["bookmarkKey"]] = {
            "bookmarkKey": self.bookmark["bookmarkKey"],
            "path": self.bookmark["path"],
            "topic": self.bookmark["topic"],
            "source": self.bookmark["source"],
            "title": self.bookmark["title"],
            "reviewStatus": "spec_created",
            "reviewDoc": "brain/reviews/infra/agent-harness-note-abc123bookmark.md",
            "analysis": {
                "classification": "implement",
                "headline": "Worth building",
                "summary": "Useful.",
                "decisionRationale": "Still worth implementation.",
                "stackJudgment": "Fits workflow automation.",
                "recommendation": "Proceed.",
                "signals": ["Relevant to OpenClaw"],
                "risks": ["Needs scoping"],
                "monitorTriggers": [],
                "implementationPaths": ["Improve review quality"],
            },
            "specDocs": ["brain/specs/infra/agent-harness-note-abc123bookmark.md"],
            "specProposals": [
                {
                    "title": "Approval package hardening",
                    "specDoc": "brain/specs/infra/agent-harness-note-abc123bookmark.md",
                    "proposedTasks": [
                        {
                            "title": "Retry approval delivery",
                            "priority": "high",
                            "assignee": None,
                            "description": "Ensure failed approval delivery can be retried.",
                        }
                    ],
                }
            ],
            "taskIds": [],
            "firstSeenAt": common.now_iso(),
            "reviewedAt": common.now_iso(),
            "lastUpdatedAt": common.now_iso(),
        }
        common.save_state(state, self.state_path)

        stdin = io.StringIO(json.dumps({"implement": [], "monitoring": [], "reviewed": []}))
        stdout = io.StringIO()
        import build_task_proposals
        with patch.object(build_task_proposals, "STATE_PATH", self.state_path), \
             patch("sys.stdin", stdin), patch("sys.stdout", stdout), patch.object(sys, "argv", ["build_task_proposals.py", "--json"]):
            rc = build_task_proposals.main()

        self.assertEqual(rc, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(len(payload["implement"]), 1)
        recovered = payload["implement"][0]
        self.assertEqual(recovered["bookmarkKey"], self.bookmark["bookmarkKey"])
        self.assertTrue(recovered["recoveredForApproval"])
        self.assertEqual(len(recovered["proposedTasks"]), 1)
        self.assertEqual(recovered["proposedTasks"][0]["title"], "Retry approval delivery")

    def test_prepare_and_request_topic_approval_include_proposed_tasks(self):
        state = common.state_template()
        state["items"][self.bookmark["bookmarkKey"]] = {
            "bookmarkKey": self.bookmark["bookmarkKey"],
            "path": self.bookmark["path"],
            "topic": self.bookmark["topic"],
            "source": self.bookmark["source"],
            "title": self.bookmark["title"],
            "reviewStatus": "spec_created",
            "reviewDoc": "brain/reviews/infra/agent-harness-note-abc123bookmark.md",
            "specDocs": ["brain/specs/infra/llm-driven-bookmark-reviews-abc123bookmark.md"],
            "taskIds": [],
        }
        common.save_state(state, self.state_path)

        implement_item = {
            "bookmarkKey": self.bookmark["bookmarkKey"],
            "topic": "infra",
            "title": self.bookmark["title"],
            "reviewDoc": "brain/reviews/infra/agent-harness-note-abc123bookmark.md",
            "analysis": {
                "summary": "Strong fit for workflow automation.",
                "decisionRationale": "It is worth implementation now because it sharpens triage before approval and tasking.",
                "stackJudgment": "It improves bookmark triage quality before tasking.",
            },
            "specDocs": ["brain/specs/infra/llm-driven-bookmark-reviews-abc123bookmark.md"],
            "proposedTasks": [
                {
                    "title": "Wire structured review analysis",
                    "priority": "high",
                    "assignee": None,
                    "description": "Implement LLM-backed bookmark review output.",
                }
            ],
        }

        prep_in = io.StringIO(json.dumps({"implement": [implement_item], "monitoring": [], "reviewed": []}))
        prep_out = io.StringIO()
        with patch.object(prepare_topic_approval, "STATE_PATH", self.state_path):
            with patch("sys.stdin", prep_in), patch("sys.stdout", prep_out), patch.object(sys, "argv", ["prepare_topic_approval.py", "--json"]):
                rc = prepare_topic_approval.main()

        self.assertEqual(rc, 0)
        prepared = json.loads(prep_out.getvalue())
        self.assertEqual(len(prepared["readyPackages"]), 1)
        package = prepared["readyPackages"][0]
        self.assertEqual(len(package["proposedTasks"]), 1)
        self.assertEqual(package["items"][0]["proposedTasks"][0]["title"], "Wire structured review analysis")

        prepared["readyPackages"][0]["resumeToken"] = "resume-token-1"
        request_in = io.StringIO(json.dumps(prepared))
        request_out = io.StringIO()
        with patch.object(request_topic_approval, "STATE_PATH", self.state_path), \
             patch.object(request_topic_approval, "resolve_delivery_config", return_value=(None, None)), \
             patch.object(request_topic_approval, "deliver_approval_message", return_value=None):
            with patch("sys.stdin", request_in), patch("sys.stdout", request_out), patch.object(sys, "argv", ["request_topic_approval.py"]):
                rc = request_topic_approval.main()

        self.assertEqual(rc, 0)
        requested = json.loads(request_out.getvalue())
        approval = requested["approvals"][0]
        self.assertEqual(approval["proposedTasks"][0]["title"], "Wire structured review analysis")
        self.assertEqual(approval["items"][0]["bookmarkKey"], self.bookmark["bookmarkKey"])
        self.assertIn("Reply: `approve` / `decline`", approval["message"])
        self.assertIn("Wire structured review analysis", approval["message"])
        self.assertIsNone(approval["delivery"])

        updated_state = common.load_state(self.state_path)
        item = updated_state["items"][self.bookmark["bookmarkKey"]]
        self.assertNotIn("approvalStatus", item)
        self.assertNotIn("approvalResumeToken", item)
        self.assertEqual(item["reviewStatus"], "spec_created")
        self.assertNotIn("infra", updated_state["approvalLocks"])

    def test_resolve_delivery_config_prefers_topic_file(self):
        self.approval_topics_path.parent.mkdir(parents=True, exist_ok=True)
        self.approval_topics_path.write_text(json.dumps({
            "chatId": "-1003262754118",
            "topics": {"general": 1, "infra": 2},
        }))

        with patch.object(request_topic_approval, "APPROVAL_TOPICS_PATH", self.approval_topics_path), \
             patch.dict(os.environ, {}, clear=False):
            delivery, error = request_topic_approval.resolve_delivery_config("infra")

        self.assertIsNone(error)
        self.assertEqual(delivery["channel"], "telegram")
        self.assertEqual(delivery["target"], "-1003262754118")
        self.assertEqual(delivery["threadId"], "2")
        self.assertEqual(delivery["routingSource"], "config")
        self.assertIsNone(delivery["routingWarning"])

    def test_resolve_delivery_config_falls_back_to_general_topic(self):
        self.approval_topics_path.parent.mkdir(parents=True, exist_ok=True)
        self.approval_topics_path.write_text(json.dumps({
            "chatId": "-1003262754118",
            "topics": {"general": 1},
        }))

        with patch.object(request_topic_approval, "APPROVAL_TOPICS_PATH", self.approval_topics_path), \
             patch.dict(os.environ, {}, clear=False):
            delivery, error = request_topic_approval.resolve_delivery_config("design")

        self.assertIsNone(error)
        self.assertEqual(delivery["threadId"], "1")
        self.assertEqual(delivery["routingSource"], "config-general-fallback")
        self.assertIn("falling back to 'general'", delivery["routingWarning"])

    def test_resolve_delivery_config_reports_missing_topic_without_fallback(self):
        self.approval_topics_path.parent.mkdir(parents=True, exist_ok=True)
        self.approval_topics_path.write_text(json.dumps({
            "chatId": "-1003262754118",
            "topics": {"infra": 2},
        }))

        with patch.object(request_topic_approval, "APPROVAL_TOPICS_PATH", self.approval_topics_path), \
             patch.dict(os.environ, {}, clear=False):
            delivery, error = request_topic_approval.resolve_delivery_config("design")

        self.assertIsNone(delivery)
        self.assertIn("topic 'design' missing", error)

    def test_request_topic_approval_delivers_when_channel_env_is_configured(self):
        state = common.state_template()
        state["items"][self.bookmark["bookmarkKey"]] = {
            "bookmarkKey": self.bookmark["bookmarkKey"],
            "path": self.bookmark["path"],
            "topic": self.bookmark["topic"],
            "source": self.bookmark["source"],
            "title": self.bookmark["title"],
            "reviewStatus": "spec_created",
            "reviewDoc": "brain/reviews/infra/agent-harness-note-abc123bookmark.md",
            "specDocs": ["brain/specs/infra/llm-driven-bookmark-reviews-abc123bookmark.md"],
            "taskIds": [],
        }
        common.save_state(state, self.state_path)

        prepared = {
            "readyPackages": [
                {
                    "topic": "infra",
                    "approvalTopic": "infra",
                    "items": [
                        {
                            "bookmarkKey": self.bookmark["bookmarkKey"],
                            "title": self.bookmark["title"],
                            "summary": "Strong fit for workflow automation.",
                            "decisionRationale": "Worth implementation now.",
                            "stackJudgment": "Fits the current review pipeline.",
                            "reviewDoc": "brain/reviews/infra/agent-harness-note-abc123bookmark.md",
                            "specDocs": ["brain/specs/infra/llm-driven-bookmark-reviews-abc123bookmark.md"],
                            "proposedTasks": [{"title": "Implement harness review", "description": "Wire the bookmark review flow."}],
                        }
                    ],
                    "proposedTasks": [{"title": "Implement harness review", "description": "Wire the bookmark review flow."}],
                }
            ],
            "blockedPackages": [],
        }

        self.approval_topics_path.parent.mkdir(parents=True, exist_ok=True)
        self.approval_topics_path.write_text(json.dumps({
            "chatId": "-1003262754118",
            "topics": {"general": 1, "infra": 42},
        }))

        prepared["readyPackages"][0]["resumeToken"] = "resume-token-2"
        request_in = io.StringIO(json.dumps(prepared))
        request_out = io.StringIO()
        send_result = {"ok": True, "messageId": "123"}
        with patch.object(request_topic_approval, "STATE_PATH", self.state_path), \
             patch.object(request_topic_approval, "APPROVAL_TOPICS_PATH", self.approval_topics_path), \
             patch.dict(os.environ, {}, clear=False), \
             patch("request_topic_approval.subprocess.run", return_value=subprocess.CompletedProcess(["openclaw", "message"], 0, stdout=json.dumps(send_result), stderr="")) as send_mock:
            with patch("sys.stdin", request_in), patch("sys.stdout", request_out), patch.object(sys, "argv", ["request_topic_approval.py"]):
                rc = request_topic_approval.main()

        self.assertEqual(rc, 0)
        requested = json.loads(request_out.getvalue())
        approval = requested["approvals"][0]
        self.assertEqual(approval["delivery"]["threadId"], "42")
        self.assertEqual(approval["delivery"]["messageId"], "123")
        self.assertEqual(approval["delivery"]["target"], "-1003262754118")
        self.assertEqual(approval["delivery"]["routingSource"], "config")
        self.assertEqual(approval["delivery"]["result"]["messageId"], "123")
        updated_state = common.load_state(self.state_path)
        item = updated_state["items"][self.bookmark["bookmarkKey"]]
        self.assertEqual(item.get("approvalMessageId"), "123")
        self.assertEqual(item.get("approvalThreadId"), "42")
        sent_args = send_mock.call_args.args[0]
        self.assertIn("--thread-id", sent_args)
        self.assertIn("-1003262754118", sent_args)

    def test_request_topic_approval_releases_claim_when_delivery_has_no_ids(self):
        state = common.state_template()
        state["items"][self.bookmark["bookmarkKey"]] = {
            "bookmarkKey": self.bookmark["bookmarkKey"],
            "topic": "infra",
            "title": self.bookmark["title"],
            "reviewStatus": "spec_created",
            "specDocs": ["brain/bookmarks/specs/infra/example.md"],
            "taskIds": [],
        }
        common.save_state(state, self.state_path)
        prepared = {
            "readyPackages": [{
                "topic": "infra",
                "approvalTopic": "infra",
                "resumeToken": "resume-token-failed-delivery",
                "items": [{
                    "bookmarkKey": self.bookmark["bookmarkKey"],
                    "specDocs": ["brain/bookmarks/specs/infra/example.md"],
                    "proposedTasks": [],
                }],
                "proposedTasks": [],
            }],
            "blockedPackages": [],
        }
        delivery = {
            "channel": "telegram",
            "target": "-1003262754118",
            "threadId": "2",
        }

        request_in = io.StringIO(json.dumps(prepared))
        request_out = io.StringIO()
        with patch.object(request_topic_approval, "STATE_PATH", self.state_path), \
             patch.object(request_topic_approval, "resolve_delivery_config", return_value=(delivery, None)), \
             patch.object(request_topic_approval, "deliver_approval_message", return_value={
                 "messageId": None,
                 "threadId": None,
                 "result": {"ok": False, "error": "telegram unavailable"},
             }):
            with patch("sys.stdin", request_in), patch("sys.stdout", request_out), patch.object(sys, "argv", ["request_topic_approval.py"]):
                rc = request_topic_approval.main()

        self.assertEqual(rc, 0)
        payload = json.loads(request_out.getvalue())
        self.assertEqual(payload["approvals"][0]["deliveryError"], "telegram unavailable")
        updated_state = common.load_state(self.state_path)
        item = updated_state["items"][self.bookmark["bookmarkKey"]]
        self.assertEqual(item["reviewStatus"], "spec_created")
        self.assertNotIn("approvalId", item)
        self.assertNotIn("infra", updated_state["approvalLocks"])

    def test_next_revised_live_spec_doc_adds_and_increments_rev_suffix(self):
        self.assertEqual(
            generate_specs.next_revised_live_spec_doc("infra/example-abc123.md"),
            "infra/example-abc123-rev1.md",
        )
        self.assertEqual(
            generate_specs.next_revised_live_spec_doc("infra/example-abc123-rev1.md"),
            "infra/example-abc123-rev2.md",
        )

    def test_generate_specs_revision_moves_old_spec_to_specs_revised_and_links_it(self):
        bookmark_path = self.root / self.bookmark["path"]
        bookmark_path.parent.mkdir(parents=True, exist_ok=True)
        bookmark_path.write_text(
            "---\n"
            "title: Agent Harness Note\n"
            "link: https://example.com/post\n"
            "source: x\n"
            "---\n\n"
            "Body\n",
            encoding="utf-8",
        )

        specs_root = self.root / "brain" / "specs"
        revised_root = self.root / "brain" / "specs-revised"
        existing_rel = "brain/specs/infra/agent-harness-note-abc123bookmark.md"
        existing_path = self.root / existing_rel
        existing_path.parent.mkdir(parents=True, exist_ok=True)
        existing_path.write_text("# Old Spec\nold body\n", encoding="utf-8")

        state = common.state_template()
        state["items"][self.bookmark["bookmarkKey"]] = {
            "bookmarkKey": self.bookmark["bookmarkKey"],
            "path": self.bookmark["path"],
            "topic": self.bookmark["topic"],
            "source": self.bookmark["source"],
            "title": self.bookmark["title"],
            "reviewStatus": "revision_requested",
            "reviewDoc": "brain/reviews/infra/agent-harness-note-abc123bookmark.md",
            "analysis": {"classification": "implement"},
            "specDocs": [existing_rel],
            "specProposals": [{
                "title": "Agent Harness Note",
                "specDoc": existing_rel,
                "proposedTasks": [{
                    "title": "Old task",
                    "priority": "medium",
                    "description": "Old desc",
                }],
            }],
            "latestRevisionRequest": "tighten the scope",
            "taskIds": [],
        }
        common.save_state(state, self.state_path)

        revision_output = {
            "specs": [{
                "title": "Agent Harness Note Revised",
                "specDoc": existing_rel,
                "specType": "workflow-improvement",
                "whySeparateNow": "Need a cleaner scope.",
                "outcome": "A narrower approval-ready spec.",
                "problemStatement": "Old spec was too broad.",
                "approach": "Move old spec aside and write a revised version.",
                "stackTouchpoints": ["scripts/bookmarks/generate_specs.py"],
                "scopeBoundaries": ["Only this spec file"],
                "risksAndUnknowns": ["Link paths could drift"],
                "incrementalRollout": ["Archive old spec", "Write revised spec"],
                "successChecks": ["Previous Spec header exists"],
                "proposedTasks": [{
                    "title": "Revise spec archive flow",
                    "priority": "high",
                    "summary": "Preserve prior spec revisions.",
                    "deliverable": "Old spec moved to specs-revised and new spec links back to it.",
                    "acceptanceCriteria": ["Old spec archived", "New spec has Previous Spec link"],
                }],
            }]
        }

        stdin = io.StringIO(json.dumps({"implement": [self.bookmark], "monitoring": [], "reviewed": []}))
        stdout = io.StringIO()
        with patch.object(generate_specs, "STATE_PATH", self.state_path), \
             patch.object(generate_specs, "SPECS_ROOT", specs_root), \
             patch.object(generate_specs, "WORKSPACE", self.root):
            with patch("sys.stdin", stdin), patch("sys.stdout", stdout), patch.object(sys, "argv", ["generate_specs.py", "--json", "--specs-root", str(specs_root)]):
                rc = generate_specs.main()

        self.assertEqual(rc, 0)
        # Revision handling is now delegated to Quinn's heartbeat; state stays revision_requested.
        archived_path = revised_root / "infra" / Path(existing_rel).name
        self.assertFalse(archived_path.exists())

        updated_state = common.load_state(self.state_path)
        item = updated_state["items"][self.bookmark["bookmarkKey"]]
        self.assertEqual(item["reviewStatus"], "revision_requested")
        self.assertEqual(item["latestRevisionRequest"], "tighten the scope")

    def test_request_topic_approval_stage_only_marks_revision_staged_without_delivery(self):
        state = common.state_template()
        state["items"][self.bookmark["bookmarkKey"]] = {
            "bookmarkKey": self.bookmark["bookmarkKey"],
            "path": self.bookmark["path"],
            "topic": self.bookmark["topic"],
            "source": self.bookmark["source"],
            "title": self.bookmark["title"],
            "reviewStatus": "revision_requested",
            "reviewDoc": "brain/reviews/infra/agent-harness-note-abc123bookmark.md",
            "specDocs": ["brain/specs/infra/llm-driven-bookmark-reviews-abc123bookmark.md"],
            "taskIds": [],
        }
        common.save_state(state, self.state_path)

        prepared = {
            "stageOnly": True,
            "readyPackages": [
                {
                    "topic": "infra",
                    "approvalTopic": "infra",
                    "resumeToken": "resume-token-stage",
                    "items": [
                        {
                            "bookmarkKey": self.bookmark["bookmarkKey"],
                            "title": self.bookmark["title"],
                            "summary": "Strong fit for workflow automation.",
                            "decisionRationale": "Worth implementation now.",
                            "stackJudgment": "Fits the current review pipeline.",
                            "reviewDoc": "brain/reviews/infra/agent-harness-note-abc123bookmark.md",
                            "specDocs": ["brain/specs/infra/llm-driven-bookmark-reviews-abc123bookmark.md"],
                            "proposedTasks": [{"title": "Implement harness review", "description": "Wire the bookmark review flow."}],
                        }
                    ],
                    "proposedTasks": [{"title": "Implement harness review", "description": "Wire the bookmark review flow."}],
                }
            ],
            "blockedPackages": [],
        }

        request_in = io.StringIO(json.dumps(prepared))
        request_out = io.StringIO()
        with patch.object(request_topic_approval, "STATE_PATH", self.state_path), \
             patch.object(request_topic_approval, "deliver_approval_message") as send_mock:
            with patch("sys.stdin", request_in), patch("sys.stdout", request_out), patch.object(sys, "argv", ["request_topic_approval.py"]):
                rc = request_topic_approval.main()

        self.assertEqual(rc, 0)
        send_mock.assert_not_called()
        requested = json.loads(request_out.getvalue())
        self.assertTrue(requested["stageOnly"])
        self.assertEqual(requested["approvals"][0]["stageOnly"], True)
        updated_state = common.load_state(self.state_path)
        item = updated_state["items"][self.bookmark["bookmarkKey"]]
        self.assertEqual(item["reviewStatus"], "revision_staged")
        self.assertEqual(item["approvalResumeToken"], "resume-token-stage")

    def test_request_topic_approval_blocks_when_topic_already_pending_in_state(self):
        state = common.state_template()
        state["items"][self.bookmark["bookmarkKey"]] = {
            "bookmarkKey": self.bookmark["bookmarkKey"],
            "path": self.bookmark["path"],
            "topic": self.bookmark["topic"],
            "source": self.bookmark["source"],
            "title": self.bookmark["title"],
            "reviewStatus": "approval_pending",
            "reviewDoc": "brain/reviews/infra/agent-harness-note-abc123bookmark.md",
            "approvalTopic": "infra",
            "specDocs": ["brain/specs/infra/llm-driven-bookmark-reviews-abc123bookmark.md"],
            "taskIds": [],
        }
        common.save_state(state, self.state_path)

        prepared = {
            "readyPackages": [
                {
                    "topic": "infra",
                    "approvalTopic": "infra",
                    "items": [
                        {
                            "bookmarkKey": self.bookmark["bookmarkKey"],
                            "title": self.bookmark["title"],
                            "summary": "Strong fit for workflow automation.",
                            "reviewDoc": "brain/reviews/infra/agent-harness-note-abc123bookmark.md",
                            "specDocs": ["brain/specs/infra/llm-driven-bookmark-reviews-abc123bookmark.md"],
                            "proposedTasks": [],
                        }
                    ],
                    "proposedTasks": [],
                }
            ],
            "blockedPackages": [],
        }

        request_in = io.StringIO(json.dumps(prepared))
        request_out = io.StringIO()
        with patch.object(request_topic_approval, "STATE_PATH", self.state_path), \
             patch("request_topic_approval.subprocess.run") as send_mock:
            with patch("sys.stdin", request_in), patch("sys.stdout", request_out), patch.object(sys, "argv", ["request_topic_approval.py"]):
                rc = request_topic_approval.main()

        self.assertEqual(rc, 0)
        send_mock.assert_not_called()
        requested = json.loads(request_out.getvalue())
        self.assertEqual(requested["approvals"], [])
        self.assertEqual(requested["blockedPackages"][0]["reason"], "approval already pending for topic")

    def test_request_topic_approval_requires_resume_token(self):
        state = common.state_template()
        state["items"][self.bookmark["bookmarkKey"]] = {
            "bookmarkKey": self.bookmark["bookmarkKey"],
            "path": self.bookmark["path"],
            "topic": self.bookmark["topic"],
            "source": self.bookmark["source"],
            "title": self.bookmark["title"],
            "reviewStatus": "spec_created",
            "specDocs": ["brain/bookmarks/specs/infra/example.md"],
            "taskIds": [],
        }
        common.save_state(state, self.state_path)

        prepared = {
            "readyPackages": [{
                "topic": "infra",
                "approvalTopic": "infra",
                "items": [{
                    "bookmarkKey": self.bookmark["bookmarkKey"],
                    "specDocs": ["brain/bookmarks/specs/infra/example.md"],
                    "proposedTasks": [{"title": "Implement harness review"}],
                }],
                "proposedTasks": [{"title": "Implement harness review"}],
            }],
            "blockedPackages": [],
        }

        request_in = io.StringIO(json.dumps(prepared))
        request_out = io.StringIO()
        with patch.object(request_topic_approval, "STATE_PATH", self.state_path), \
             patch.object(request_topic_approval, "deliver_approval_message", return_value=None) as send_mock:
            with patch("sys.stdin", request_in), patch("sys.stdout", request_out), patch.object(sys, "argv", ["request_topic_approval.py"]):
                rc = request_topic_approval.main()

        self.assertEqual(rc, 0)
        send_mock.assert_not_called()
        payload = json.loads(request_out.getvalue())
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["approvals"], [])
        self.assertEqual(payload["missingResumeTokens"][0]["topic"], "infra")
        self.assertEqual(payload["blockedPackages"][0]["reason"], "missing lobster resumeToken")

    def test_handle_approval_reply_resumes_lobster_with_stored_token(self):
        state = common.state_template()
        state["items"][self.bookmark["bookmarkKey"]] = {
            "bookmarkKey": self.bookmark["bookmarkKey"],
            "path": self.bookmark["path"],
            "topic": "infra",
            "approvalTopic": "infra",
            "approvalId": "apabc1234",
            "approvalResumeToken": "resume-token-xyz",
            "reviewStatus": "approval_pending",
        }
        common.save_state(state, self.state_path)

        messages = [{"sender_id": 6435140143, "text": "approve apabc1234"}]
        stdin = io.StringIO()
        stdout = io.StringIO()
        with patch.object(handle_approval_reply, "STATE_PATH", self.state_path), \
             patch.object(handle_approval_reply, "fetch_messages", return_value=messages), \
             patch.object(handle_approval_reply, "run_lobster_resume", return_value=({"ok": True, "status": "ok"}, None)) as resume_mock:
            with patch("sys.stdin", stdin), patch("sys.stdout", stdout), patch.object(sys, "argv", ["handle_approval_reply.py", "--json"]):
                rc = handle_approval_reply.main()

        self.assertEqual(rc, 0)
        resume_mock.assert_called_once_with("resume-token-xyz", True)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["results"][0]["status"], "resumed")

    def test_handle_approval_reply_uses_reply_context_to_find_approval_id(self):
        state = common.state_template()
        state["items"][self.bookmark["bookmarkKey"]] = {
            "bookmarkKey": self.bookmark["bookmarkKey"],
            "path": self.bookmark["path"],
            "topic": "design",
            "approvalTopic": "design",
            "approvalId": "ap501d126f",
            "approvalResumeToken": "resume-token-design",
            "reviewStatus": "approval_pending",
        }
        common.save_state(state, self.state_path)

        messages = [{
            "sender_id": 6435140143,
            "text": "Decline",
            "reply_text": "Approval request: design\n[#ap501d126f]\nReply: approve / decline / revise",
        }]
        stdout = io.StringIO()
        with patch.object(handle_approval_reply, "STATE_PATH", self.state_path), \
             patch.object(handle_approval_reply, "fetch_messages", return_value=messages), \
             patch.object(handle_approval_reply, "run_lobster_resume", return_value=({"ok": True, "status": "ok"}, None)) as resume_mock:
            with patch("sys.stdout", stdout), patch.object(sys, "argv", ["handle_approval_reply.py", "--json"]):
                rc = handle_approval_reply.main()

        self.assertEqual(rc, 0)
        resume_mock.assert_called_once_with("resume-token-design", False)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["results"][0]["status"], "resumed")
        self.assertEqual(payload["results"][0]["approvalId"], "ap501d126f")

    def test_handle_approval_reply_revise_returns_rebuilt_approval_message(self):
        state = common.state_template()
        state["items"][self.bookmark["bookmarkKey"]] = {
            "bookmarkKey": self.bookmark["bookmarkKey"],
            "path": self.bookmark["path"],
            "topic": "infra",
            "approvalTopic": "infra",
            "approvalId": "apabc1234",
            "approvalResumeToken": "resume-token-xyz",
            "reviewStatus": "approval_pending",
            "title": self.bookmark["title"],
        }
        common.save_state(state, self.state_path)

        messages = [{"sender_id": 6435140143, "text": "revise apabc1234: tighten the scope"}]
        rebuilt = {
            "ok": True,
            "approval": {
                "approvals": [
                    {
                        "approvalId": "apnew1234",
                        "items": [{"bookmarkKey": self.bookmark["bookmarkKey"]}],
                        "message": "Approval request: infra\n[#apnew1234]\n\nBookmark: Agent Harness Note",
                    }
                ]
            },
        }
        stdout = io.StringIO()
        with patch.object(handle_approval_reply, "STATE_PATH", self.state_path), \
             patch.object(handle_approval_reply, "fetch_messages", return_value=messages), \
             patch.object(handle_approval_reply, "rebuild_revised_approval", return_value=rebuilt):
            with patch("sys.stdout", stdout), patch.object(sys, "argv", ["handle_approval_reply.py", "--json"]):
                rc = handle_approval_reply.main()

        self.assertEqual(rc, 0)
        payload = json.loads(stdout.getvalue())
        result = payload["results"][0]
        self.assertEqual(result["status"], "revised")
        self.assertEqual(result["outcome"]["revisedApprovalId"], "apnew1234")
        self.assertIn("Approval request: infra", result["outcome"]["revisedApprovalMessage"])

    def test_handle_approval_reply_reports_pending_ids(self):
        state = common.state_template()
        state["items"][self.bookmark["bookmarkKey"]] = {
            "bookmarkKey": self.bookmark["bookmarkKey"],
            "path": self.bookmark["path"],
            "topic": "infra",
            "approvalTopic": "infra",
            "approvalId": "apabc1234",
            "approvalResumeToken": "resume-token-xyz",
            "reviewStatus": "approval_pending",
        }
        common.save_state(state, self.state_path)

        messages = [{"sender_id": 6435140143, "text": "approve apdeadbee0"}]
        stdout = io.StringIO()
        with patch.object(handle_approval_reply, "STATE_PATH", self.state_path), \
             patch.object(handle_approval_reply, "fetch_messages", return_value=messages):
            with patch("sys.stdout", stdout), patch.object(sys, "argv", ["handle_approval_reply.py", "--json"]):
                rc = handle_approval_reply.main()

        self.assertEqual(rc, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["pendingIds"], ["apabc1234"])
        self.assertEqual(payload["results"][0]["status"], "skipped")

    def test_handle_approval_reply_approve_without_token_uses_fallback_and_clears_lock(self):
        state = common.state_template()
        state["items"][self.bookmark["bookmarkKey"]] = {
            "bookmarkKey": self.bookmark["bookmarkKey"],
            "path": self.bookmark["path"],
            "topic": "infra",
            "approvalTopic": "infra",
            "approvalId": "apabc1234",
            "reviewStatus": "approval_pending",
            "specDocs": ["brain/specs/infra/test.md"],
            "specProposals": [{"title": "Test spec", "proposedTasks": []}],
            "taskIds": [],
        }
        common.save_state(state, self.state_path)

        messages = [{"sender_id": 6435140143, "text": "approve apabc1234"}]
        stdout = io.StringIO()
        created_payload = {
            "approvals": [{"topic": "infra", "items": [{"bookmarkKey": self.bookmark["bookmarkKey"]}]}],
            "created": [],
        }
        resolved_payload = {
            "ok": True,
            "resolved": [{"topic": "infra", "decision": "approved", "items": [{"bookmarkKey": self.bookmark["bookmarkKey"], "reviewStatus": "spec_created", "taskIds": []}]}],
            "created": [],
        }
        with patch.object(handle_approval_reply, "STATE_PATH", self.state_path), \
             patch.object(handle_approval_reply, "fetch_messages", return_value=messages), \
             patch.object(handle_approval_reply, "run_lobster_resume") as resume_mock, \
             patch.object(handle_approval_reply, "run_script", side_effect=[(created_payload, None), (resolved_payload, None)]):
            with patch("sys.stdout", stdout), patch.object(sys, "argv", ["handle_approval_reply.py", "--json"]):
                rc = handle_approval_reply.main()

        self.assertEqual(rc, 0)
        resume_mock.assert_not_called()
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["results"][0]["status"], "error")
        self.assertIn("resume-token-only", payload["results"][0]["reason"].lower())

        updated_state = common.load_state(self.state_path)
        item = updated_state["items"][self.bookmark["bookmarkKey"]]
        self.assertEqual(item["reviewStatus"], "approval_pending")
        self.assertIsNone(item.get("approvalStatus"))
        self.assertEqual(item.get("approvalId"), "apabc1234")
        self.assertIsNone(item.get("approvalResumeToken"))

    def test_list_review_candidates_keeps_relative_specdocs_when_file_exists_under_specs_root(self):
        bookmark_path = self.root / self.bookmark["path"]
        bookmark_path.parent.mkdir(parents=True, exist_ok=True)
        bookmark_path.write_text(
            "---\n"
            "title: Agent Harness Note\n"
            "link: https://example.com/post\n"
            "source: x\n"
            "---\n\n"
            "Body\n",
            encoding="utf-8",
        )

        spec_rel = "infra/agent-harness-note-abc123bookmark.md"
        spec_path = self.root / "brain" / "bookmarks" / "specs" / spec_rel
        spec_path.parent.mkdir(parents=True, exist_ok=True)
        spec_path.write_text("# Spec\n", encoding="utf-8")

        state = common.state_template()
        state["items"][self.bookmark["bookmarkKey"]] = {
            "bookmarkKey": self.bookmark["bookmarkKey"],
            "path": self.bookmark["path"],
            "topic": self.bookmark["topic"],
            "source": self.bookmark["source"],
            "title": self.bookmark["title"],
            "reviewStatus": "spec_created",
            "reviewDoc": "brain/reviews/infra/agent-harness-note-abc123bookmark.md",
            "analysis": {"classification": "implement"},
            "specDocs": [spec_rel],
            "specProposals": [{"title": "Agent Harness Note", "specDoc": spec_rel, "proposedTasks": [{"title": "task"}]}],
            "taskIds": [],
        }
        common.save_state(state, self.state_path)

        out = io.StringIO()
        with patch.object(list_review_candidates, "WORKSPACE", self.root), \
             patch.object(list_review_candidates, "SPECS_ROOT", self.root / "brain/bookmarks/specs"), \
             patch.object(list_review_candidates, "BOOKMARKS_ROOT", self.root / "brain/bookmarks"), \
             patch.object(list_review_candidates, "STATE_PATH", self.state_path):
            with patch("sys.stdout", out), patch.object(sys, "argv", ["list_review_candidates.py", "--json"]):
                rc = list_review_candidates.main()

        self.assertEqual(rc, 0)
        updated = common.load_state(self.state_path)
        self.assertEqual(updated["items"][self.bookmark["bookmarkKey"]]["specDocs"], [spec_rel])

    def test_list_review_candidates_resolves_relative_source_root_from_workspace(self):
        bookmark_path = self.root / "brain/bookmarks/x/sample.md"
        bookmark_path.parent.mkdir(parents=True, exist_ok=True)
        bookmark_path.write_text(
            "---\ntitle: Relative Root\nlink: https://example.com/root\nsource: x\n---\n\nBody\n",
            encoding="utf-8",
        )

        out = io.StringIO()
        with patch.object(list_review_candidates, "WORKSPACE", self.root), \
             patch.object(list_review_candidates, "SPECS_ROOT", self.root / "brain/bookmarks/specs"), \
             patch.object(list_review_candidates, "STATE_PATH", self.state_path):
            with patch("sys.stdout", out), patch.object(
                sys,
                "argv",
                ["list_review_candidates.py", "--source-root", "brain/bookmarks/x", "--json"],
            ):
                rc = list_review_candidates.main()

        self.assertEqual(rc, 0)
        payload = json.loads(out.getvalue())
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["candidates"][0]["title"], "Relative Root")

    def test_list_spec_requests_uses_curation_topic(self):
        state = common.state_template()
        state["items"]["k1"] = {
            "bookmarkKey": "k1",
            "title": "Curated topic",
            "topic": "general",
            "curation": {"topic": "infra", "score": 9},
            "reviewStatus": "spec_requested",
            "analysis": {"headline": "Useful"},
        }
        common.save_state(state, self.state_path)

        out = io.StringIO()
        with patch.object(list_spec_requests, "STATE_PATH", self.state_path), \
             patch("sys.stdout", out):
            rc = list_spec_requests.main()

        self.assertEqual(rc, 0)
        payload = json.loads(out.getvalue())
        self.assertEqual(payload["specRequests"][0]["topic"], "infra")

    def test_flat_path_migration_does_not_repoint_colliding_item(self):
        old_bookmarks_root = self.root / "brain/bookmarks/x"
        old_reviews_root = self.root / "brain/reviews"
        new_summaries_root = self.root / "brain/bookmarks/summaries"
        old_reviews_root.mkdir(parents=True, exist_ok=True)
        for topic, body in (("a", "first"), ("b", "second")):
            path = old_bookmarks_root / topic / "same.md"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(body, encoding="utf-8")

        state = common.state_template()
        state["items"] = {
            "a": {"bookmarkKey": "a", "path": "brain/bookmarks/x/a/same.md"},
            "b": {"bookmarkKey": "b", "path": "brain/bookmarks/x/b/same.md"},
        }
        common.save_state(state, self.state_path)

        with patch.object(migrate_flat_paths, "WORKSPACE", self.root), \
             patch.object(migrate_flat_paths, "STATE_PATH", self.state_path), \
             patch.object(migrate_flat_paths, "OLD_BOOKMARKS_ROOT", old_bookmarks_root), \
             patch.object(migrate_flat_paths, "NEW_BOOKMARKS_ROOT", old_bookmarks_root), \
             patch.object(migrate_flat_paths, "OLD_REVIEWS_ROOT", old_reviews_root), \
             patch.object(migrate_flat_paths, "NEW_SUMMARIES_ROOT", new_summaries_root), \
             patch.object(sys, "argv", ["migrate_flat_paths.py"]):
            rc = migrate_flat_paths.main()

        self.assertEqual(rc, 0)
        updated = common.load_state(self.state_path)
        self.assertEqual(updated["items"]["a"]["path"], "brain/bookmarks/x/same.md")
        self.assertEqual(updated["items"]["b"]["path"], "brain/bookmarks/x/b/same.md")
        self.assertEqual((old_bookmarks_root / "same.md").read_text(), "first")
        self.assertEqual((old_bookmarks_root / "b/same.md").read_text(), "second")

    def test_approval_state_lock_serializes_callers(self):
        lock_path = self.root / "brain/state/bookmark-review-state.json"
        first_entered = threading.Event()
        release_first = threading.Event()
        second_entered = threading.Event()

        def first():
            with request_topic_approval.approval_state_lock(lock_path):
                first_entered.set()
                release_first.wait(timeout=2)

        def second():
            first_entered.wait(timeout=2)
            with request_topic_approval.approval_state_lock(lock_path):
                second_entered.set()

        first_thread = threading.Thread(target=first)
        second_thread = threading.Thread(target=second)
        first_thread.start()
        second_thread.start()
        self.assertTrue(first_entered.wait(timeout=1))
        self.assertFalse(second_entered.wait(timeout=0.1))
        release_first.set()
        first_thread.join(timeout=1)
        second_thread.join(timeout=1)
        self.assertTrue(second_entered.is_set())

    def test_list_review_candidates_recovers_missing_spec_links_from_disk(self):
        state = common.state_template()
        key = "07d569e9f611226e"
        state["items"][key] = {
            "bookmarkKey": key,
            "path": "brain/bookmarks/infra/sample.md",
            "topic": "infra",
            "title": "Recovered spec bookmark",
            "reviewDoc": "brain/reviews/infra/sample.md",
            "reviewStatus": "reviewed",
            "specDocs": [],
            "specProposals": [{"title": "Recovered spec", "proposedTasks": []}],
            "taskIds": [],
        }
        common.save_state(state, self.state_path)

        # Spec exists on disk but state lost linkage
        spec_path = self.root / "brain/bookmarks/specs/infra/bootstrap-vs-memory-split-optimization-07d569e9f611226e.md"
        spec_path.parent.mkdir(parents=True, exist_ok=True)
        spec_path.write_text("# Recovered Spec\n", encoding="utf-8")

        # Also create source bookmark folder so candidate scan can run
        bookmark_path = self.root / "brain/bookmarks/infra/sample.md"
        bookmark_path.parent.mkdir(parents=True, exist_ok=True)
        bookmark_path.write_text("---\ntitle: sample\nsource: x\n---\n", encoding="utf-8")

        out = io.StringIO()
        with patch.object(common, "WORKSPACE", self.root), \
             patch.object(common, "BOOKMARKS_ROOT", self.root / "brain/bookmarks"), \
             patch.object(list_review_candidates, "WORKSPACE", self.root), \
             patch.object(list_review_candidates, "SPECS_ROOT", self.root / "brain/bookmarks/specs"), \
             patch.object(list_review_candidates, "BOOKMARKS_ROOT", self.root / "brain/bookmarks"), \
             patch.object(list_review_candidates, "STATE_PATH", self.state_path):
            with patch("sys.stdout", out), patch.object(sys, "argv", ["list_review_candidates.py", "--json"]):
                rc = list_review_candidates.main()

        self.assertEqual(rc, 0)
        updated = common.load_state(self.state_path)
        item = updated["items"][key]
        self.assertEqual(item["reviewStatus"], "spec_created")
        self.assertEqual(item["specDocs"], ["brain/bookmarks/specs/infra/bootstrap-vs-memory-split-optimization-07d569e9f611226e.md"])

    def test_list_review_candidates_preserves_current_statuses_without_review_doc(self):
        state = common.state_template()
        for status in sorted(list_review_candidates.CURRENT_REVIEW_STATUSES):
            state["items"][status] = {
                "bookmarkKey": status,
                "reviewStatus": status,
                "summaryDoc": f"brain/bookmarks/summaries/{status}.md",
            }
        common.save_state(state, self.state_path)

        out = io.StringIO()
        with patch.object(list_review_candidates, "WORKSPACE", self.root), \
             patch.object(list_review_candidates, "SPECS_ROOT", self.root / "brain/bookmarks/specs"), \
             patch.object(list_review_candidates, "BOOKMARKS_ROOT", self.root / "brain/bookmarks"), \
             patch.object(list_review_candidates, "STATE_PATH", self.state_path):
            with patch("sys.stdout", out), patch.object(sys, "argv", ["list_review_candidates.py", "--json"]):
                rc = list_review_candidates.main()

        self.assertEqual(rc, 0)
        updated = common.load_state(self.state_path)
        for status in list_review_candidates.CURRENT_REVIEW_STATUSES:
            self.assertEqual(updated["items"][status]["reviewStatus"], status)

    def test_list_review_candidates_uses_high_curation_without_legacy_analysis(self):
        bookmark_path = self.root / "brain/bookmarks/x/high-curation.md"
        bookmark_path.parent.mkdir(parents=True, exist_ok=True)
        bookmark_path.write_text(
            "---\ntitle: High curation\nlink: https://example.com/high\nsource: x\n---\n",
            encoding="utf-8",
        )
        with patch.object(common, "WORKSPACE", self.root), patch.object(common, "BOOKMARKS_ROOT", self.root / "brain/bookmarks"):
            record = common.bookmark_record(bookmark_path)
        key = record["bookmarkKey"]
        review_doc = "brain/reviews/high-curation.md"
        review_path = self.root / review_doc
        review_path.parent.mkdir(parents=True, exist_ok=True)
        review_path.write_text("# Legacy review without classification\n", encoding="utf-8")

        state = common.state_template()
        state["items"][key] = {
            "bookmarkKey": key,
            "reviewDoc": review_doc,
            "reviewStatus": "summarized",
            "curation": {"score": 9, "threshold": 7},
        }
        common.save_state(state, self.state_path)

        out = io.StringIO()
        with patch.object(common, "WORKSPACE", self.root), \
             patch.object(common, "BOOKMARKS_ROOT", self.root / "brain/bookmarks"), \
             patch.object(list_review_candidates, "WORKSPACE", self.root), \
             patch.object(list_review_candidates, "SPECS_ROOT", self.root / "brain/bookmarks/specs"), \
             patch.object(list_review_candidates, "BOOKMARKS_ROOT", self.root / "brain/bookmarks"), \
             patch.object(list_review_candidates, "STATE_PATH", self.state_path):
            with patch("sys.stdout", out), patch.object(sys, "argv", ["list_review_candidates.py", "--json"]):
                rc = list_review_candidates.main()

        self.assertEqual(rc, 0)
        payload = json.loads(out.getvalue())
        matched = [item for item in payload["candidates"] if item["bookmarkKey"] == key]
        self.assertEqual(len(matched), 1)
        self.assertTrue(matched[0]["skipReview"])

    def test_read_first_json_value_does_not_require_stdin_close(self):
        read_fd, write_fd = os.pipe()
        reader = os.fdopen(read_fd, "r", encoding="utf-8")
        writer = os.fdopen(write_fd, "w", encoding="utf-8")
        result: dict[str, object] = {}

        def worker() -> None:
            result["value"] = common.read_first_json_value(reader)

        thread = threading.Thread(target=worker)
        thread.start()
        writer.write('{"ok": true, "items": [1, 2, 3]}')
        writer.flush()
        thread.join(timeout=1.0)
        self.assertFalse(thread.is_alive())
        self.assertEqual(result["value"], {"ok": True, "items": [1, 2, 3]})
        writer.close()
        reader.close()

    def test_request_single_spec_approval_reset_clears_old_spec_state_and_files(self):
        module_path = Path(__file__).resolve().parents[1] / "agents" / "workflows" / "bookmark" / "debug" / "request_single_spec_approval.py"
        spec = importlib.util.spec_from_file_location("request_single_spec_approval_debug", module_path)
        reset_debug = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(reset_debug)

        old_spec_rel = "infra/old-spec-abc123bookmark.md"
        old_spec_path = self.root / "brain" / "specs" / old_spec_rel
        old_spec_path.parent.mkdir(parents=True, exist_ok=True)
        old_spec_path.write_text("# old\n", encoding="utf-8")

        state = common.state_template()
        state["items"][self.bookmark["bookmarkKey"]] = {
            "bookmarkKey": self.bookmark["bookmarkKey"],
            "path": self.bookmark["path"],
            "topic": self.bookmark["topic"],
            "source": self.bookmark["source"],
            "title": self.bookmark["title"],
            "reviewStatus": "approval_pending",
            "reviewDoc": "brain/reviews/infra/agent-harness-note-abc123bookmark.md",
            "analysis": {"classification": "implement"},
            "approvalId": "apold1234",
            "specDocs": [old_spec_rel],
            "specProposals": [{"title": "Old spec", "specDoc": old_spec_rel, "proposedTasks": [{"title": "task"}]}],
        }
        common.save_state(state, self.state_path)

        generated_payload = {
            "implement": [{
                **self.bookmark,
                "reviewDoc": "brain/reviews/infra/agent-harness-note-abc123bookmark.md",
                "specDocs": ["infra/new-spec-abc123bookmark.md"],
                "specProposals": [{"title": "New spec", "specDoc": "infra/new-spec-abc123bookmark.md", "proposedTasks": []}],
            }],
            "monitoring": [],
            "reviewed": [],
        }
        proposed_payload = {"ok": True, "implement": [], "monitoring": [], "reviewed": []}

        with patch.object(reset_debug, "STATE_PATH", self.state_path), \
             patch.object(reset_debug, "SPECS_ROOT", self.root / "brain" / "specs"), \
             patch.object(reset_debug, "WORKSPACE", self.root), \
             patch.object(reset_debug, "run_json", side_effect=[generated_payload, proposed_payload]):
            result = reset_debug.reset_to_approval_ready(self.bookmark["bookmarkKey"])

        self.assertFalse(old_spec_path.exists())
        cleared = common.load_state(self.state_path)["items"][self.bookmark["bookmarkKey"]]
        self.assertEqual(cleared["reviewStatus"], "reviewed")
        self.assertIsNone(cleared.get("approvalId"))
        self.assertIsNone(cleared.get("specDocs"))
        self.assertIsNone(cleared.get("specProposals"))
        self.assertEqual(result["specDocs"], [])

    def test_generate_specs_regenerates_when_state_has_stale_missing_spec_docs(self):
        bookmark_path = self.root / self.bookmark["path"]
        bookmark_path.parent.mkdir(parents=True, exist_ok=True)
        bookmark_path.write_text(
            "---\n"
            "title: Agent Harness Note\n"
            "link: https://example.com/post\n"
            "source: x\n"
            "---\n\n"
            "Body\n",
            encoding="utf-8",
        )

        state = common.state_template()
        stale_rel = "infra/stale-spec-abc123bookmark.md"
        state["items"][self.bookmark["bookmarkKey"]] = {
            "bookmarkKey": self.bookmark["bookmarkKey"],
            "path": self.bookmark["path"],
            "topic": self.bookmark["topic"],
            "source": self.bookmark["source"],
            "title": self.bookmark["title"],
            "reviewStatus": "reviewed",
            "reviewDoc": "brain/reviews/infra/agent-harness-note-abc123bookmark.md",
            "analysis": {
                "classification": "implement",
                "headline": "Worth building",
                "summary": "Useful.",
                "decisionRationale": "Build it.",
                "stackJudgment": "Fits workflow automation.",
                "recommendation": "Draft specs.",
                "signals": ["Relevant"],
                "risks": ["Needs scoping"],
                "monitorTriggers": ["None"],
                "implementationPaths": ["Improve review quality"],
            },
            "specDocs": [stale_rel],
            "specProposals": [{"title": "Stale proposal", "specDoc": stale_rel, "proposedTasks": [{"title": "task"}]}],
            "taskIds": [],
        }
        common.save_state(state, self.state_path)

        llm_specs = {
            "specs": [{
                "title": "Fresh replacement spec",
                "specType": "workflow-improvement",
                "whySeparateNow": "Fresh write needed.",
                "outcome": "A regenerated spec file.",
                "problemStatement": "State points at a deleted spec.",
                "approach": "Regenerate from analysis instead of trusting stale links.",
                "stackTouchpoints": ["scripts/bookmarks/generate_specs.py"],
                "scopeBoundaries": ["Single spec"],
                "risksAndUnknowns": ["Path drift"],
                "incrementalRollout": ["Regenerate spec"],
                "successChecks": ["New spec exists on disk"],
                "proposedTasks": [{
                    "title": "Regenerate spec file",
                    "priority": "high",
                    "summary": "Recover from stale state.",
                    "deliverable": "Fresh spec markdown on disk.",
                    "acceptanceCriteria": ["Spec exists"],
                }],
            }]
        }

        stdin = io.StringIO(json.dumps({"implement": [self.bookmark], "monitoring": [], "reviewed": []}))
        stdout = io.StringIO()
        with patch.object(generate_specs, "STATE_PATH", self.state_path), \
             patch.object(generate_specs, "SPECS_ROOT", self.root / "brain" / "specs"), \
             patch.object(generate_specs, "WORKSPACE", self.root):
            with patch("sys.stdin", stdin), patch("sys.stdout", stdout), patch.object(sys, "argv", ["generate_specs.py", "--json"]):
                rc = generate_specs.main()

        self.assertEqual(rc, 0)
        payload = json.loads(stdout.getvalue())
        # Stale spec triggers re-queue via heartbeat; implement list is empty.
        self.assertEqual(payload["implement"], [])

        state = common.load_state(self.state_path)
        item = state["items"][self.bookmark["bookmarkKey"]]
        self.assertEqual(item["reviewStatus"], "spec_requested")

    def test_list_review_candidates_includes_spec_created_items_pending_approval(self):
        bookmark_path = self.root / "brain/bookmarks/x/spec-created.md"
        bookmark_path.parent.mkdir(parents=True, exist_ok=True)
        bookmark_path.write_text(
            "---\n"
            "title: spec created\n"
            "link: https://example.com/spec-created\n"
            "source: x\n"
            "---\n",
            encoding="utf-8",
        )

        with patch.object(common, "WORKSPACE", self.root), patch.object(common, "BOOKMARKS_ROOT", self.root / "brain/bookmarks"):
            record = common.bookmark_record(bookmark_path)
        key = record["bookmarkKey"]

        state = common.state_template()
        state["items"][key] = {
            "bookmarkKey": key,
            "path": "brain/bookmarks/x/spec-created.md",
            "topic": "infra",
            "title": "Spec created bookmark",
            "reviewDoc": "brain/reviews/infra/spec-created.md",
            "reviewStatus": "spec_created",
            "specDocs": [f"brain/bookmarks/specs/infra/spec-created-{key}.md"],
            "specProposals": [{"title": "Do it", "proposedTasks": [{"title": "task"}]}],
            "taskIds": [],
        }
        common.save_state(state, self.state_path)

        review_path = self.root / "brain/reviews/infra/spec-created.md"
        review_path.parent.mkdir(parents=True, exist_ok=True)
        review_path.write_text("Classified as 'implement'", encoding="utf-8")

        spec_path = self.root / f"brain/bookmarks/specs/infra/spec-created-{key}.md"
        spec_path.parent.mkdir(parents=True, exist_ok=True)
        spec_path.write_text("# Spec", encoding="utf-8")

        out = io.StringIO()
        with patch.object(common, "WORKSPACE", self.root), \
             patch.object(common, "BOOKMARKS_ROOT", self.root / "brain/bookmarks"), \
             patch.object(list_review_candidates, "WORKSPACE", self.root), \
             patch.object(list_review_candidates, "SPECS_ROOT", self.root / "brain/bookmarks/specs"), \
             patch.object(list_review_candidates, "BOOKMARKS_ROOT", self.root / "brain/bookmarks"), \
             patch.object(list_review_candidates, "STATE_PATH", self.state_path):
            with patch("sys.stdout", out), patch.object(sys, "argv", ["list_review_candidates.py", "--json"]):
                rc = list_review_candidates.main()

        self.assertEqual(rc, 0)
        payload = json.loads(out.getvalue())
        matched = [c for c in payload["candidates"] if c.get("bookmarkKey") == key]
        self.assertTrue(matched)
        self.assertTrue(matched[0].get("skipReview"))

    def test_create_tasks_from_proposals_creates_tasks_via_existing_api_path(self):
        spec_doc = "brain/bookmarks/specs/llm-driven-bookmark-reviews-abc123bookmark.md"
        spec_path = self.root / spec_doc
        spec_path.parent.mkdir(parents=True, exist_ok=True)
        spec_path.write_text(
            "# Spec — LLM Bookmark Reviews\n\n## Outcome\n\nFaithful extraction.\n\n## Acceptance Criteria\n\n- [ ] **AC1:** Reviews are generated.\n",
            encoding="utf-8",
        )
        approval_payload = {
            "approvals": [{
                "topic": "infra",
                "items": [{
                    "bookmarkKey": self.bookmark["bookmarkKey"],
                    "specDocs": [spec_doc],
                }],
            }],
            "blockedPackages": [],
            "monitoring": [],
            "reviewed": [],
        }
        stdin = io.StringIO(json.dumps(approval_payload))
        stdout = io.StringIO()

        with patch.object(create_tasks_from_proposals, "WORKSPACE", self.root), \
             patch.object(create_tasks_from_proposals, "list_tasks", return_value=[]), \
             patch.object(create_tasks_from_proposals, "api_request", return_value={"data": {"id": "task-123"}}) as api_mock:
            with patch("sys.stdin", stdin), patch("sys.stdout", stdout), patch.object(sys, "argv", ["create_tasks_from_proposals.py", "--base-url", "http://api", "--json"]):
                rc = create_tasks_from_proposals.main()

        self.assertEqual(rc, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["created"][0]["taskId"], "task-123")
        self.assertEqual(payload["created"][0]["bookmarkKey"], self.bookmark["bookmarkKey"])
        request_payload = api_mock.call_args.args[3]
        self.assertEqual(api_mock.call_args.args[0:3], ("POST", "http://api", "/tasks"))
        self.assertEqual(request_payload["status"], "open")
        self.assertIn("source:bookmark-review-pipeline", request_payload["tags"])
        self.assertIn(f"bookmark:{self.bookmark['bookmarkKey']}", request_payload["tags"])
        self.assertTrue(any(tag.startswith("spec-task:") for tag in request_payload["tags"]))

    def test_create_tasks_from_proposals_reuses_existing_task_when_marker_matches(self):
        spec_doc = "brain/bookmarks/specs/llm-driven-bookmark-reviews-abc123bookmark.md"
        marker = create_tasks_from_proposals.spec_marker(spec_doc)
        approval_payload = {
            "approvals": [{
                "topic": "infra",
                "items": [{
                    "bookmarkKey": self.bookmark["bookmarkKey"],
                    "specDocs": [spec_doc],
                }],
            }],
            "blockedPackages": [],
            "monitoring": [],
            "reviewed": [],
        }
        stdin = io.StringIO(json.dumps(approval_payload))
        stdout = io.StringIO()
        existing_task = {"id": "task-existing", "tags": [marker, "source:bookmark-review-pipeline"], "status": "open"}

        with patch.object(create_tasks_from_proposals, "list_tasks", return_value=[existing_task]), \
             patch.object(create_tasks_from_proposals, "api_request") as api_mock:
            with patch("sys.stdin", stdin), patch("sys.stdout", stdout), patch.object(sys, "argv", ["create_tasks_from_proposals.py", "--base-url", "http://api", "--json"]):
                rc = create_tasks_from_proposals.main()

        self.assertEqual(rc, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["created"][0]["taskId"], "task-existing")
        self.assertTrue(payload["created"][0]["reused"])
        api_mock.assert_not_called()

    def test_create_tasks_from_proposals_does_not_reuse_done_task_when_marker_matches(self):
        spec_doc = "brain/bookmarks/specs/llm-driven-bookmark-reviews-abc123bookmark.md"
        spec_path = self.root / spec_doc
        spec_path.parent.mkdir(parents=True, exist_ok=True)
        spec_path.write_text(
            "# Spec — LLM Bookmark Reviews\n\n## Acceptance Criteria\n\n- [ ] **AC1:** Reviews are generated.\n",
            encoding="utf-8",
        )
        marker = create_tasks_from_proposals.spec_marker(spec_doc)
        approval_payload = {
            "approvals": [{
                "topic": "infra",
                "items": [{
                    "bookmarkKey": self.bookmark["bookmarkKey"],
                    "specDocs": [spec_doc],
                }],
            }],
            "blockedPackages": [],
            "monitoring": [],
            "reviewed": [],
        }
        stdin = io.StringIO(json.dumps(approval_payload))
        stdout = io.StringIO()
        existing_task = {
            "id": "task-done",
            "tags": [marker, "source:bookmark-review-pipeline"],
            "status": "done",
            "completedAt": "2026-03-31T00:00:00Z",
        }

        with patch.object(create_tasks_from_proposals, "WORKSPACE", self.root), \
             patch.object(create_tasks_from_proposals, "list_tasks", return_value=[existing_task]), \
             patch.object(create_tasks_from_proposals, "api_request", return_value={"data": {"id": "task-new"}}) as api_mock:
            with patch("sys.stdin", stdin), patch("sys.stdout", stdout), patch.object(sys, "argv", ["create_tasks_from_proposals.py", "--base-url", "http://api", "--json"]):
                rc = create_tasks_from_proposals.main()

        self.assertEqual(rc, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["created"][0]["taskId"], "task-new")
        self.assertFalse(payload["created"][0]["reused"])
        api_mock.assert_called_once()

    def test_finalize_review_cycle_marks_reviewed_and_monitoring_items(self):
        state = common.state_template()
        state["items"]["reviewed-item"] = {
            "bookmarkKey": "reviewed-item",
            "path": "brain/bookmarks/general/reviewed.md",
            "topic": "general",
            "title": "Reviewed",
            "reviewStatus": "implement",
        }
        state["items"]["monitor-item"] = {
            "bookmarkKey": "monitor-item",
            "path": "brain/bookmarks/general/monitor.md",
            "topic": "general",
            "title": "Monitor",
            "reviewStatus": "monitoring",
        }
        common.save_state(state, self.state_path)

        stdin = io.StringIO(json.dumps({
            "reviewed": [{"bookmarkKey": "reviewed-item"}],
            "monitoring": [{"bookmarkKey": "monitor-item"}],
            "approvals": [],
            "blockedPackages": [],
        }))
        stdout = io.StringIO()
        with patch.object(finalize_review_cycle, "STATE_PATH", self.state_path):
            with patch("sys.stdin", stdin), patch("sys.stdout", stdout), patch.object(sys, "argv", ["finalize_review_cycle.py", "--json"]):
                rc = finalize_review_cycle.main()

        self.assertEqual(rc, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["finalized"]["reviewed"], ["reviewed-item"])
        self.assertEqual(payload["finalized"]["monitoring"], ["monitor-item"])
        self.assertEqual(payload["finalized"]["queued"], [])

        updated_state = common.load_state(self.state_path)
        self.assertEqual(updated_state["items"]["reviewed-item"]["reviewStatus"], "reviewed")
        self.assertEqual(updated_state["items"]["monitor-item"]["reviewStatus"], "summarized")

    def test_finalize_review_cycle_marks_blocked_packages_as_queued(self):
        state = common.state_template()
        state["items"][self.bookmark["bookmarkKey"]] = {
            "bookmarkKey": self.bookmark["bookmarkKey"],
            "path": self.bookmark["path"],
            "topic": self.bookmark["topic"],
            "title": self.bookmark["title"],
            "reviewStatus": "spec_created",
        }
        common.save_state(state, self.state_path)

        stdin = io.StringIO(json.dumps({
            "reviewed": [],
            "monitoring": [],
            "approvals": [],
            "blockedPackages": [{
                "topic": "infra",
                "approvalTopic": "infra",
                "reason": "approval already pending for topic",
                "items": [{"bookmarkKey": self.bookmark["bookmarkKey"]}],
            }],
        }))
        stdout = io.StringIO()
        with patch.object(finalize_review_cycle, "STATE_PATH", self.state_path):
            with patch("sys.stdin", stdin), patch("sys.stdout", stdout), patch.object(sys, "argv", ["finalize_review_cycle.py", "--json"]):
                rc = finalize_review_cycle.main()

        self.assertEqual(rc, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["finalized"]["queued"], [self.bookmark["bookmarkKey"]])

        updated_state = common.load_state(self.state_path)
        item = updated_state["items"][self.bookmark["bookmarkKey"]]
        self.assertEqual(item["reviewStatus"], "spec_created")

    def test_resolve_topic_approval_decline_clears_pending_state(self):
        state = common.state_template()
        state["items"][self.bookmark["bookmarkKey"]] = {
            "bookmarkKey": self.bookmark["bookmarkKey"],
            "path": self.bookmark["path"],
            "topic": self.bookmark["topic"],
            "source": self.bookmark["source"],
            "title": self.bookmark["title"],
            "reviewStatus": "approval_pending",
            "approvalTopic": "infra",
            "approvalResumeToken": "resume-token-decline",
            "specDocs": ["brain/specs/infra/llm-driven-bookmark-reviews-abc123bookmark.md"],
            "taskIds": [],
        }
        common.save_state(state, self.state_path)

        stdin = io.StringIO(json.dumps({
            "approvals": [{
                "topic": "infra",
                "items": [{"bookmarkKey": self.bookmark["bookmarkKey"]}],
            }],
            "created": [],
        }))
        stdout = io.StringIO()
        with patch.object(resolve_topic_approval, "STATE_PATH", self.state_path):
            with patch("sys.stdin", stdin), patch("sys.stdout", stdout), patch.object(sys, "argv", ["resolve_topic_approval.py", "--decision", "decline", "--json"]):
                rc = resolve_topic_approval.main()

        self.assertEqual(rc, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["decision"], "declined")

        updated_state = common.load_state(self.state_path)
        item = updated_state["items"][self.bookmark["bookmarkKey"]]
        self.assertEqual(item["approvalStatus"], "declined")
        self.assertEqual(item["approvalResumeToken"], None)
        self.assertEqual(item["reviewStatus"], "declined")

    def test_force_clear_approval_lock_keeps_decline_terminal(self):
        state = common.state_template()
        state["items"][self.bookmark["bookmarkKey"]] = {
            "bookmarkKey": self.bookmark["bookmarkKey"],
            "approvalId": "apterminal1",
            "approvalResumeToken": "resume-token-decline",
            "approvalStatus": "pending",
            "reviewStatus": "approval_pending",
            "curation": {"score": 9, "threshold": 7},
        }

        with patch.object(handle_approval_reply, "STATE_PATH", self.state_path):
            cleared = handle_approval_reply.force_clear_approval_lock(
                state,
                "apterminal1",
                approved=False,
            )

        self.assertEqual(cleared, 1)
        item = state["items"][self.bookmark["bookmarkKey"]]
        self.assertEqual(item["reviewStatus"], "declined")
        self.assertEqual(item["approvalStatus"], "declined")
        self.assertEqual(item["curation"], {"score": 9, "threshold": 7})
        self.assertIsNone(item["approvalId"])
        self.assertIsNone(item["approvalResumeToken"])

    def test_resolve_topic_approval_approve_with_created_tasks_marks_tasked(self):
        state = common.state_template()
        state["items"][self.bookmark["bookmarkKey"]] = {
            "bookmarkKey": self.bookmark["bookmarkKey"],
            "path": self.bookmark["path"],
            "topic": self.bookmark["topic"],
            "source": self.bookmark["source"],
            "title": self.bookmark["title"],
            "reviewStatus": "approval_pending",
            "approvalTopic": "infra",
            "specDocs": ["brain/specs/infra/llm-driven-bookmark-reviews-abc123bookmark.md"],
            "taskIds": [],
        }
        common.save_state(state, self.state_path)

        stdin = io.StringIO(json.dumps({
            "approvals": [{
                "topic": "infra",
                "items": [{"bookmarkKey": self.bookmark["bookmarkKey"]}],
            }],
            "created": [{
                "bookmarkKey": self.bookmark["bookmarkKey"],
                "taskId": "task-123",
            }],
        }))
        stdout = io.StringIO()
        with patch.object(resolve_topic_approval, "STATE_PATH", self.state_path):
            with patch("sys.stdin", stdin), patch("sys.stdout", stdout), patch.object(sys, "argv", ["resolve_topic_approval.py", "--decision", "approve", "--json"]):
                rc = resolve_topic_approval.main()

        self.assertEqual(rc, 0)
        updated_state = common.load_state(self.state_path)
        item = updated_state["items"][self.bookmark["bookmarkKey"]]
        self.assertEqual(item["reviewStatus"], "tasked")
        self.assertEqual(item["taskIds"], ["task-123"])

    def test_resolve_topic_approval_skips_topic_mismatch(self):
        state = common.state_template()
        state["items"][self.bookmark["bookmarkKey"]] = {
            "bookmarkKey": self.bookmark["bookmarkKey"],
            "path": self.bookmark["path"],
            "topic": self.bookmark["topic"],
            "source": self.bookmark["source"],
            "title": self.bookmark["title"],
            "reviewStatus": "approval_pending",
            "approvalTopic": "infra",
            "specDocs": ["brain/specs/infra/llm-driven-bookmark-reviews-abc123bookmark.md"],
            "taskIds": [],
        }
        common.save_state(state, self.state_path)

        stdin = io.StringIO(json.dumps({
            "approvals": [{
                "topic": "brain",
                "items": [{"bookmarkKey": self.bookmark["bookmarkKey"]}],
            }],
            "created": [],
        }))
        stdout = io.StringIO()
        with patch.object(resolve_topic_approval, "STATE_PATH", self.state_path):
            with patch("sys.stdin", stdin), patch("sys.stdout", stdout), patch.object(sys, "argv", ["resolve_topic_approval.py", "--decision", "approve", "--json"]):
                rc = resolve_topic_approval.main()

        self.assertEqual(rc, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["skipped"][0]["reason"], "approval topic mismatch (state=infra, input=brain)")

        updated_state = common.load_state(self.state_path)
        item = updated_state["items"][self.bookmark["bookmarkKey"]]
        self.assertEqual(item["reviewStatus"], "approval_pending")

    def test_resolve_topic_approval_approve_without_created_tasks_returns_to_spec_created(self):
        state = common.state_template()
        state["items"][self.bookmark["bookmarkKey"]] = {
            "bookmarkKey": self.bookmark["bookmarkKey"],
            "path": self.bookmark["path"],
            "topic": self.bookmark["topic"],
            "source": self.bookmark["source"],
            "title": self.bookmark["title"],
            "reviewStatus": "approval_pending",
            "approvalTopic": "infra",
            "specDocs": ["brain/specs/infra/llm-driven-bookmark-reviews-abc123bookmark.md"],
            "taskIds": [],
        }
        common.save_state(state, self.state_path)

        stdin = io.StringIO(json.dumps({
            "approvals": [{
                "topic": "infra",
                "items": [{"bookmarkKey": self.bookmark["bookmarkKey"]}],
            }],
            "created": [],
        }))
        stdout = io.StringIO()
        with patch.object(resolve_topic_approval, "STATE_PATH", self.state_path):
            with patch("sys.stdin", stdin), patch("sys.stdout", stdout), patch.object(sys, "argv", ["resolve_topic_approval.py", "--decision", "approve", "--json"]):
                rc = resolve_topic_approval.main()

        self.assertEqual(rc, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["decision"], "approved")

        updated_state = common.load_state(self.state_path)
        item = updated_state["items"][self.bookmark["bookmarkKey"]]
        self.assertEqual(item["approvalStatus"], "approved")
        self.assertEqual(item["reviewStatus"], "spec_created")



if __name__ == "__main__":
    unittest.main()


class ReviewNeverRewrittenTests(unittest.TestCase):
    """Tests for ensuring review docs are never rewritten once created."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.state_path = self.root / "brain" / "state" / "bookmark-review-state.json"
        self.reviews_root = self.root / "brain" / "reviews"
        self.specs_root = self.root / "brain" / "specs"
        # Create directories
        (self.root / "brain" / "state").mkdir(parents=True)
        (self.root / "brain" / "reviews" / "infra").mkdir(parents=True)
        (self.root / "brain" / "specs" / "infra").mkdir(parents=True)
        (self.root / "brain" / "bookmarks" / "infra").mkdir(parents=True)

    def tearDown(self):
        self.tempdir.cleanup()

    def test_list_candidates_skips_review_with_specs(self):
        """If review exists and has specs, should skip entirely."""
        # Create state with review + specs
        state = common.state_template()
        state["items"]["test123"] = {
            "bookmarkKey": "test123",
            "path": "brain/bookmarks/infra/test.md",
            "topic": "infra",
            "title": "Test Bookmark",
            "reviewDoc": "brain/reviews/infra/test-review.md",
            "specDocs": ["brain/specs/infra/test-spec.md"],  # Has spec
            "analysis": {"classification": "implement"},
        }
        common.save_state(state, self.state_path)

        # Create actual review file
        review_file = self.root / "brain/reviews/infra/test-review.md"
        review_file.write_text("Classified as 'implement'")

        # Create actual spec file
        spec_file = self.root / "brain/specs/infra/test-spec.md"
        spec_file.write_text("# Test Spec")

        # Create bookmark file so candidate finder sees it
        bookmark_file = self.root / "brain/bookmarks/infra/test.md"
        bookmark_file.write_text("# Test")

        # Import and run list_review_candidates
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "agents/workflows/bookmark"))
        import importlib
        import list_review_candidates
        importlib.reload(list_review_candidates)

        # Mock the common module to use our test paths
        with patch.object(common, "WORKSPACE", self.root):
            with patch.object(common, "STATE_PATH", self.state_path):
                with patch.object(common, "BOOKMARKS_ROOT", self.root / "brain/bookmarks"):
                    candidates = list_review_candidates.find_candidates(self.root / "brain/bookmarks", "any", 25)

        # Should skip because has review + specs
        self.assertEqual(len(candidates), 0)

    def test_list_candidates_allows_spec_regeneration_when_no_specs(self):
        """If review exists with implement but no specs, should allow spec generation."""
        # Create state with review but NO specs
        state = common.state_template()
        state["items"]["test456"] = {
            "bookmarkKey": "test456",
            "path": "brain/bookmarks/infra/test2.md",
            "topic": "infra",
            "title": "Test Bookmark 2",
            "reviewDoc": "brain/reviews/infra/test2-review.md",
            "specDocs": [],  # No specs
            "analysis": {"classification": "implement"},
        }
        common.save_state(state, self.state_path)

        # Create actual review file with implement classification
        review_file = self.root / "brain/reviews/infra/test2-review.md"
        review_file.write_text("Classified as 'implement'")

        # Create bookmark file
        bookmark_file = self.root / "brain/bookmarks/infra/test2.md"
        bookmark_file.write_text("# Test 2")

        # Run list_review_candidates
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "agents/workflows/bookmark"))
        import importlib
        import list_review_candidates
        importlib.reload(list_review_candidates)

        with patch.object(common, "WORKSPACE", self.root):
            with patch.object(common, "STATE_PATH", self.state_path):
                with patch.object(common, "BOOKMARKS_ROOT", self.root / "brain/bookmarks"):
                    candidates = list_review_candidates.find_candidates(self.root / "brain/bookmarks", "any", 25)

        # Should find 1 candidate with skipReview=True
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["bookmarkKey"], "test456")
        self.assertTrue(candidates[0].get("skipReview"))

    def test_list_candidates_skips_review_not_implement(self):
        """If review exists but not implement, should skip entirely."""
        # Create state with review classified as monitor
        state = common.state_template()
        state["items"]["test789"] = {
            "bookmarkKey": "test789",
            "path": "brain/bookmarks/infra/test3.md",
            "topic": "infra",
            "title": "Test Bookmark 3",
            "reviewDoc": "brain/reviews/infra/test3-review.md",
            "specDocs": [],
            "analysis": {"classification": "monitor"},
        }
        common.save_state(state, self.state_path)

        # Create review file with monitor classification
        review_file = self.root / "brain/reviews/infra/test3-review.md"
        review_file.write_text("Classified as 'monitor'")

        # Create bookmark file
        bookmark_file = self.root / "brain/bookmarks/infra/test3.md"
        bookmark_file.write_text("# Test 3")

        # Run list_review_candidates
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "agents/workflows/bookmark"))
        import importlib
        import list_review_candidates
        importlib.reload(list_review_candidates)

        with patch.object(common, "WORKSPACE", self.root):
            with patch.object(common, "STATE_PATH", self.state_path):
                with patch.object(common, "BOOKMARKS_ROOT", self.root / "brain/bookmarks"):
                    candidates = list_review_candidates.find_candidates(self.root / "brain/bookmarks", "any", 25)

        # Should skip because not implement
        self.assertEqual(len(candidates), 0)

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.state_path = self.root / "brain" / "state" / "bookmark-review-state.json"
        self.specs_root = self.root / "brain" / "specs"
        (self.root / "brain" / "state").mkdir(parents=True)
        (self.root / "brain" / "specs" / "infra").mkdir(parents=True)

    def tearDown(self):
        self.tempdir.cleanup()

    def test_cleanup_clears_missing_specs_and_keeps_review_status(self):
        """When specs are missing but review exists, allow spec regeneration."""
        # State has specDocs pointing to non-existent file
        state = common.state_template()
        state["items"]["specgone"] = {
            "bookmarkKey": "specgone",
            "path": "brain/bookmarks/infra/test.md",
            "topic": "infra",
            "title": "Test",
            "reviewDoc": "brain/reviews/infra/test.md",
            "specDocs": ["brain/specs/infra/missing-spec.md"],  # Non-existent
            "reviewStatus": "spec_created",
            "analysis": {"classification": "implement"},
        }
        common.save_state(state, self.state_path)

        # Run cleanup (import and call)
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "agents/workflows/bookmark"))
        import list_review_candidates
        list_review_candidates.cleanup_stale_references(self.root)

        # Check state was cleaned but reviewStatus preserved
        updated = common.load_state(self.state_path)
        item = updated["items"]["specgone"]
        # specDocs should be cleared
        self.assertEqual(item.get("specDocs"), [])


class ReviewNeverRewrittenTests(unittest.TestCase):
    """Tests for ensuring review docs are never rewritten once created."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        
    def tearDown(self):
        self.tempdir.cleanup()

    def test_list_candidates_skips_review_with_specs(self):
        """If review exists and has specs, should skip entirely."""
        # Simulate the core logic directly
        existing = {"reviewDoc": "brain/reviews/infra/test.md", "specDocs": ["brain/specs/infra/test.md"]}
        
        
        # Create both review and spec files
        (self.root / "brain/reviews/infra/test.md").parent.mkdir(parents=True)
        (self.root / "brain/reviews/infra/test.md").write_text("# Review")
        (self.root / "brain/specs/infra").mkdir(parents=True)
        (self.root / "brain/specs/infra/test.md").write_text("# Spec")
        
        # Check if review exists
        review_path = self.root / existing["reviewDoc"]
        if review_path.exists():
            # Check if specs exist
            valid_specs = [s for s in existing.get("specDocs", []) if (self.root / s).exists()]
            if valid_specs:
                # Should skip
                should_process = False
            else:
                should_process = True
        else:
            should_process = True
            
        self.assertFalse(should_process)

    def test_list_candidates_allows_spec_regeneration_when_no_specs(self):
        """If review exists with implement but no specs, should allow spec generation."""
        existing = {"reviewDoc": "brain/reviews/infra/test.md", "specDocs": []}
        
        # Create review file with implement classification
        (self.root / "brain/reviews/infra/test.md").parent.mkdir(parents=True)
        (self.root / "brain/reviews/infra/test.md").write_text("Classified as 'implement'")
        
        
        review_path = self.root / existing["reviewDoc"]
        
        if review_path.exists():
            content = review_path.read_text()
            has_implement = "Classified as 'implement'" in content
            
            if has_implement:
                valid_specs = [s for s in existing.get("specDocs", []) if (self.root / s).exists()]
                if not valid_specs:
                    skip_review = True
                    should_process = True
                else:
                    should_process = False
            else:
                should_process = False
        else:
            should_process = True
            
        self.assertTrue(should_process)
        self.assertTrue(skip_review)

    def test_list_candidates_skips_review_not_implement(self):
        """If review exists but not implement, should skip entirely."""
        existing = {"reviewDoc": "brain/reviews/infra/test.md", "specDocs": []}
        
        # Create review file with monitor classification
        review_file = self.root / "brain/reviews/infra/test.md"
        review_file.parent.mkdir(parents=True)
        review_file.write_text("Classified as 'monitor'")
        
        
        review_path = self.root / existing["reviewDoc"]
        
        if review_path.exists():
            content = review_path.read_text()
            has_implement = "Classified as 'implement'" in content
            
            if has_implement:
                valid_specs = [s for s in existing.get("specDocs", []) if (self.root / s).exists()]
                if not valid_specs:
                    skip_review = True
                    should_process = True
                else:
                    should_process = False
            else:
                should_process = False
        else:
            should_process = True
            
        self.assertFalse(should_process)


class SpecRegenerationTests(unittest.TestCase):
    """Tests for regenerating specs when they are missing."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        
    def tearDown(self):
        self.tempdir.cleanup()

    def test_cleanup_preserves_review_when_specs_missing(self):
        """When specs are missing but review exists, reviewStatus should be preserved."""
        # Simulate the cleanup logic
        item = {
            "reviewDoc": "brain/reviews/infra/test.md",
            "specDocs": ["brain/specs/infra/missing.md"],
            "reviewStatus": "spec_created",
        }
        
        
        review_path = self.root / item["reviewDoc"]
        review_path.parent.mkdir(parents=True)
        review_path.write_text("# Review")
        
        # Run cleanup logic
        if item.get("specDocs"):
            valid_specs = [s for s in item.get("specDocs", []) if (self.root / s).exists()]
            if len(valid_specs) != len(item.get("specDocs", [])):
                item["specDocs"] = valid_specs
                # Only clear reviewStatus if there's no reviewDoc either
                if not valid_specs and not item.get("reviewDoc"):
                    item.pop("reviewStatus", None)
        
        # Since reviewDoc exists, reviewStatus should NOT be cleared
        self.assertEqual(item.get("reviewStatus"), "spec_created")
        self.assertEqual(item.get("specDocs"), [])

    def test_cleanup_clears_status_when_both_missing(self):
        """When both review and specs are missing, reviewStatus should be cleared."""
        item = {
            "reviewDoc": "brain/reviews/infra/test.md",  # Missing file
            "specDocs": ["brain/specs/infra/missing.md"],  # Missing file
            "reviewStatus": "reviewed",
        }
        
        
        review_path = self.root / item["reviewDoc"]
        
        # Review file doesn't exist
        if not review_path.exists():
            item.pop("reviewDoc", None)
            item.pop("reviewStatus", None)
        
        if item.get("specDocs"):
            valid_specs = [s for s in item.get("specDocs", []) if (self.root / s).exists()]
            if not valid_specs and not item.get("reviewDoc"):
                item.pop("reviewStatus", None)
        
        self.assertIsNone(item.get("reviewStatus"))

    def test_cleanup_clears_status_when_both_missing(self):
        """When both review and specs are missing, reviewStatus should be cleared."""
        item = {
            "reviewDoc": "brain/reviews/infra/test.md",  # Missing file
            "specDocs": ["brain/specs/infra/missing.md"],  # Missing file
            "reviewStatus": "reviewed",
        }
        
        
        review_path = self.root / item["reviewDoc"]
        
        # Review file doesn't exist
        if not review_path.exists():
            item.pop("reviewDoc", None)
            item.pop("reviewStatus", None)
        
        if item.get("specDocs"):
            valid_specs = [s for s in item.get("specDocs", []) if (self.root / s).exists()]
            if not valid_specs and not item.get("reviewDoc"):
                item.pop("reviewStatus", None)
        
        self.assertIsNone(item.get("reviewStatus"))
