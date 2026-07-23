---
status: draft
task_id: f170e344-ea5f-4443-bebb-035948686fc1
product_spec: brain/tasks/specs/in-progress/post-merge-feature-factory-analytics.md
shipped_pr: null
shipped_date: null
---

# Post-Merge Feature Factory Analytics — tech design

## Links

- Product spec: `brain/tasks/specs/in-progress/post-merge-feature-factory-analytics.md`
- Task: `f170e344-ea5f-4443-bebb-035948686fc1` (`Post-Merge Feature Factory Analytics`)
- Tasks API record: `http://localhost:4001/api/v1/tasks/f170e344-ea5f-4443-bebb-035948686fc1`
- Feature Factory v2 design: `docs/specs/feature-factory-v2-tech-design.md`
- Existing workflow: `agents/workflows/feature-task/`
- Existing flow dashboard helpers: `apps/mission-control/src/flowMetrics.js`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-f170e344-post-merge-feature-factory-analytics`
- Worktree: `/Users/quinnstoffer/workspaces/rowan/sindustries-task-f170e344-post-merge-feature-factory-analytics`
- No secondary repo changes expected.

## Product intent

The task describes the desired outcome as:

> After a feature task reaches its terminal state (done or accepted), durable analytics events are emitted for the task lifecycle. Tom and Quinn can see weekly trends of gate failure rates split by cause (quality vs capacity), PR cycle times, and evidence-type distribution — and can drill down into any task to replay its gate failure sequence.

The implementation should turn feature-task workflow decisions that currently exist only as task comments and transient Lobster output into a durable, queryable event stream. Mission Control then renders weekly trends on the existing Flow Metrics dashboard, and Quinn gets a single replay command for debugging one task lifecycle.

## Source-read note

The product spec path is iCloud-backed under `brain/`; this agent hit macOS `Operation not permitted` when reading the file directly. The task record includes the rebuilt spec-derived intent, ACs, checksum, and Rowan workstream, so this design is grounded on that record plus current repo inspection.

## Service boundary and data ownership

- The Tasks API owns feature-task lifecycle analytics because it already owns task state, comments, tags, timestamps, and workflow-facing task reads/writes.
- The Feature Factory Rust CLI (`agents/workflows/feature-task/src/main.rs`) emits analytics events during workflow gate evaluation and terminal transition handling.
- Mission Control is a read-only analytics consumer through Tasks API endpoints. It must not infer lifecycle events from raw comments when first-class analytics events exist.
- GitHub remains the source for PR timestamps and review/evidence details. The terminal summary stores a snapshot so historical dashboard numbers do not change if GitHub metadata changes later.
- Extraction plan: if analytics outgrow Tasks API, keep the API response shapes stable and move the event store behind those routes.

## `.openclaw` boundary

- No `.openclaw/` config, cron, or agent profile changes are required for the repo implementation.
- If Quinn wants the replay command wired into a personal alias or OpenClaw prompt later, that is an `[openclaw-needed]` follow-up outside this PR.
- The workflow writes analytics only through `TASKS_API_BASE_URL`; no direct writes to private memory/session logs.

## Acceptance criteria recap

- **AC1:** Every time a feature task transitions to `done` or `accepted`, emit a single lifecycle event capturing task ID, completion timestamp, total gate failure count, capacity block count, quality failure count, PR cycle time, and evidence-type distribution.
- **AC2:** Every individual gate failure during a task lifecycle emits a separate event identifying the gate and whether the cause was capacity or quality.
- **AC3:** Events are durable and queryable by task ID and by week, so any task lifecycle can be replayed from raw events in chronological order.
- **AC4:** A dashboard panel exists on the flow dashboard showing the weekly trend of gate failure rate with a stacked split between quality and capacity causes.
- **AC5:** Quinn can request an ad-hoc lifecycle replay for any task ID via a single command and receive its events in order.

## Implementation plan

### Tasks API data model

Add a Prisma model and migration for immutable-ish analytics events. Events are append-only except for idempotent upsert by `eventKey`.

```prisma
model FeatureTaskAnalyticsEvent {
  id                     String   @id @default(uuid()) @db.Uuid
  taskId                 String   @db.Uuid
  eventKey               String   @unique
  eventType              String   // gate_failure | terminal_summary
  gate                   String?  // spec_check | ready_checks | verify_delivery | feedback_aggregate | post_merge
  cause                  String?  // capacity | quality
  message                String?
  occurredAt             DateTime @default(now())
  terminalStatus         String?  // done | accepted
  completionTimestamp    DateTime?
  totalGateFailureCount  Int?
  capacityBlockCount     Int?
  qualityFailureCount    Int?
  prCycleTimeSeconds     Int?
  evidenceTypeDistribution Json?
  details                Json?
  createdAt              DateTime @default(now())

  task Task @relation(fields: [taskId], references: [id], onDelete: Cascade)

  @@index([taskId, occurredAt])
  @@index([occurredAt])
  @@index([eventType, occurredAt])
}
```

Also add `analyticsEvents FeatureTaskAnalyticsEvent[]` to `Task`.

Idempotency keys:

- Gate failure: `feature-task:{taskId}:{gate}:{sha256(failureText)}:{failureOrdinalWithinRunOrStableField}`.
- Terminal summary: `feature-task:{taskId}:terminal:{terminalStatus}`.

The terminal summary must be a single event per task terminal status. Re-running `post_merge` after a task is already done should update/return the same terminal event, not create duplicates.

### Tasks API routes

Add routes in `services/tasks-api/src/routes/tasks.ts` or a new router mounted under `/api/v1/feature-task-analytics`.

Write route used by workflow:

- `POST /api/v1/feature-task-analytics/events`
  - Accepts either one event or `{ events: [...] }` for safe batching.
  - Validates `taskId` as a full UUID.
  - Validates `eventType` and `cause` enums.
  - Uses `upsert` on `eventKey`.
  - Returns `{ data: { created, updated, events } }`.

Read routes used by dashboard/replay:

- `GET /api/v1/feature-task-analytics/tasks/:taskId/events`
  - Returns raw events ordered by `occurredAt`, then `createdAt`.
- `GET /api/v1/feature-task-analytics/weekly?weeks=8`
  - Returns weekly buckets with:
    - `weekStart`
    - `terminalTaskCount`
    - `taskWithFailureCount`
    - `gateFailureCount`
    - `capacityFailureCount`
    - `qualityFailureCount`
    - `gateFailureRate` (`tasks with >=1 gate failure / terminal tasks`, null when denominator is 0)
    - `medianPrCycleTimeSeconds`, `p90PrCycleTimeSeconds`
    - `evidenceTypeDistribution`

Week bucketing should use the same Monday-start convention as `flowMetrics.isoMonday()` so dashboard metrics align.

### Workflow emission in Rust CLI

Add an analytics module inside `agents/workflows/feature-task/src/main.rs` or split to `src/analytics.rs` if the file gets too large.

Core helpers:

- `classify_failure(gate: &str, failure: &str) -> FailureCause`
  - `capacity` for implementer capacity, dependency capacity, and explicit capacity block failures.
  - `quality` for missing tech design, missing approval, missing assignee, missing PR evidence, CI/check failures, review changes requested, stale/missing system spec, spec drift, malformed PR body, and all other gate-quality failures.
  - Default unknown to `quality` so dashboards do not undercount quality gates.
- `emit_gate_failure_events(args, task, gate, failures)`
  - Called before/after the existing blocked-comment write in `spec_check`, `ready_checks`, `verify_delivery`, `feedback_aggregate`, and `post_merge` whenever `failures` is non-empty.
  - Emits one event per failure string.
  - Does not fail the workflow if analytics POST fails; instead include a warning in `action_taken` or stderr so task progression is not blocked by analytics observability.
- `emit_terminal_summary_event(args, env, terminal_status)`
  - Called after successful move to `done`; if an `accepted` terminal state is introduced later, call it at that transition too.
  - Queries existing analytics events for the task, counts gate failures by cause, computes PR cycle time and evidence distribution, and posts/upserts the terminal summary.

Current schema only has `TaskStatus.done`, not `accepted`. For AC compatibility, model `terminalStatus` as a string and support `accepted` in validation even if current workflow only emits `done`.

### PR cycle time and evidence distribution

PR cycle time:

- Use `env.lobster_state.pr_urls` / `[rowan-prs]` URLs.
- Query GitHub for each PR's `createdAt`, `mergedAt`, and `closedAt` using the existing GitHub helper patterns already used by `verify_delivery` / `post_merge`.
- For one or more PRs, define cycle time as `latest mergedAt - earliest createdAt` in seconds.
- Store `null` if there are no PRs or GitHub metadata cannot be read; add an error detail but still emit the terminal event.

Evidence distribution:

- Parse merged PR bodies for checked AC lines and evidence markers.
- Count common evidence labels case-insensitively: `e2e`, `integration`, `component`, `unit`, `file`, `manual`, `screenshot`, `logs`, `ci`, `system-spec`, `no-system-spec-change`.
- If no evidence label is detected for a checked AC, count `unspecified`.
- Store JSON like `{ "unit": 2, "integration": 1, "e2e": 1, "manual": 1 }`.
- Keep this parser local and well-tested; do not change the PR body checklist rules in this feature.

### Mission Control dashboard

Extend the existing Flow Metrics tab rather than adding a new tab.

Files:

- `apps/mission-control/src/tasksApi.js`
  - Add `fetchFeatureTaskAnalyticsWeekly({ weeks })` and `fetchFeatureTaskAnalyticsReplay(taskId)`.
- `apps/mission-control/src/flowMetrics.js`
  - Add pure helpers for formatting weekly analytics, stacked quality/capacity series, failure-rate labels, and evidence distribution summaries.
- `apps/mission-control/src/FlowMetricsPanel.jsx` or the current flow metrics component file if metrics live inline.
  - Add a panel titled “Feature Factory analytics”.
  - Show weekly gate failure rate with stacked capacity vs quality counts.
  - Show PR cycle time summary and evidence distribution for the selected week/window.
  - Empty state: “No feature-task lifecycle analytics yet.”
- `apps/mission-control/src/flowMetrics.test.js`
  - Add helper tests for week sorting, rates, stacked counts, sparse weeks, and evidence distribution merging.
- `apps/mission-control/src/App.test.jsx` or component tests
  - Verify the flow dashboard renders the new panel and empty state / fixture state.

The panel can be simple semantic HTML/CSS. A full charting library is not necessary; stacked horizontal bars are enough for AC4.

### Replay command

Add one single command for Quinn:

- Preferred: extend the Rust CLI with `analytics-replay --base-url http://localhost:4001/api/v1 --task-id <uuid>`.
- Wrapper: `agents/workflows/feature-task/scripts/replay_lifecycle.py --task-id <uuid>` may call the API and format the output if faster to maintain.

