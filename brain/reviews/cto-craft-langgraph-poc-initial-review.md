# CTO Craft LangGraph POC — initial review

Status: preliminary
Task: `9dfe56e4-13c4-4bb4-b53f-de7c77afd0d2`
Date: 2026-08-13

## Important scope note

This is an initial implementation review only.

**Live production evidence and the required four-run operating evidence are still pending.**
Nothing below should be read as proof that the POC has passed its real-world evaluation criteria yet.

## What is implemented now

- LangGraph workflow for archive discovery, issue parsing, article fan-out, scoring, selection, import, and notification shaping.
- Production-shaped `StructuredAngleModel` adapter using a one-shot non-delivering OpenClaw invocation with strict JSON parsing and `AngleOutput` validation.
- Configurable model selection and bounded retry semantics for transient/invalid structured-output failures.
- Deterministic CI-safe tests for:
  - adapter parsing and retry behavior
  - permanent adapter failures
  - checkpoint interrupt/resume without repeating completed work
  - commit-then-lost-response retry proving import idempotency at the workflow boundary
- Cron prompt updated to run from the canonical checkout path.

## Current evidence

### Deterministic test evidence

The implementation now has focused offline coverage for the two main POC claims that were previously only design intent:

1. **Checkpoint resume can continue from persisted state without redoing completed work** in CI using LangGraph's in-memory test checkpointer.
2. **A lost response after a committed import does not create duplicate drafts on retry** when the import layer behaves idempotently.

### What this evidence does prove

- The workflow structure is compatible with checkpoint pause/resume semantics.
- The import boundary is modeled so retries can safely converge to `createdCount=0` / duplicate-skip behavior instead of duplicating drafts.
- The production adapter path no longer silently falls back to `FakeAngleModel` on normal runs.

### What this evidence does not prove yet

- Real OpenClaw model reliability, cost, latency, or token behavior.
- Real PostgreSQL checkpointer behavior over multiple scheduled runs.
- Operational cleanup / retention burden of stored checkpoints.
- Real cron/runtime delivery behavior in production.
- Whether the workflow is actually clearer or easier to debug than a bespoke orchestrator under live failures.

## Pending evidence before final verdict

To complete the POC review promised in the tech design, we still need:

- at least one live run against the real public issue flow
- at least four scheduled runs or equivalent operational observations
- checkpoint persistence observations on the real Postgres backend
- real logs/debuggability notes from at least one injected or naturally occurring failure
- a short adopt/adjust/avoid verdict based on those runs

## Current assessment

Promising, but not proven.

The code now exercises the core LangGraph claims in deterministic tests and closes the biggest implementation gap: the production model path exists and is bounded. But the POC's real evaluation criteria are operational, so the final review remains open until live evidence arrives.
