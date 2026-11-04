# Control — PASS
#
# A hand-written known-good review: it names every planted defect and
# re-reports nothing that was already fixed. The grader must score it as a
# full pass. If it does not, the grader's anchors do not match the way the
# defects are actually described, and every model's score is suspect.

FINDING: quinn's documented read/write pattern destroys incidents on a read failure
LOC: agents/definitions/quinn/HEARTBEAT.md:352-361
EXPLAIN: `read_ops_state()` catches every exception and returns `{"incidents": {}}`.
`write_ops_state(state)` then opens the file with `"w"`, so the swallowed failure
truncates the real state file and destroys every incident in it. The next run
reads a valid-but-empty registry and reports a verified clean queue — a clean
result produced by the failure path. This is the exact condition the change
exists for, still reachable through the file's own documented pattern.
FIX: Make `read_ops_state()` surface the failure and abort the write path when
the state could not be read.

FINDING: The UNVERIFIED guidance tells the agent to withhold the counts it must still report
LOC: agents/definitions/quinn/HEARTBEAT.md:316
EXPLAIN: The new paragraph says to re-run "before reporting any count", while
`render_text` deliberately still prints the counts, the "N incident(s) waiting
on you." line and the top unblock for the records that did load — and lox's
definition says those "must still be reported". Following the quinn guidance
re-hides the top unblock behind the banner, which is the defect the change
fixed in the code.
FIX: Say the counts and top unblock are still printed and must still be
reported, and that they must not be presented as a complete or verified queue.

FINDING: Step 5's HEARTBEAT_OK rule discards the exit-3 signal
LOC: agents/definitions/quinn/HEARTBEAT.md:324
EXPLAIN: Step 5 replies `HEARTBEAT_OK` whenever there are no active findings.
On an UNVERIFIED run the counts are 0 actionable and 0 monitored, so that is
literally true — the agent replies HEARTBEAT_OK, never reports the UNVERIFIED
banner or the offending path, and the exit code 3 is discarded. An unreadable
registry is not an empty one.
FIX: Key the HEARTBEAT_OK decision on the CLI having exited 0.

FINDING: The malformed-JSON failure-mode bullet still documents the old behaviour
LOC: docs/systems/agent-incidents.md:177
EXPLAIN: The bullet still says malformed JSON "the parser logs a warning and
treats the file as empty (so heartbeat does not crash)". The change makes
malformed JSON a read failure: the queue renders UNVERIFIED with the offending
path and exits 3. An operator following the bullet still treats a failed read
as a legitimately empty registry.
FIX: Describe malformed JSON, invalid UTF-8, a dataless placeholder and a
wrong-shape registry as read failures that render UNVERIFIED and exit 3.

FINDING: Lox's own primary registry read has no OSError handling
LOC: infra/lox_incident_state.py:570
EXPLAIN: `main()` catches only FileNotFoundError and JSONDecodeError, and
`load_state()` has no OSError handling at all. The dataless-placeholder case
this change is built around raises `OSError [Errno 11] Resource deadlock
avoided` and escapes as an unhandled traceback with exit 1, before Lox reaches
the roll-up CLI the new guidance describes. Its FileNotFoundError branch is also
a clean zero: Lox is told "nothing to triage" for a registry it never read.
FIX: Catch OSError, treat a missing file as a distinct not-read state rather
than "nothing to triage", and exit non-zero with an UNVERIFIED-style message.

FINDING: The new contract test asserts a keyword rather than the behaviour
LOC: agents/definitions/test_definitions.py:74
EXPLAIN: The test only asserts that the substring "UNVERIFIED" appears in any
definition that runs the queue CLI. Quinn's HEARTBEAT.md contains that literal
string inside the very paragraph that tells the agent to withhold the counts,
so the test passes while the documented contract contradicts the production
rendering behaviour the change's own tests verify. It gives false confidence
that every definition's UNVERIFIED guidance is correct.
FIX: Assert the specific phrases that carry the instruction, across every
definition that runs the CLI, not the bare substring.
