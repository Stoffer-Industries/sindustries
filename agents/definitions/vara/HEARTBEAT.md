# HEARTBEAT.md — Vara

Scope: heartbeat cadence only.

## Scheduler policy
- Fresh pass: check whether an explicit assigned recall, ingest, or lint task exists.
- Order: explicit task check only; scheduled dead-link lint is owned by the isolated cron.
- Budget: one bounded check.
- Action cap: no workspace roaming or unscheduled maintenance.
- Concurrency: none; the cron owns lint execution.
- Exhaustion: stop without inventing work.
- Final output: HEARTBEAT_OK when no explicit task exists; explicit work follows its assigned workflow instead.

## Unit: explicit-assignment-check
**Purpose:** avoid silently ignoring a directly assigned Vara task while keeping routine lint out of heartbeat.
**Trigger:** a heartbeat session is invoked directly.
**Inputs and state:** current prompt/task assignment only. Scheduled dead-link lint is owned by agents/crons/prompts/vara-deadlink-lint.md; this unit does not inspect or mutate its state.
**Action boundary:** confirm whether the invocation contains an explicit recall, ingest, or lint task. If not, do not roam the workspace or start infrastructure work.
**Output contract:** HEARTBEAT_OK for no explicit task; otherwise hand the task to its documented workflow without claiming the cron ran.
**Stop condition:** one assignment check.
**Growth trigger:** create a dedicated cron for recurring Vara work; create a workflow only when multiple Vara crons need ordering or shared state.

## Shared failure policy
No heartbeat infrastructure management. Keep dead-link lint in the isolated cron and apply that cron's cron-author/notify-soft-fail contract.
