# HEARTBEAT.md — Ivy

Scope: polling cadence, discovery triggers, campaign selection, and bounded handoff. Execution mechanics live in WORKFLOW.md and linked skills. Ivy never changes task status; the Lobster owns transitions.

## Scheduler policy
- Fresh pass: run the unified Tasks API queue before any silent result, then evaluate the independent growth check.
- Order: content-task discovery, one content action/campaign pass, growth research/campaign check, retro-notes scan.
- Budget: one top queue candidate and one bounded campaign/research action per pass.
- Action cap: never roam or process a second candidate merely because time remains.
- Concurrency: queue discovery is read-only; authoring, scheduler writes, and task comments are serialized.
- Exhaustion: record a bounded skip for remaining work without claiming clean completion.
- Final output: keep task, scheduler, escalation, and retro outputs separate; return HEARTBEAT_OK only after required discovery and safe skips.

## Unit: content-task-discovery
**Purpose:** discover and advance Ivy's assigned content work and routed PR/merge items.
**Trigger:** every heartbeat pass.
**Inputs and state:** the unified queue command, Tasks API task state, PR metadata, and WORKFLOW.md. The queue is read-only and must include assigned tasks, attention pages, review requests, authored-PR feedback/conflicts, and merge candidates.
**Action boundary:** load environment from ~/.openclaw/.env, run the shared classifier, hydrate the deterministic top candidate, and take one concrete action through WORKFLOW.md or pr-process. Respect ACTIONABLE, acceptance, BLOCKED, and DEPENDENCY_BLOCKED branches. Never patch task status, close a PR, or merge without workflow approval gates.
**Output contract:** tangible progress for an actionable item; silent only when queue is empty or documented safe wait applies. External failures use notify-soft-fail and stop the task rather than generating placeholders.
**Stop condition:** one top candidate or first external blocker; do not return silence before the queue query succeeds.
**Growth trigger:** move queue sweep to a special cron if runtime regularly consumes the heartbeat; use a workflow when queue classes need serialization.

## Unit: weekly-tweet-campaign
**Purpose:** queue the weekly content campaign while a qualifying weekly task is doing and lacks [ivy-tweets-queued].
**Trigger:** title contains weekly review or weekly content updates, status is doing, and the gate comment is absent. Existing [ivy-prs] suppresses only PR authoring.
**Inputs and state:** linked weekly review under brain/content/sindustries-weekly-content/, scheduler API, task comments, and schedule-tweets/schedule-tweet-thread. The campaign owns queued IDs and exactly one [ivy-tweets-queued] traceability comment; it does not own task status.
**Action boundary:** read the whole review, choose one strongest theme, and classify units as genuine 2–7 part threads only when all five sequential-story conditions hold; otherwise use independent standalones. Apply sindustries-copy and no-ai-slop, write as Tom in first person, keep every post at most 280 characters, schedule at 10:00 Pacific/Auckland with the correct NZ offset, and queue only queued items. Aim for 3–6 strong units without filler or duplicate thread parts. Use the matching scheduling skill for queue mechanics, capture IDs, and post one traceability comment tagging each item single or thread with N parts and its purpose. Missing review or scheduler failure uses notify-soft-fail and aborts this unit.
**Output contract:** one traceability task comment after all queued units succeed; scheduler items are the owned artifacts. No partial success claim, no published status, and no output when the idempotence gate already exists.
**Stop condition:** one campaign for the current weekly task, bounded to 3–6 units and 2–7 parts per thread; stop on first external failure.
**Growth trigger:** promote to weekly isolated cron if campaign drafting regularly consumes this heartbeat; create a workflow if campaign queueing and approval/publishing need ordered retries.

## Unit: growth-research-check
**Purpose:** identify a due Money-or-Users initiative research or campaign pass.
**Trigger:** after content work, when an initiative is new, Tom/bookmarks provide a relevant signal, research is stale by roughly two weeks, or no higher-priority work remains.
**Inputs and state:** strategy-graph.md, initiative research files, bookmarks, and WORKFLOW.md Growth Research & Campaigns. Outputs belong in the appropriate initiative artifact; Ivy does not edit strategy status/tags or make external contact.
**Action boundary:** check active Money-or-Users initiatives, run one due research/campaign pass through the workflow, and write a concrete finding or route a task. Do not manufacture work.
**Output contract:** report only a written/updated research artifact or a specific Tom decision request; otherwise silent.
**Stop condition:** one initiative per pass or first external blocker.
**Growth trigger:** promote to a separate research cron when cadence diverges from content polling; use a workflow when research, campaign, and approval steps need serialization.

## Unit: retro-notes-scan
**Purpose:** capture recurring content/growth friction for factory-retro.
**Trigger:** after other units when the same friction or working practice appears for the second or later time.
**Inputs and state:** today's brain/ops/retro-notes/YYYY-MM-DD.md; use retro-notes and deduplicate by pattern slug.
**Action boundary:** append one concrete observation with evidence and suggested action; never duplicate a slug or create a task directly.
**Output contract:** silent unless a new retro row is written.
**Stop condition:** one bounded note per pass.
**Growth trigger:** spin out a cron when the scan needs independent cadence or aggregation.

## Shared failure policy
Follow notify-soft-fail for external API, auth, quota, and service failures and stop the affected unit. Never patch task status, close a PR, or emit degraded placeholder content.
