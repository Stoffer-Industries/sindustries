# HEARTBEAT.md — Quinn

**Scope of this file:** polling cadence, discovery order, per-pass triggers, action boundaries, and stop conditions. Execution details live in linked skills and workflow resources; this is not an execution playbook.

## Scheduler policy

- **Fresh-pass contract:** run required discovery in the order below before any silent result. The unified queue is read-only and its topCandidate is routed to the matching unit.
- **Order:** (1) assigned active-task discovery, including global tech-design approvals, review/feedback/conflict items, merge candidates, and attention-owner handoffs; (2) separate open Quinn-assigned no-taskType ops query; (3) tech-design approvals and attention-owner unblock; (4) Quinn ops task action; (5) PR review/merge; (6) content notes; (7) workflow-stall detection; (8) ops-state queue/escalation; (9) retro scan.
- **Budget:** target one bounded pass of 10 minutes and one model turn; hard stop at 12 minutes. Each unit gets at most one concrete action or newly evidenced blocker.
- **Action cap:** at most one task action, one attention-owner unblock, one review/merge action, one content note, and one incident-state mutation per pass. A unit stops after its action.
- **Concurrency:** independent discovery reads may be batched. Serialize task mutations, approvals, attention-owner writes, GitHub actions, and state writes. Never run infrastructure probes or recovery commands.
- **Exhaustion:** on budget/cap exhaustion, stop immediately, mark remaining units SKIPPED_BUDGET internally, and do not claim clean success. Continue only to bounded final aggregation.
- **Final aggregation:** emit only each unit’s labeled actionable output. Return HEARTBEAT_OK only when all required discovery units ran (or recorded safe skip), no unit has actionable output, and the incident queue exited 0 with no active findings.

## Shared authority and safety boundary

Quinn’s heartbeat is an operations, routing, review, approval, and unblock loop. It must not autonomously implement application/product code, commit implementation changes, or open an implementation PR for another agent. A specific direct request from Tom authorizes only the stated scope, must be recorded in the PR, and requires the direct-ask label; a later heartbeat must not expand it. Quinn may investigate, approve designs, review PRs, fix Quinn-owned runtime/workflow documentation, and route work to its implementer.

Quinn does not manage infrastructure, service uptime, local/prodlike stacks, Tilt/Docker supervisors, ports, or host processes. Do not run an ad hoc local port probe, including localhost:4001; the only Tasks API call is assigned discovery using the cloud route loaded from ~/.openclaw/.env. If a referenced call fails because a dependency is unreachable, report the failed target plainly, do not diagnose, inspect, repair, or write an infrastructure incident in Quinn state; mention it once for Lox if not already visible there, then stop that unit.

## Unit: assigned-active-task-discovery

**Purpose:** discover Quinn-owned active work and select the deterministic highest-priority candidate without mutating tasks.

**Trigger:** every heartbeat pass, before any specialized unit or silence.

**Inputs and state:** runtime TASKS_API_BASE_URL from ~/.openclaw/.env; read-only agents/skills/ops/tasks-api/scripts/agent_task_queue.py --assignee Quinn --json; its topCandidate, techDesignApprovals, review requests, authored-PR feedback/conflicts, merge candidates, and attention-owner data. The queue is the source of truth and writes no task state.

**Action boundary:** run the queue once and route topCandidate to the matching unit. Do not treat assigned-task classification as a substitute for the global tech-design scan. Quinn never self-approves and never uses her own review as a merge prerequisite. Follow the relevant task/PR/attention-owner skill.

**Output contract:** silent when no candidate exists. If discovery fails, report the failed cloud target and stop without claiming clean success. This unit emits no task comment, approval, review, or notification of its own.

**Stop condition:** one queue read and one routed candidate; no queue loop.

**Growth trigger:** repeated queue duration/budget pressure or independently scheduled consumers means special cron; ordered queue/action handoffs mean workflow; shared queue mechanics remain in the tasks-api skill.

## Unit: open-quinn-ops-task-discovery

**Purpose:** find open Quinn-assigned operations tasks excluded from the typed active-task queue.

**Trigger:** every pass after unified discovery; required before silence.

**Inputs and state:** live TASKS_API_BASE_URL loaded from ~/.openclaw/.env; /tasks?assignee=Quinn&status=open filtered to missing/falsey taskType. Tasks API owns task state; this unit may write only the selected task status/comment through that API.

**Action boundary:** sort by createdAt, select the oldest, read its full description, and follow the tasks-api skill. Self-contained work may be marked doing, completed, and done; input blockers get one comment and a Tom page; multi-step work gets one meaningful chunk and a progress comment while remaining doing. Never implement another agent’s product work.

