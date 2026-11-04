import pathlib
import re
import unittest

DEFINITIONS = pathlib.Path(__file__).parent


def _python_blocks(text: str) -> list[str]:
    """Return the contents of every ```python fenced block in ``text``.

    Used by the contract tests to assert what the *documented code* does,
    separately from what the surrounding prose says about it. A helper named
    in a "do not use this" sentence is the guidance working; a blanket
    substring ban over the whole document would forbid exactly the wording
    that closes the hole.
    """
    return re.findall(r"```python\n(.*?)```", text, flags=re.DOTALL)


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


class UnverifiedRegistryContractTest(unittest.TestCase):
    """Every definition that runs the incident-queue CLI must honour exit 3.

    The CLI exits `3` when a state file could not be read or parsed, because
    an unreadable registry is not an empty one. A definition that does not
    know about exit 3 has no guidance for what to do with an UNVERIFIED run,
    and the counts it printed may silently exclude a CRITICAL incident.
    """

    def test_every_definition_running_the_incident_queue_knows_about_unverified(self):
        offenders = []
        for heartbeat in sorted(DEFINITIONS.glob("*/HEARTBEAT.md")):
            text = heartbeat.read_text()
            if "incident_queue" not in text:
                continue
            if "UNVERIFIED" not in text:
                offenders.append(f"{heartbeat.relative_to(DEFINITIONS)}: no UNVERIFIED guidance")
        self.assertEqual(
            [],
            offenders,
            "definitions running the incident-queue CLI must document the "
            "UNVERIFIED / exit-3 path:\n" + "\n".join(offenders),
        )

    def test_unverified_guidance_does_not_withhold_the_counts(self):
        """UNVERIFIED is an addition to the summary, not a replacement for it.

        `render_text` still prints the counts, the "N incident(s) waiting on
        you." line and the top unblock for the records that *did* load, and
        the queue's own regression test asserts the top unblock survives a
        partially-readable registry. A definition that tells the agent to
        withhold the counts until it re-runs contradicts that behaviour and
        re-hides the top unblock behind a banner — the exact defect the
        second commit of this PR fixed in the code.

        The substring check is done on whitespace-normalised text because the
        clause can wrap across lines, and a wrapped clause is still a clause.
        """
        required = ("UNVERIFIED", "must still be reported", "brctl download")
        offenders = []
        for heartbeat in sorted(DEFINITIONS.glob("*/HEARTBEAT.md")):
            text = heartbeat.read_text()
            if "incident_queue" not in text:
                continue
            normalised = " ".join(text.split())
            for phrase in required:
                if phrase not in normalised:
                    offenders.append(
                        f"{heartbeat.relative_to(DEFINITIONS)}: missing {phrase!r}"
                    )
            if "before reporting any count" in normalised:
                offenders.append(
                    f"{heartbeat.relative_to(DEFINITIONS)}: withholds the counts "
                    "until a re-run, which contradicts render_text"
                )
        self.assertEqual(
            [],
            offenders,
            "UNVERIFIED guidance must state that the counts and the top unblock "
            "are still reported, and must not withhold them:\n" + "\n".join(offenders),
        )

    def test_lox_heartbeat_documents_the_unverified_path(self):
        lox = (DEFINITIONS / "lox" / "HEARTBEAT.md").read_text()
        for phrase in (
            "UNVERIFIED",
            "exits `3`",
            "Top unblock",
            "brctl download",
        ):
            self.assertIn(phrase, lox)

    def test_quinn_heartbeat_does_not_destroy_incidents_on_a_read_failure(self):
        """A read failure must not be swallowed into an empty registry.

        `read_ops_state()` used to catch every exception and return
        `{"incidents": {}}`. The documented pattern then calls
        `write_ops_state(state)`, which opens the file with "w" — so the
        swallowed failure truncated the real state file and destroyed every
        incident in it. The next run read a valid-but-empty registry and
        reported a verified clean queue, produced by the failure path.

        The check targets the python code blocks, not the prose: naming the
        helper in a "do not use this" sentence is the guidance working, and a
        blanket substring ban would forbid exactly the wording that closes
        the hole.
        """
        quinn = (DEFINITIONS / "quinn" / "HEARTBEAT.md").read_text()
        normalised = " ".join(quinn.split())
        self.assertNotIn(
            'return {"incidents": {}}',
            normalised,
            "read_ops_state must not turn a read failure into an empty registry: "
            "the write path truncates the file and would destroy every incident",
        )
        for block in _python_blocks(quinn):
            self.assertNotIn(
                "load_all_incidents",
                block,
                "the documented heartbeat code must not use load_all_incidents(), "
                "which discards read failures and returns a false empty list — "
                "use read_registry() and check `verified`",
            )


if __name__ == "__main__":
    unittest.main()
