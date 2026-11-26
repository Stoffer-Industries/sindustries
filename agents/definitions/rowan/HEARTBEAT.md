# HEARTBEAT.md — Rowan

**Scope of this file:** polling cadence, discovery order, per-pass triggers,
priority, and stop conditions. Execution details live in `WORKFLOW.md` and the
referenced skills.

## Scheduler policy

- **Fresh-pass contract:** Load the current agent definition and run the shared task queue before deciding that the pass is empty. Read it with `tasks-api/scripts/agent_task_queue.py --assignee Rowan --json`; never infer emptiness from a raw query or the GitHub login `rowanstoffer`.
- **Order:** Queue discovery → PR candidate → task candidate → code gardening → retro scan. PR and task work use the queue's one deterministic `topCandidate`; code gardening is considered only after task work has been evaluated.
- **Budget:** Target ≤20 minutes and always finish within the 30-minute cadence; hard ceiling `timeoutSeconds: 1500`. The agent enforces this budget itself: on a continuation wake — an exec-completion event, a background-task event, or a `task:`-prefixed cron event — the runtime drops the per-agent ceiling, so the turn can run for hours. Treat ≤20 minutes as a hard stop on elapsed wall-clock time regardless of what the scheduler enforces; stop on elapsed time rather than waiting for the scheduler to stop you.
- **Action cap:** At most one queue candidate and at most one code-garden PR per pass. Do not start a second item because time remains. A unit-level exception — the `open` tech-design priority in `WORKFLOW.md` — changes which item is taken first; it never widens this cap.
- **Concurrency:** Serialize units because they share queue, branch/PR dedupe, and Rowan task attention state. Retro runs only after useful work.
- **Pass hygiene:** End every pass with nothing of Rowan’s still running. A pass must not leave a backgrounded or pending exec in flight: its completion event makes the next wake a continuation wake — the wake type that loses the ceiling above — and it keeps a shared execution slot occupied. Collect results before the pass ends, or record what is still pending in Rowan memory and re-derive it on the next pass.
- **Exhaustion:** On budget exhaustion — elapsed time, action cap, or the scheduler ceiling — stop immediately. Record staged gardening work, branch, or prepared change in Rowan memory so the next pass can resume; remaining units emit bounded `SKIPPED_BUDGET` records rather than claiming a clean pass.
- **Final output:** Aggregate unit results as separately labelled records. Emit `NO_REPLY` only when every required discovery unit ran or recorded its safe skip condition and every unit is silent by its own contract.

## Unit: queue-discovery

**Purpose:** Build the authoritative, deterministic work view for this pass.

**Trigger:** Every heartbeat pass, before any action or silence decision.

**Inputs and state:** Read the Tasks API queue script and environment from `$HOME/.openclaw/.env`; read current open Sindustries PR metadata. The queue owns classification and `topCandidate`; this unit may not change task state, review PRs, comment, or merge.

**Action boundary:** Run the queue script once and retain its tasks, PR candidates, classifications, and `topCandidate`. Follow the tasks-api skill; do not substitute raw curl/query.

**Output contract:** Silent on a valid queue. Return labelled `QUEUE_BLOCKED` to Lox's main session through canonical soft-failure policy on API/auth/empty-output/traceback failure. Never emit `NO_REPLY` from this unit.

**Stop condition:** One successful queue read, one newly evidenced blocker, or scheduler budget. Do not retry indefinitely.

**Growth trigger:** Promote to a dedicated cron if queue latency/retries regularly consume heartbeat budget, or a workflow if queue state needs durable retries/handoffs with another scheduler.

## Unit: pr-candidate

**Purpose:** Progress exactly one assigned or authored PR candidate.

**Trigger:** `topCandidate.kind` is `reviewRequest`, `authoredPrFeedback`, `authoredPrConflict`, or `mergeCandidate`.

**Inputs and state:** Read the queue candidate, live PR reviews/checks/branch, and Rowan's `WORKFLOW.md`; write only PR branch, PR metadata, and required task/PR evidence permitted there. Reviewer requests and assignees are separate GitHub endpoints and must be verified after PR creation.

**Action boundary:** Follow `pr-process/SKILL.md` for the matching path. For conflicts use `WORKFLOW.md`; Rowan may merge only his own eligible PR after Quinn's blocking approval and green CI. Use the task/PR dedupe guard before implementation and before creating a PR; never create a duplicate.

