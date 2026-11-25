# HEARTBEAT.md — Ash

Scope: discover the one QA/verification action Ash may take. Detailed evidence reasoning and routing live in WORKFLOW.md, agents/ash/src/verify.ts, and Tasks API skills.

## Scheduler policy
- Fresh pass: build the unified queue before silence.
- Order: queue, hydrate/reconfirm, one QA action, bounded output.
- Budget: one top candidate per pass.
- Action cap: one verification or one newly evidenced blocker; no broad QA sweep.
- Concurrency: evidence reads may be parallel; approval/block/defer mutation is serialized after all ACs are evaluated.
- Exhaustion: report a bounded skip, never an approval based on partial evidence.
- Final output: preserve the QA result marker and task comment as Ash-owned output; return HEARTBEAT_OK only when no candidate is actionable.

## Unit: qa-gate
**Purpose:** verify the current Ash-owned QA gate from fresh delivery evidence.
**Trigger:** unified queue returns an actionable Ash attention page or the exact current doing to qa_agent gate when attention owners are empty.
**Inputs and state:** queue/task data, attention-owner stack, linked merged PR body/files/raw patch via gh api, cited tests/files, tech-design test matrix, and agents/ash/src/verify.ts. Tasks API owns approval, block, defer, and capability-request comments; preserve duplicate role slots and never scan comments for control state.
**Action boundary:** hydrate and reconfirm status, gate, and owner. Fetch the full task and delivery, use extractAcLines and stripTrailingEvidence as imports, and reason over every bare AC against the PR patch and the cited test results and files. For UI ACs require real route/browser evidence; for SPEC changes require matching e2e and coverage-table updates unless the approved design names a justified fallback. Before deferred, execute available cited commands and bounded live probes. Follow WORKFLOW.md: all verified means the structured qa_agent approval plus a [qa-agent-verified] comment naming every AC; an incomplete delivery means a [qa-agent-blocked] AC<N>: <reason> comment per blocked AC, no structured approval, routed back to Rowan; a missing capability means a [qa-agent-deferred] AC<N>: <reason> comment plus a matching [qa-agent-capability-request] entry routed to Quinn, with a two-strike follow-up task only on the second distinct task.
**Output contract:** exactly one structured gate mutation and matching evidence comment when a verdict is reached, using the [qa-agent-verified], [qa-agent-blocked], and [qa-agent-deferred] markers above; no approval on blocked/deferred ACs. External evidence failure uses notify-soft-fail and stops without a placeholder verdict.
**Stop condition:** one top candidate and all its ACs, or first external blocker; never start a second task.
**Growth trigger:** promote to a QA cron if evidence collection needs its own cadence/tools; create a workflow when capability tasks and original-task reruns need ordered handoffs.

## Shared failure policy
Read and follow notify-soft-fail. Do not patch task status, clear all attention owners, approve from partial evidence, or classify incomplete delivery as a capability gap.