Output should be chronological and human-readable, for example:

```text
Task f170e344-ea5f-4443-bebb-035948686fc1 lifecycle replay
2026-07-23T05:10:00Z ready_checks quality Missing task comment [tech-design] <url>
2026-07-23T05:12:00Z ready_checks capacity Rowan already has an unblocked doing task ...
2026-07-24T02:30:00Z terminal_summary done total=2 capacity=1 quality=1 prCycle=4h12m evidence={unit:3,e2e:1}
```

Add tests for JSON parsing and output ordering. The command should exit non-zero only for invalid task IDs, unreachable API, or malformed API response; “no events” is a successful empty replay.

### Workflow, cron, and skill changes

- No cron schedule changes required; the existing feature-task workflow emits analytics as it runs.
- No skill changes required for this feature.
- Update `docs/systems/feature-factory.md` if it exists, or create/update the relevant system doc on implementation ship, to describe analytics event emission and replay.

## Test plan

### Tasks API tests

- Prisma/schema validation for `FeatureTaskAnalyticsEvent`.
- Route tests:
  - POST creates a gate failure event.
  - POST batch upserts duplicate `eventKey` without duplicate rows.
  - POST rejects malformed task IDs and invalid cause/event type.
  - GET by task returns chronological raw events.
  - GET weekly returns Monday-start buckets, split quality/capacity counts, failure rate, PR cycle stats, and evidence distribution.

