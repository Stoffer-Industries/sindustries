---
name: incident-author
description: Classify and manage Quinn-owned operational incidents versus task gates and routine failures, using the shared parser/schema and bounded evidence-backed lifecycle.
---

# Incident author

## RULES

- **Always classify before writing state:** task gate/blocker/handoff belongs in the Tasks API; a routine failure stays in the owning workflow; only a systemic agent/runtime or pipeline-operation fault belongs in Quinn incident state.
- **Never create task-scoped incidents.** One shared root cause gets one stable kebab-case identity; affected task IDs are evidence in `impactTaskIds`, never the identity.
- **Always respect ownership:** Quinn owns agent/runtime and pipeline-operation incidents; Lox owns infrastructure, host reliability, service uptime, and prodlike/local stack health. Quinn never writes Lox state.
- **Always use stable evidence:** record the trigger, current observation, timestamps, action, affected tasks, and linked remediation evidence; never key entries by dates or transient task status.
- **Never treat unreadable or malformed state as empty.** Fail closed, preserve valid siblings, and surface an UNVERIFIED result.
- **Always re-validate live state before escalation or resolution.** Do not escalate stale evidence or resolve because an individual task moved.

## PROCESS

1. Establish scope and ownership. Read the heartbeat trigger, task/queue evidence, `docs/systems/agent-incidents.md`, and this skill. Completion criterion: the finding is classified as Quinn incident, Lox infrastructure incident, task gate, or routine failure.
2. Gather stable evidence. Identify the shared root-cause slug, current impact, first/last observation, and affected task IDs. A single task wait without a shared cause remains in the Tasks API. Completion criterion: the entry can stand without a task ID as its identity.
3. Read state through `agents.lib.incident_state.read_registry()` or the bounded incident queue CLI; do not use `load_all_incidents()` for health verdicts. Validate against `agents/schemas/agent-incident-state.schema.json` when writing. Completion criterion: both registries’ read status is known and failures are not hidden.
4. Apply one bounded lifecycle mutation. Upsert an existing date-free entry, increment attempts and refresh `lastCheckedAt`; create only a genuinely new shared root cause; resolve only when the root cause is fixed; archive invalid legacy task-only entries with a reason. Write only Quinn’s registry, atomically and without deleting state. Completion criterion: one mutation has an evidence-backed reason and preserves `impactTaskIds` on resolution.
5. Re-validate before output. Re-read the live registry/queue, confirm counts and escalation eligibility, and distinguish actionable from monitored findings. Completion criterion: no escalation relies on stale or partial state; exit 3/UNVERIFIED is retained and reported.
6. Hand off by contract. Route infrastructure failures to Lox; route ordinary task gates through ordered `attentionOwners`; page Tom only for a validated Quinn-owned actionable incident and only once per unchanged evidence. Completion criterion: output names classification, action/evidence, and next owner.

## OUTPUT FORMAT

Return one concise labeled result: `classification`, `incident slug` (or `none`), `evidence/action`, `impactTaskIds` when relevant, `queue status/counts`, and `next owner`. Routine no-op is silent. A task gate is reported through its Tasks API evidence, not incident state. Infrastructure output says `route to Lox` and never claims Quinn repaired it. An unreadable/malformed registry includes `UNVERIFIED`, the path/error, and never claims a clean queue.

## KNOWLEDGE FILES

1. `docs/systems/agent-incidents.md` — human-facing schema and lifecycle reference; knowledge only, not a substitute for this skill.
2. `agents/schemas/agent-incident-state.schema.json` — state contract.
3. `agents/lib/incident_state.py` — parser, normalization, read-failure evidence, and validation helpers.
4. `agents/lib/incident_queue.py` — bounded reportable queue and exit-3 behavior.
5. `agents/skills/ops/attention-owner-routing/SKILL.md` — task-gate handoff path.
6. `agents/skills/ops/notify-soft-fail/SKILL.md` — dependency-failure output routing.

## ONBOARDING

The caller must provide the observed failure, owning agent/context, task and queue evidence, stable root-cause candidate, affected task IDs, current registry read status, and desired lifecycle action (observe, upsert, resolve, archive, or escalate). The caller must state whether the work is a heartbeat pass or a manual incident operation. For heartbeat use, one pass may perform at most one bounded queue read and one validated state mutation/escalation.

## IDENTITY

> Read the invoking agent’s `AGENTS.md` for role, authority, and voice. This skill supplies shared incident lifecycle procedure only.
