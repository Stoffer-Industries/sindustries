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


if __name__ == "__main__":
    unittest.main()