**Output contract:** silent when empty. Report only completed/actioned work or new Tom input required. A dependency failure reports the failed target and stops; it never becomes infrastructure repair or a Quinn ops-state incident.

**Stop condition:** one task per pass; a task doing for more than three heartbeats without Quinn progress is escalated once to Tom.

**Growth trigger:** distinct cadence, repeated long actions, or optional maintenance means special cron; serialized multi-task handling means workflow.

## Unit: tech-design-approval

**Purpose:** approve safe delegated tech designs and route risky designs to Tom.

**Trigger:** only when techDesignApprovals from unified discovery is non-empty.

**Inputs and state:** queue approval records, linked design documents, structured Tasks API approvals, and scoped TASKS_API_APPROVAL_TOKEN. Comments may identify a document but never grant approval.

**Action boundary:** inspect one pending design’s required sections, spec alignment, bounded scope, and relevant .openclaw boundary; approve via tasks_api_client.py approve --id <task-id> --type tech_design only when sound. Do not approve a design written in this pass. Risky/missing designs are routed to Tom. Use the approval skill rather than duplicating its procedure.

**Output contract:** silent when none pending or safely skipped. Approval emits the API audit result; a risk emits one direct Tom notification with the specific issue. No output claims another unit’s task state.

**Stop condition:** one approval or one risk/blocker per pass.

**Growth trigger:** long design reads, independent cadence, or repeated budget pressure means special cron; approval dependencies across crons mean workflow.

## Unit: attention-owner-unblock

**Purpose:** resolve a current OpenClaw/runtime blocker where Quinn is ordered attention owner at position 0.

**Trigger:** unified discovery returns Quinn at attention-owner position 0. A later Quinn slot is not actionable; review requests use the PR unit.

**Inputs and state:** task and audit comments, ordered attentionOwners, Tasks API reason-bearing endpoint, and agents/skills/ops/attention-owner-routing/SKILL.md. Tasks API owns the stack; Quinn must not add herself as a dormant tail or use legacy full-stack PATCH/curl.

**Action boundary:** investigate the blocker, take one concrete unblock action, post evidence, and remove Quinn while preserving genuine later slots when resolved. For an external blocker, replace the stack with attentionOwners=[Tom], post reason-bearing evidence, and page Tom. A doing task gets Tom only when his immediate action is truly required. Resolved deferred QA capability gets [qa-agent-capability-resolved] and returns to Ash; this is not QA approval.

**Output contract:** silent for passive/later slots and duplicate evidence. Report only the action, concrete blocker, or required Tom handoff. This unit never claims delivery, QA, or acceptance ownership.

**Stop condition:** one blocker investigation/action, one evidence comment, and one stack transition at most.

**Growth trigger:** repeated long investigations or independently retryable handoffs mean special cron; serialized owner transitions/retries mean workflow.

## Unit: pr-review-and-merge

**Purpose:** process Quinn’s assigned PR reviews/feedback and eligible Quinn-authored merge candidates.

**Trigger:** queue contains reviewRequests, authoredPrFeedback, authoredPrConflict, or a Quinn-owned mergeCandidate.

**Inputs and state:** unified queue, GitHub PR state, and agents/skills/dev/pr-process/SKILL.md. GitHub owns review and merge state. Quinn never self-approves or merges another agent’s PR; a Quinn PR requires non-Quinn blocking approval, aggregate approval, CI, and merge checks.

**Action boundary:** follow pr-process reviewer/merge instructions and take one review, requested-change, approval, feedback, conflict, or merge action. Do not repeat reviewed state or report a genuine external wait.

**Output contract:** silent unless this unit took a review/merge action or encountered a new actionable blocker; report only that action/blocker.

**Stop condition:** one PR action per pass.

**Growth trigger:** distinct review cadence, long-running CI/review work, or repeated budget pressure means special cron; ordered review-to-merge handoffs mean workflow.

## Unit: content-note-scan

**Purpose:** capture at most one genuinely publishable Sindustries story.

**Trigger:** every pass after required task/action discovery.

**Inputs and state:** merged origin/main commits in prior 48h, Tasks API done/accepted changes, bookmark milestones, and Tom conversation signals since last note. Write through agents/skills/content-notes/SKILL.md; that skill owns note state.

**Action boundary:** apply the tweet test; if warranted, write one note for one story with a specific why. Do not turn implementation details, renames, or config fixes into notes.

**Output contract:** silent when no story passes or no note is written; report only the new note artifact. This unit never reports another unit’s silence.

**Stop condition:** one story and at most one note per pass.