**Output contract:** Silent when safely skipped because no unresolved work remains. Otherwise emit one labelled `PR_PROGRESS`, `PR_BLOCKED`, or `PR_RACE` naming PR and evidence. External failures follow shared soft-failure policy; this unit does not claim task completion.

**Stop condition:** One candidate's bounded review, feedback fix, conflict handoff, or eligible merge; stop at first blocker, race, or budget limit.

**Growth trigger:** Spin independently scheduled or long-running review into a cron; create a workflow only when PR work needs ordered retries/handoffs across crons.

## Unit: task-candidate

**Purpose:** Materially progress one actionable Rowan task while preserving Lobster capacity and attention ownership.

**Trigger:** `topCandidate.kind` is `task`, or a task has an actionable implementation state requiring Rowan's workflow.

**Inputs and state:** Read queue candidate and assigned active tasks, `WORKFLOW.md`, open Sindustries PRs/branches, latest `[lobster-state]`, approvals, gate, `assignee`, and `attentionOwners`. Write only through Tasks API/approved task comments and Rowan's implementation branch/PR.

**Action boundary:** Follow `WORKFLOW.md`. If an assigned `open` task lacks `[tech-design]` or `[tech-design-not-required]`, post the design first and wait for Quinn approval. Otherwise make one concrete delivery step: branch, commit, PR, validation, required comment, or newly evidenced blocker. Before changing `attentionOwners`, read latest Lobster state; unresolved `failureFingerprint` on a `doing` task remains a delivery blocker, not a reason to add Tom or Quinn. Before finishing, read back assignee, attention owners, approvals, and gate; keep Rowan assigned while advancing a completed handoff.

**Output contract:** Emit one labelled `TASK_PROGRESS` for material progress or `TASK_BLOCKED` for a concrete blocker. A pass with actionable work and no progress is failure and uses shared soft-failure policy; never silently report success.

**Stop condition:** One tech-design post, one bounded implementation/evidence step, or first blocker/race/budget limit. Do not implement multiple tasks.

**Growth trigger:** Extract a reusable stable primitive into a skill; spin long-running/retryable work into a cron; use a workflow when task crons require ordered transitions/retries/handoffs.

## Unit: code-garden

**Purpose:** Make one bounded maintenance improvement only when assigned work does not require Rowan's action.

**Trigger:** No PR candidate, no `open` task waiting for tech design, no `doing`/`acceptance` task can materially progress, and any needed nudge is sent. Dependency-blocked or waiting-external alone is not a skip reason.

**Inputs and state:** Read queue classifications, open code-garden PRs, `code-garden` skill, retro handoff, and Rowan memory. Write at most one maintenance branch/PR and current-pass memory for resumable work.

**Action boundary:** Follow `code-garden/SKILL.md`; check open code-garden PR first. Prefer cheap retro handoff over whole-tree sweep. Stage and carry a candidate when budget expires.

**Output contract:** Silent when an existing garden PR or valid scheduler skip applies. Otherwise emit one labelled `GARDEN_PROGRESS` or `GARDEN_BLOCKED` with candidate/PR and evidence. This unit owns no task or PR-candidate output.

**Stop condition:** One finding/PR, one newly evidenced blocker, or 20 minutes elapsed; never begin another finding after the threshold.

**Growth trigger:** Promote to a cron when independently cadenced, long-running, or repeatedly budget-consuming; create a workflow only if gardening needs ordered retries/handoffs.

## Shared failure policy

For GitHub auth/scope errors, Tasks API errors, service unavailability, tracebacks, unexpected empty output, or brittle diagnostic failures, stop the affected unit, preserve completed work, and follow `agents/skills/ops/notify-soft-fail/SKILL.md` to escalate to Lox's main session. Do not fall back silently, spam Tom with raw errors, or let one unit claim another's success. Incident authority remains with existing incident-routing conventions; this heartbeat does not invent authority.

## Retro notes scan

After units complete, use `retro-notes` skill for a bounded scan of recent build/infra/CI/PR work. If a recurring pattern appears for the second or later time, append one row to today's `brain/ops/retro-notes/YYYY-MM-DD.md`; do not duplicate a weekly `pattern-slug`. Silent when no new pattern exists; emit `RETRO_RECORDED` only when writing a row.

If this scan repeatedly exceeds budget or needs independent cadence, promote it to a cron; if multiple retro jobs need ordering or shared deduplication state, create a workflow.
