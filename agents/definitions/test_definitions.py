import pathlib
import unittest

DEFINITIONS = pathlib.Path(__file__).parent


class AshDefinitionContractTest(unittest.TestCase):
    def test_ash_is_a_complete_source_definition(self):
        required = {
            "SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md",
            "HEARTBEAT.md", "WORKFLOW.md", "DoD.md",
        }
        self.assertEqual(required, {path.name for path in (DEFINITIONS / "ash").glob("*.md")})
        readme = (DEFINITIONS / "README.md").read_text()
        self.assertIn("source of truth", readme)
        self.assertIn("agents/definitions/ash/", readme)

    def test_ash_execution_docs_pin_attention_and_escalation_semantics(self):
        docs = "\n".join(
            (DEFINITIONS / "ash" / name).read_text()
            for name in ("TOOLS.md", "HEARTBEAT.md", "WORKFLOW.md")
        )
        for phrase in (
            "qa_agent",
            "attentionOwners[0]",
            "comments are audit",
            "Repeated",
            "OpenClaw/runtime",
            "Quinn is the highest agent escalation",
            'attentionOwners=["Tom"]',
            "no escalation beyond him",
        ):
            self.assertIn(phrase, docs)

    def test_terminal_tom_is_distinguished_from_dormant_tail(self):
        workflow = (DEFINITIONS / "ash" / "WORKFLOW.md").read_text()
        self.assertIn("Tom at position 0", workflow)
        self.assertIn("appearing later in a tail remains dormant", workflow)
        self.assertIn("ordinary delivery evidence fails", workflow)
        self.assertIn("route by capability", workflow)
        self.assertIn("gate-owner fallback when `attentionOwners` is empty", workflow)
        self.assertIn("position 0 acts and Ash's gate fallback is dormant", workflow)


class AttentionOwnerActionContractTest(unittest.TestCase):
    def test_quinn_attention_owner_is_active_unblock_not_passive_review(self):
        quinn_heartbeat = (DEFINITIONS / "quinn" / "HEARTBEAT.md").read_text()
        rowan_workflow = (DEFINITIONS / "rowan" / "WORKFLOW.md").read_text()
        docs = " ".join(f"{quinn_heartbeat}\n{rowan_workflow}".split())
        for phrase in (
            "an active unblock handoff, not a watchlist",
            "must only be added at position 0",
            "Never add Quinn as a later dormant slot",
            "On this heartbeat, investigate the blocker",
            "remove Quinn from the ordered stack immediately",
            "Every position-0 owner is an active blocker owner",
            "Use the PR review request mechanism for review work",
        ):
            self.assertIn(phrase, docs)


class UnifiedQueuePathContractTest(unittest.TestCase):
    """A relative path in an agent definition fails open, not closed.

    Lox's HEARTBEAT.md pointed the unified queue at `scripts/agent_task_queue.py`,
    which resolves from no working directory the heartbeat actually runs in. The
    pass could not run the sanctioned command, fell back to reading the Tasks API
    directly, and that fallback output was recorded in incident state as fact and
    reported to Tom twice before the path was checked against the file it names.

    Every definition that invokes the unified queue or the incident-queue CLI must
    therefore anchor the path it runs.
    """

    QUEUE_INVOCATIONS = ("agent_task_queue.py", "incident_queue")
    ANCHORS = ("/Users/quinnstoffer/", "~/.openclaw/")

    def test_queue_invocations_in_definitions_are_anchored(self):
        offenders = []
        for heartbeat in sorted(DEFINITIONS.glob("*/HEARTBEAT.md")):
            for number, line in enumerate(heartbeat.read_text().splitlines(), start=1):
                if not any(invocation in line for invocation in self.QUEUE_INVOCATIONS):
                    continue
                if not any(anchor in line for anchor in self.ANCHORS):
                    offenders.append(
                        f"{heartbeat.relative_to(DEFINITIONS)}:{number}: {line.strip()}"
                    )
        self.assertEqual(
            [],
            offenders,
            "queue paths must be anchored to an absolute or ~-anchored location:\n"
            + "\n".join(offenders),
        )


if __name__ == "__main__":
    unittest.main()
