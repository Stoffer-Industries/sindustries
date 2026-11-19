import importlib.util
import pathlib
import unittest

MODULE_PATH = pathlib.Path(__file__).with_name("identify_skipped_qa_tasks.py")
SPEC = importlib.util.spec_from_file_location("identify_skipped_qa_tasks", MODULE_PATH)
identify_skipped_qa_tasks = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(identify_skipped_qa_tasks)


def task(**overrides):
    value = {
        "id": "00000000-0000-0000-0000-000000000001",
        "title": "Example",
        "taskType": "code",
        "status": "acceptance",
        "assignee": "Rowan",
        "approvals": [],
    }
    value.update(overrides)
    return value


class QaApprovalGrantedTest(unittest.TestCase):
    def test_missing_row_is_not_a_grant(self):
        self.assertFalse(identify_skipped_qa_tasks.qa_approval_granted(task()))

    def test_pending_row_is_not_a_grant(self):
        row = {"type": "qa_agent", "state": "pending", "owner": "Ash"}
        self.assertFalse(
            identify_skipped_qa_tasks.qa_approval_granted(task(approvals=[row]))
        )

    def test_revoked_row_is_not_a_grant(self):
        row = {
            "type": "qa_agent",
            "state": "approved",
            "revokedAt": "2026-11-19T09:00:00.000Z",
            "owner": "Ash",
        }
        self.assertFalse(
            identify_skipped_qa_tasks.qa_approval_granted(task(approvals=[row]))
        )

    def test_approved_row_is_a_grant(self):
        row = {"type": "qa_agent", "state": "approved", "owner": "Ash"}
        self.assertTrue(
            identify_skipped_qa_tasks.qa_approval_granted(task(approvals=[row]))
        )

    def test_another_approval_type_does_not_grant_the_gate(self):
        row = {"type": "tech_design", "state": "approved", "owner": "Quinn"}
        self.assertFalse(
            identify_skipped_qa_tasks.qa_approval_granted(task(approvals=[row]))
        )


class ClassifyTaskTest(unittest.TestCase):
    def test_a_task_type_without_the_qa_gate_is_never_a_finding(self):
        self.assertIsNone(
            identify_skipped_qa_tasks.classify_task(task(), requires_qa_agent=False)
        )

    def test_a_task_outside_the_audited_statuses_is_never_a_finding(self):
        for status in ("open", "ready", "doing"):
            self.assertIsNone(
                identify_skipped_qa_tasks.classify_task(
                    task(status=status), requires_qa_agent=True
                ),
                f"a {status} task must not be a finding",
            )

    def test_an_accepted_task_with_a_granted_gate_is_not_a_finding(self):
        row = {"type": "qa_agent", "state": "approved", "owner": "Ash"}
        self.assertIsNone(
            identify_skipped_qa_tasks.classify_task(
                task(approvals=[row]), requires_qa_agent=True
            )
        )

    def test_a_materialised_gate_that_was_never_granted_is_affected(self):
        # The defect's signature: the gate row exists, so the gate applied,
        # and the task was promoted past it anyway.
        row = {"type": "qa_agent", "state": "pending", "owner": "Ash"}
        finding = identify_skipped_qa_tasks.classify_task(
            task(approvals=[row]), requires_qa_agent=True
        )
        self.assertIsNotNone(finding)
        self.assertEqual(finding["kind"], "skipped_gate")
        self.assertEqual(finding["qaApprovalState"], "pending")
        self.assertEqual(finding["qaApprovalOwner"], "Ash")
        self.assertEqual(len(finding["recommendedRepairs"]), 3)

    def test_a_task_with_no_gate_row_is_pre_gate_not_affected(self):
        # The gate materialises its row at task creation, so a task with no
        # row at all predates the gate. It is not damage from the transition
        # defect, and the report must not call it that.
        finding = identify_skipped_qa_tasks.classify_task(
            task(), requires_qa_agent=True
        )
        self.assertIsNotNone(finding)
        self.assertEqual(finding["kind"], "no_gate_row")
        self.assertEqual(finding["qaApprovalState"], "missing")

    def test_a_finding_never_claims_the_repair_was_performed(self):
        finding = identify_skipped_qa_tasks.classify_task(
            task(), requires_qa_agent=True
        )
        self.assertNotIn("approved", finding["recommendedRepairs"][0])

    def test_a_closed_task_is_affected_and_its_repair_starts_by_reopening(self):
        # A `done` task is approval-immutable (`409 TASK_IMMUTABLE`), so every
        # repair option has to start by reopening it. An option that implied
        # an approval could be attached to a closed task would be wrong.
        row = {"type": "qa_agent", "state": "pending", "owner": "Ash"}
        finding = identify_skipped_qa_tasks.classify_task(
            task(status="done", approvals=[row]), requires_qa_agent=True
        )
        self.assertIsNotNone(finding)
        self.assertEqual(finding["kind"], "skipped_gate")
        self.assertEqual(finding["status"], "done")
        self.assertTrue(
            all(
                "reopens the task" in repair
                for repair in finding["recommendedRepairs"]
            ),
            "every repair of a closed task must begin by reopening it",
        )

    def test_an_accepted_task_can_be_repaired_without_reopening_first(self):
        row = {"type": "qa_agent", "state": "pending", "owner": "Ash"}
        finding = identify_skipped_qa_tasks.classify_task(
            task(approvals=[row]), requires_qa_agent=True
        )
        self.assertIsNotNone(finding)
        self.assertTrue(
            any(
                "approval endpoint" in repair
                for repair in finding["recommendedRepairs"]
            ),
            "an accepted task's approvals are still mutable",
        )


class RenderTextTest(unittest.TestCase):
    def test_an_empty_report_says_so_plainly(self):
        text = identify_skipped_qa_tasks.render_text(
            {
                "affected": [],
                "preGateLive": [],
                "preGateClosedCount": 0,
                "preGateClosed": [],
            }
        )
        self.assertIn("No task has a materialised `qa_agent` gate", text)
        self.assertIn("read-only", text)

    def test_the_report_separates_affected_from_pre_gate_history(self):
        text = identify_skipped_qa_tasks.render_text(
            {
                "affected": [
                    {
                        "id": "affected-1",
                        "title": "Affected",
                        "taskType": "code",
                        "status": "done",
                        "assignee": "Rowan",
                        "kind": "skipped_gate",
                        "qaApprovalState": "pending",
                        "qaApprovalOwner": "Ash",
                        "recommendedRepairs": ["(a) reopen"],
                    }
                ],
                "preGateLive": [
                    {
                        "id": "pre-gate-1",
                        "title": "Pre gate",
                        "taskType": "feature",
                        "status": "acceptance",
                        "assignee": "Rowan",
                        "kind": "no_gate_row",
                        "qaApprovalState": "missing",
                        "qaApprovalOwner": "Ash",
                        "recommendedRepairs": ["(a) decide"],
                    }
                ],
                "preGateClosedCount": 77,
                "preGateClosed": [],
            }
        )
        self.assertIn("affected-1", text)
        self.assertIn("pre-gate-1", text)
        self.assertIn("77 closed task(s)", text)
        self.assertIn("not damage from the transition defect", text)


if __name__ == "__main__":
    unittest.main()