### Rust workflow tests

- `classify_failure` maps capacity strings to `capacity` and representative quality strings to `quality`.
- Gate commands emit one event per failure while preserving existing blocked behaviour.
- Analytics POST failure does not turn a workflow decision into a failed task transition.
- Terminal summary is idempotent and includes counts derived from raw gate failure events.
- PR cycle time handles one PR, multiple PRs, missing metadata, and unmerged PRs.
- Evidence parser counts known evidence markers and `unspecified` fallback.

### Mission Control tests

- Pure helper tests for weekly trend formatting, stacked split totals, rates with zero denominators, and evidence distribution labels.
- Component tests for loading, empty, populated, and error states of the Feature Factory analytics panel.

### Replay tests

- Command prints raw events in chronological order.
- Command handles no events cleanly.
- Command validates full UUID input and reports API errors clearly.

### AC verification matrix

| AC | Verification layer | Planned evidence |
|---|---|---|
| AC1 | Rust workflow + API route tests | Successful terminal transition emits/upserts one `terminal_summary` event with task ID, completion timestamp, failure counts, PR cycle time, and evidence distribution. |
| AC2 | Rust workflow tests + API route tests | Each gate failure string from ready/verify/post-merge paths produces a distinct `gate_failure` event with `gate` and `cause` (`capacity` or `quality`). |
| AC3 | API integration tests + replay command tests | Events persist in Postgres and can be queried by task ID and weekly buckets; replay command prints raw events in chronological order. |
| AC4 | Mission Control component tests | Flow dashboard renders a Feature Factory analytics panel with weekly gate failure rate and stacked quality/capacity split using fixture data. |
| AC5 | CLI/script tests | `analytics-replay --task-id <uuid>` or `scripts/replay_lifecycle.py --task-id <uuid>` returns the ordered lifecycle replay for any task ID. |

## Open questions and risks

- **Spec path mismatch history:** earlier task comments said the spec lived under `brain/tasks/specs/open/`; the current task description and user request point to `in-progress/`. Keep the frontmatter on the current task path unless Quinn corrects it before approval.
- **Accepted vs done:** current Tasks API status enum has `done`, not `accepted`. The event schema should allow `accepted` as a terminal string for forward compatibility, but implementation will likely emit `done` only unless another workflow has an accepted terminal state.
- **Double-counting failures:** workflow reruns can report the same failure repeatedly. Stable `eventKey` upserts prevent duplicate rows for the same gate/failure text, but if the text changes slightly the event will be counted as a new failure. This is acceptable for v1 because changed text usually indicates a distinct failure presentation; if noisy, normalize failure fingerprints later.
- **Analytics availability:** analytics emission should never block task progression. Missing analytics events are observability defects, not workflow blockers; tests should cover this fail-open behaviour.
- **Dashboard scope:** keep AC4 to one focused panel on the existing Flow dashboard. Do not build a full drilldown UI unless needed beyond the replay command.