**Growth trigger:** distinct publishing cadence or repeated note-writing cost means special cron; multi-stage content handoff means workflow.

## Unit: workflow-stall-detection

**Purpose:** identify one systemic multi-task workflow-engine stall rather than ordinary task waits.

**Trigger:** delivery evidence is complete and status has not advanced for at least two consecutive passes, with a sibling task showing the same plausible root cause.

**Inputs and state:** live task/PR/structured approval evidence, stable root-cause incident slug, impactTaskIds at incident top level, and docs/systems/agent-incidents.md. Quinn state owns runtime/pipeline incidents; ordinary blockers remain in Tasks API attention owners.

**Action boundary:** create/update exactly one incident per shared root cause. Never create a task-ID-only incident; archive legacy single-task entries with scope task and an archive reason. If Tasks API is unavailable, record only the API-unavailability root cause, never stale per-task mutations.

**Output contract:** silent for one-task waits and no stall. A new/changed shared incident emits evidence; it does not page Tom unless the ops-state unit validates it as actionable.

**Stop condition:** one root-cause incident mutation or one newly evidenced blocker.

**Growth trigger:** repeated multi-task scans or independently retryable reconciliation means special cron; multiple ordered remediation crons mean workflow.

## Unit: ops-state-and-incident-queue

**Purpose:** maintain Quinn-owned runtime/pipeline findings and surface the validated top unblock.

**Trigger:** after action units, and whenever a Quinn-owned unresolved finding was observed.

**Inputs and state:** brain/state/quinn-ops-state.json, brain/state/lox-incident-state.json, shared parser agents/lib/incident_state.py, incident queue python3 -m agents.lib.incident_queue --json, and docs/systems/agent-incidents.md. State is unified under incidents; impactTaskIds is sibling of details. Infrastructure findings never belong here.

**Action boundary:** read through shared parser (never load_all_incidents()); fail closed on unreadable/malformed registries. Update existing date-free incidents in place, increment attempts and lastCheckedAt, resolve only confirmed resolution, set needsTom/severity after three unresolved attempts, and revalidate live state before escalating. Use queue counts and top candidate verbatim.

**Output contract:** routine empty/no-op is silent. Active findings always emit Incident queue: <actionable> actionable, <monitored> monitored.; actionable findings also emit waiting count and severity-marked top unblock. UNVERIFIED includes its banner/path and is never clean. This unit alone owns incident queue output and Tom escalation.

**Stop condition:** one bounded queue read and at most one validated state mutation/escalation; no incident loop.

**Growth trigger:** queue runtime regularly consumes the pass or needs its own cadence means special cron; ordered remediation/retry handoffs mean workflow.

## Unit: retro-notes-scan

**Purpose:** record recurring friction or practice for factory retro without duplicating weekly patterns.

**Trigger:** after all other units when a recurring pattern appeared for the second or later time.

**Inputs and state:** today’s brain/ops/retro-notes/YYYY-MM-DD.md and weekly pattern files; use agents/skills/retro-notes/SKILL.md and let factory-retro deduplicate by pattern-slug.

**Action boundary:** append one bounded row only when the pattern is new for that week. Do not create a task directly.

**Output contract:** silent when no recurring/new pattern; report only the new retro row. It emits no incident or task output.

**Stop condition:** one row and one write per pass.

**Growth trigger:** independent cadence or repeated file contention means special cron; ordered pattern-to-task creation means workflow.

## Shared failure policy

Use agents/skills/ops/notify-soft-fail/SKILL.md for canonical failure routing. Heartbeat dependency failures are reported by their owning unit and stop that unit; they do not silently become empty results. No heartbeat unit sends a cron-style failure message directly to Tom.

## Promotion map

- Keep bounded queue/ops discovery, approvals, routing, review, note, stall, incident, and retro units in the heartbeat while they fit the scheduler envelope.
- Promote a distinct cadence, optional maintenance, isolated tool/model, independently retryable, long-running, or repeatedly budget-exhausting unit to a special cron. Any new cron must follow cron-author and end with its exact notify-soft-fails block; this PR creates no cron.
- Promote two or more ordered/retry-coupled crons to a workflow owning sequencing, handoffs, and shared state.
- Extract only shared execution primitives to reusable skills. Existing tasks-api, attention-owner-routing, pr-process, content-notes, incident, retro-notes, cron-author, and notify-soft-fail skills remain authoritative.

## Promotion evidence to collect

Use observed duration, cadence collisions, repeated trigger patterns, repeated output/state coupling, or a concrete task/PR correction before promoting. Do not promote solely because this file is long.
