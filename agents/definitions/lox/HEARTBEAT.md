# HEARTBEAT.md — Lox

Scope: polling, bounded discovery, incident routing, and handoff. Detailed incident mechanics live in agents/skills/ops/incident-author/SKILL.md; task routing lives in agents/skills/ops/attention-owner-routing/SKILL.md and WORKFLOW.md.

## Scheduler policy
- Fresh pass: read the current daily-review pointer and bounded incident queue before silence; never read raw incident state as a fallback.
- Order: gateway-config preflight, incident queue, attention-owner pages, peer-heartbeat staleness, retro-notes scan.
- Budget: one bounded pass; stop on the first external failure or when the turn/time budget is exhausted.
- Action cap: at most one safe repair or one task handoff per unit; do not run broad maintenance.
- Concurrency: units may read independently, but state writes and repairs are serialized.
- Exhaustion: report a bounded skip for remaining units; do not claim a clean queue.
- Final output: each unit owns its own notification/state surface; aggregate only labelled results. If all required units are silent and verified, return HEARTBEAT_OK.

## Unit: gateway-config-preflight
**Purpose:** detect a rejected OpenClaw configuration that would suppress all heartbeats.
**Trigger:** every heartbeat pass, before any other unit.
**Inputs and state:** gateway config and openclaw cron list stderr. A config backup may be created only for the documented invalid-heartbeat error; no incident-state write is owned here.
**Action boundary:** run config validation. On agents.list.<N>.heartbeat: Invalid input, preserve a timestamped backup and report the block to Tom for approval. For any other config error, report it. Never auto-fix or restart the gateway.
**Output contract:** silent on success; one direct Tom notification on a config error. This unit must not emit an incident-queue result.
**Stop condition:** one validation and, on failure, one bounded notification; stop before the incident unit.
**Growth trigger:** move to a diagnostic cron if validation needs independent retries or exceeds the heartbeat budget.

## Unit: incident-queue
**Purpose:** investigate and safely advance newly evidenced system-health incidents.
**Trigger:** every pass when the daily-review pointer identifies fresh system-health failures.
**Inputs and state:** brain/state/lox-latest-daily-review.txt, the canonical daily review fallback, and brain/state/lox-incident-state.json read only through the bounded `cd ~/.openclaw/workspace && python3 infra/lox_incident_state.py summary` or the anchored cross-agent roll-up `cd ~/.openclaw/workspace/codebases/sindustries && python3 -m agents.lib.incident_queue`. Task gates, QA, delivery evidence, attention-owner routing, and ordinary handoffs stay in Tasks API state and are never written here.
**Action boundary:** read infra/RUNBOOKS.md, derive stable keys, skip resolved/future-retry entries, run only a safe indexed runbook, verify it, and update canonical incident fields. Follow incident-author, keep live state bounded, and archive running prose. Escalate repair attempts, blocked repairs, unsafe fixes, and unknown owners to Tom or the responsible agent. Infrastructure uptime is Lox's concern; Quinn's heartbeat does not manage infrastructure.
**Output contract:** silent for a verified empty queue or healthy resolved item; one incident-labelled Tom/owner notification only when the skill requires escalation. If the incident-queue CLI exits `3`, the registry was not read (unreadable/malformed state file, missing registry directory, or an iCloud-evicted dataless placeholder) — this is UNVERIFIED, not a clean/empty result: still report the counts and the `Top unblock` for the records that did load (they must still be reported, never withheld pending a re-run), add the UNVERIFIED banner naming the offending path, and run `brctl download <path>` so the next pass reads verified. Never fall back to the raw state file to make an UNVERIFIED read go away.
**Stop condition:** one safe repair/verification or one newly evidenced blocker per incident, bounded by the pass budget; do not sweep when there are no fresh open system incidents.
**Growth trigger:** promote to a dedicated incident cron when cadence, retries, or queue volume regularly consumes the heartbeat; use a workflow when multiple incident crons need ordered state transitions.

## Unit: attention-owner-pages
**Purpose:** handle Lox-owned task attention pages without confusing them with incidents.
**Trigger:** the unified queue returns an actionable attentionPage for Lox.
**Inputs and state:** the unified queue via `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/tasks-api/scripts/agent_task_queue.py --assignee Lox --attention-owner Lox`, which surfaces these as `kind: "attentionPage"`, classification `ACTIONABLE`; task comments. Task state is owned by Tasks API. Use attention-owner-routing for reason-bearing self-resolve or handoff.
**Action boundary:** read the task, answer or act, post the required comment, and remove only Lox from the attention stack while preserving co-owners. Never use full-stack clear, direct curl, or the incident-state file.
**Output contract:** the task comment and routing mutation are the output; no incident notification is emitted unless the incident unit independently found one.
**Stop condition:** one top attention page per pass, or the first API/external blocker.
**Growth trigger:** extract a cron if pages arrive on a distinct cadence; create a workflow only when page ordering and retries need durable sequencing.

## Unit: peer-heartbeat-staleness
**Purpose:** detect native heartbeat sessions that have stopped receiving scheduled turns.
**Trigger:** every pass after incident/task routing, using live heartbeat cadence and isolatedSession from gateway config.
**Inputs and state:** agent heartbeat configuration and session metadata. For isolated agents inspect the latest heartbeat session; otherwise inspect the main session. This unit only reports; it does not restart gateways or edit configuration.
**Action boundary:** compare session age with three cadence intervals, verify provider, and distinguish claude-cli (which receives no native heartbeat) from gateway-provider failure. Report the recovery recommendation to Tom. Use a direct bounded filesystem read for brain health; brctl status alone is not evidence. Optional existence probes must tolerate expected missing paths.
**Output contract:** silent when sessions are fresh; one labelled Tom report per newly evidenced stale session. Do not write incident state unless incident-author independently classifies it.
**Stop condition:** one bounded session census and one report for the first newly evidenced stale condition.
**Growth trigger:** promote to monitoring cron if peer census needs independent cadence or retries; use a workflow only if recovery requires ordered cross-agent actions.

## Unit: retro-notes-scan
**Purpose:** record recurring operational friction for the weekly factory-retro pass.
**Trigger:** after other units, only when the same failure or remediation pattern recurs for the second or later time.
**Inputs and state:** today's brain/ops/retro-notes/YYYY-MM-DD.md; use retro-notes and do not duplicate an existing weekly slug.
**Action boundary:** append one evidence-backed observation with runbook path and incident key. Do not create tasks or alter incident state directly.
**Output contract:** silent on no new pattern; one labelled retro-note artifact when a new pattern is recorded.
**Stop condition:** at most one bounded note per pass.
**Growth trigger:** promote to a cron when the scan needs its own cadence; use a workflow only if several retro sources need ordered aggregation.

## Shared failure policy
Read and follow notify-soft-fail, incident-author, and retro-notes. Never reset, migrate, seed, or delete databases; kill listeners; run updates; or restart the gateway from heartbeat. If a safe repair does not match the evidence, report and stop.
