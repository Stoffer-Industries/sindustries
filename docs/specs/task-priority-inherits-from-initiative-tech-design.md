---
status: draft
task_id: 63ce6601-b246-470e-9dfb-adfc0de489d7
product_spec: brain/tasks/specs/open/backlog-maintenance-initiative-priority-link-2026-07-26.md
shipped_pr: null
shipped_date: null
---

# Task Priority Inherits from Initiative Score via Impact Link — Tech Design

**Task:** `63ce6601-b246-470e-9dfb-adfc0de489d7` — 🛠 Task priority inherits from initiative score via impact link (medium, `open`)
**Spec:** `brain/tasks/specs/open/backlog-maintenance-initiative-priority-link-2026-07-26.md`
**Branch:** `task-63ce6601-initiative-priority-link-tech-design`
**Worktree:** `workspace/worktrees/task-63ce6601-initiative-priority-link-tech-design`
**Repo:** `Stoffer-Industries/sindustries`
**Owner (all workstreams):** Rowan

## Product intent

After this ships, a task's `priority` badge (high / medium / low only — `urgent` stays a pure manual override) reflects the current WSJF score of the strongest active initiative behind any of its tagged impacts, recomputed automatically on every backlog-maintenance pass. Park an initiative and its downstream task tree quietly drops in priority on the next pass; nothing else about the task changes. Every priority change is auditable (which initiative + score drove it) and the pass reports counts of re-prioritised / unchanged / skipped tasks. Quoted from the task description.

The impact link is the join between the strategy layer (Initiatives + WSJF) and the task layer (individual work items). Strategy data stays single-source in `brain/sindustries/strategy-graph.md`; the algorithm reads it; nothing duplicates it.

## Service boundary and ownership

| Concern | Owner | Notes |
|---|---|---|
| `Task.impactTags` persistence + PATCH body field | `services/tasks-api` | New column on `Task`. `String[]` array of impact slugs. Distinct from the existing free-text `Task.tags` join table (`TaskTag` + `Tag`). |
| `TaskPriorityAudit` table | `services/tasks-api` | New Prisma model — one row per priority change. Immutable after insert. |
| `BacklogMaintenanceRun` table | `services/tasks-api` | New Prisma model — one row per recompute pass. Tracks pass report counters. |
| Strategy-data source-of-truth | `brain/sindustries/strategy-graph.md` (markdown) | No DB mirror; pass reads it on every run. |
| Priority-recompute script | `services/tasks-api/scripts/backlog-priority-recompute.ts` | Reads strategy-graph.md + Tasks API, writes priority changes + audit rows + run row. Idempotent. |
| Backlog-maintenance cron prompt | `agents/crons/prompts/backlog-maintenance.md` | Add a Step 8 that invokes the script. Existing steps 1–7 stay unchanged. |
| Tasks API client (Quinn / Rowan / agents) | `agents/skills/ops/tasks-api/tasks_api_client.py` | New flag `--impact-tags` on `patch`; `--clear-impact-tags` for explicit removal. |
| Tasks UI (impact-tag editing + audit visibility) | `apps/tasks` | Out of scope for this design (not in the ACs). UI can come in a follow-up. Documented in § Open follow-ups. |
| Docs update | `docs/systems/tasks.md` | New "Derived priority" section explaining the algorithm + thresholds + audit + run report. |
| Scoring method (WSJF math + impact weighting) | `agents/skills/strategy/strategy-graph/SKILL.md` | Already authoritative — this design does not change scoring, only consumes it. |

**Why `String[]` and not a `TaskImpactTag` join table?** Three reasons: (1) the impact-tag list is bounded and small (four impacts today, defined in `strategy-graph.md`); (2) the tags are immutable references to externally-defined entities, not entities in their own right — no need for a `Task` ↔ `Impact` query model; (3) the existing `tags` mechanism (free-text via `Tag` + `TaskTag`) already supports free-text labels for other purposes, and adding a third join table would clutter the schema for no gain. `String[]` keeps the schema simple, and Postgres handles a four-element array cheaply.

**Why no DB mirror of strategy-graph.md?** The strategy doc is the single source of truth per `agents/skills/strategy/strategy-graph/SKILL.md` ("The actual Impacts, Initiatives, and their current weights/status/WSJF inputs live in `brain/sindustries/strategy-graph.md` — that file is the instance data, this skill is the method."). Mirroring to a DB would create a second source of truth that can drift. The recompute script parses markdown on each pass — the strategy doc is small (a few KB), parsing is regex-based and cheap, and we get free consistency. If parsing becomes a bottleneck later, that is a separate migration task.

**Why `urgent` is preserved as a manual override?** Per AC4. The algorithm only ever writes `high | medium | low`. `urgent` is reserved for Tom's hand-driven force-through (e.g. incident response, large strategic bets WSJF would deprioritise — explicitly called out in `strategy-graph/SKILL.md`).

## Implementation plan

### WS1 — Schema + audit + run table + PATCH impact-tags field (AC1, AC6)

**`services/tasks-api/prisma/schema.prisma`** — add:

```prisma
/// First-class machine-readable impact identifiers this task is tagged with.
/// Slugs match the Impact names defined in
/// brain/sindustries/strategy-graph.md (e.g. `mornings-reclaimed`,
/// `ships-without-bottleneck`, `builder-worth-following`, `money-or-users`).
/// Distinct from `tags` (free-text `Tag` + `TaskTag` join) — those are labels
/// for human filter use; these are the join to the strategy layer.
impactTags      String[]      @default([])

/// Immutable audit row for every priority change the derived-priority
/// algorithm makes. Manual priority changes are not recorded here (the
/// Tasks API write path is the audit for those).
model TaskPriorityAudit {
  id                       String   @id @default(uuid()) @db.Uuid
  taskId                   String   @db.Uuid
  /// Snapshot of `Task.priority` immediately before the algorithm wrote.
  oldPriority              TaskPriority
  /// Snapshot of `Task.priority` immediately after the algorithm wrote.
  newPriority              TaskPriority
  /// Initiative whose WSJF score drove the change. Null when no active
  /// initiative could drive a priority — change still recorded for
  /// the AC6 audit requirement even when the algorithm cleared the badge.
  derivedFromInitiativeId  String?
  /// Human-readable Initiative name as it was at pass time. Snapshot — the
  /// strategy doc can be edited and we want the audit to show what was
  /// true at the moment of the change.
  derivedFromInitiativeName String?
  /// WSJF score of the driving initiative at pass time. Decimal rounded
  /// to two places in the snapshot.
  derivedFromScore         Decimal? @db.Decimal(4, 2)
  /// `BacklogMaintenanceRun.id` this audit row belongs to. Cascading delete
  /// is intentional — the run row already lives forever for AC7, but the
  /// audit rows per-run can be GC'd by row id if storage matters later.
  runId                    String?  @db.Uuid
  /// Free-form pass-time notes (e.g. `tie-break by initiative slug`, or
  /// the matched impact slugs). Optional.
  note                     String?
  createdAt                DateTime @default(now())

  task Task @relation(fields: [taskId], references: [id], onDelete: Cascade)
  run  BacklogMaintenanceRun? @relation(fields: [runId], references: [id], onDelete: SetNull)

  @@index([taskId, createdAt])
  @@index([runId])
  @@index([newPriority, createdAt])
}

/// One row per priority-recompute pass. The counters populate the AC7
/// pass report. `details` carries pass-time context (e.g. parsed WSJF
/// table, schema version).
model BacklogMaintenanceRun {
  id                  String   @id @default(uuid()) @db.Uuid
  startedAt           DateTime @default(now())
  completedAt         DateTime?
  /// `running | succeeded | failed`. `failed` rows still write the
  /// counters they had at failure time so the AC7 report stays accurate.
  status              String   @default("running")
  /// Strategy-doc SHA256 snapshot. Pins the audit trail to the exact
  /// markdown that drove each change — if Quinn later edits strategy-graph.md
  /// the previous audit rows still reference what was true at the time.
  strategyDocSha256   String
  repioritizedCount   Int      @default(0)
  unchangedCount      Int      @default(0)
  /// Tasks skipped because they had no impact tags, or only parked/blocked
  /// backing initiatives. Distinct from `unchanged` because the algorithm
  /// short-circuited without computing a target priority.
  skippedNoBackingCount Int    @default(0)
  /// Tasks skipped because they were `urgent` (AC4 — algorithm never
  /// touches urgent).
  skippedUrgentCount  Int      @default(0)
  /// Tasks skipped because of malformed impact tags (tag slug did not
  /// match any Initiative's impact list at parse time).
  skippedAmbiguousCount Int   @default(0)
  /// Free-form pass context: parse warnings, locked tags, exceptions.
  details             Json?
  createdAt           DateTime @default(now())

  audits TaskPriorityAudit[]

  @@index([startedAt])
  @@index([status, startedAt])
}
```

Add reverse relations: `priorityAudits TaskPriorityAudit[]` on `Task`.

Migration: `services/tasks-api/prisma/migrations/<timestamp>_priority_audit_and_run_and_impact_tags/`.

Tasks API PATCH body: add `impactTags?: string[]` (full replacement, consistent with the existing `tags` semantics). Validation:
- Each slug must match `^[a-z][a-z0-9-]{0,63}$` (kebab-case, lowercase).
- No duplicates after dedupe.
- Cap: 16 tags per task (matches the existing `tags` cap precedent in PR #403 TaskAttentionOwner).
- Tags outside this set are accepted at write time (server-side `console.warn` for unknown slugs, same pattern as `TaskAttentionOwner.owner` — see `agents/skills/dev/pr-open/SKILL.md` precedent).

Tasks API GET response: include `impactTags` on every task payload (denormalized, no extra query).

### WS2 — Priority-recompute script (AC2, AC3, AC5, AC7)

**`services/tasks-api/scripts/backlog-priority-recompute.ts`** — single-pass script.

Inputs:
- Strategy markdown: `brain/sindustries/strategy-graph.md` (path resolved relative to workspace root; configurable via `--strategy-doc <path>`).
- Tasks: `GET /tasks?status=open,ready,doing,acceptance&limit=1000` (archived + done excluded — algorithm should not move terminal tasks).

Parse strategy markdown:
- Extract the four Impacts and their weights (Impact table at the top).
- Extract each Initiative section (numbered list under "## Current Initiatives") and parse: status, value, time, risk, size, WSJF = (value+time+risk)/size.
- Initiative → Impact addressing: derived from the prose "→ <Impact-name>" markers (e.g. `→ Ships Without the Bottleneck, Mornings Reclaimed`).
- Allowed impacts are the union of Impact names declared in the doc; any unknown impact slug on a task is logged + counted as `skippedAmbiguous`.

Algorithm (per task):
```
for task in tasks:
  if task.priority == urgent:
    run.skippedUrgentCount++; continue (AC4)
  if task.impactTags is empty:
    run.skippedNoBackingCount++; continue (AC5)
  active_initiatives = initiatives
    where status == active
      and any(impact in initiative.impacts) is in task.impactTags
  if active_initiatives is empty:
    run.skippedNoBackingCount++; continue (AC5)
  best = argmax(active_initiatives, wsjf_score)
       tie-break: alphabetical initiative slug
  new_priority = scoreToPriority(best.wsjf_score)
  if new_priority != task.priority:
    open BacklogMaintenanceRun row
    insert TaskPriorityAudit { old, new, derived, runId }
    PATCH /tasks/:id { priority: new_priority }
    run.repioritizedCount++
  else:
    run.unchangedCount++
```

`scoreToPriority` thresholds (published constants — see WS3 docs update):
- `high` if WSJF ≥ 4.0
- `medium` if WSJF ≥ 2.0
- `low` if WSJF < 2.0

These thresholds reflect the existing ranking in `brain/sindustries/strategy-graph.md` (GymTrack 5.5 → high, Bookmark→Spec 5.0 → high, Feature Factory 2.4 → medium, Content Factory 2.0 → medium). Defaults proposed here; Quinn to confirm before implementation.

Run lifecycle:
- Insert `BacklogMaintenanceRun { status: running, strategyDocSha256: <sha> }` at start.
- All `TaskPriorityAudit` rows reference `runId`.
- At end: update `status: succeeded`, `completedAt: now`, counters.
- On uncaught exception: `status: failed`, write whatever counters had been incremented, write `details: { error: ... }`.

Concurrency guard: take a Postgres advisory lock (`pg_try_advisory_xact_lock(0xB10G_MA1NT)` — derived constant from the task hash) at start; if another pass is running, exit with code 0 and `status: skipped-existing-run` log line. The `0xB10G_MA1NT` constant is fine because advisory locks are session-scoped, not user-scoped, and the namespace is empty today.

### WS3 — Backlog-maintenance cron Step 8 (AC3, AC7)

**`agents/crons/prompts/backlog-maintenance.md`** — append Step 8 (existing Steps 1–7 stay unchanged).

```markdown
## Step 8 — Recompute derived priority from initiative WSJF

Run the priority-recompute pass. This is the only step that writes
`Task.priority` outside of a human/agent PATCH (and only ever to
`high | medium | low` — never `urgent`).

\`\`\`bash
pnpm --filter services/tasks-api exec ts-node scripts/backlog-priority-recompute.ts \
  --strategy-doc ../../brain/sindustries/strategy-graph.md
\`\`\`

Capture stdout (run-id, counters, any skipped tasks). Surface to the
Step 7 report as:

- R tasks re-prioritised (title → old → new, grouped by driving initiative)
- U tasks unchanged (count only — no per-task listing)
- S tasks skipped (no impact tags | only parked/blocked backing | urgent | ambiguous tag slugs)
- The strategy-doc SHA256 captured in the run row (so subsequent passes can detect drift)
- Link to the run row id for audit trail navigation
```

The cron continues to be a Quinn-heartbeat prompt — Rowan runs the recompute explicitly when Quinn or Tom asks, or as part of the standard daily backlog-maintenance pass. Adding it to the same prompt avoids spawning a second cron and keeps the existing "one place that touches the backlog" pattern.

### WS4 — Docs update + audit-trail visibility (AC6, AC7)

**`docs/systems/tasks.md`** — new section under "API surface":

```markdown
### Derived priority from initiative WSJF

Task `priority` (`low | medium | high` — `urgent` is manual-only) is
recomputed from the current WSJF score of the strongest active Initiative
behind any of the task's `impactTags`, on every backlog-maintenance pass.

| WSJF score | Derived priority |
|---|---|
| ≥ 4.0 | `high` |
| ≥ 2.0 | `medium` |
| < 2.0 | `low` |

Thresholds are constants in `services/tasks-api/scripts/backlog-priority-recompute.ts`
(scoreToPriority). Adjusting them is a deliberate operation, not an
incidental edit — bump the constant, document the reason in
`brain/sindustries/strategy-graph.md`, and reset the audit trail
interpretation if it changes historical `TaskPriorityAudit` semantics.

| Concern | Source of truth |
|---|---|
| Impact definitions + weights | `brain/sindustries/strategy-graph.md` |
| Initiative status + WSJF inputs | `brain/sindustries/strategy-graph.md` |
| `Task.impactTags` | PATCH on the task (this PR's WS1) |
| `Task.priority` (derived) | `BacklogMaintenanceRun` × `TaskPriorityAudit` |
| Manual `Task.priority` overrides | The PATCH call that wrote them |

Manual `priority` writes are never audited here — the Tasks API write path
is the audit. The `TaskPriorityAudit` rows only record algorithm-driven
changes. `urgent` is never overwritten by the algorithm; tasks with
`priority == urgent` are skipped (counted in the run's `skippedUrgentCount`).
```

Update the API surface table: add `impactTags: String[]` to the PATCH body list and GET response.

### WS5 — Tasks API client flag (AC1)

**`agents/skills/ops/tasks-api/tasks_api_client.py`** — extend the `patch` subcommand:

- `--impact-tags "<slug1>,<slug2>,..."` — sets impact tags (full replacement).
- `--clear-impact-tags` — sets `impactTags: []`.

Both flags compose with existing flags (status, priority, assignee, tags, etc.). Add to the existing test suite in `tests/test_tasks_api_client.py`.

### Risks and open questions

1. **Threshold tuning.** Default thresholds (high ≥ 4.0, medium ≥ 2.0) reflect the current strategy doc ranking. If Tom or Quinn has a different intended distribution, the constants should move before the algorithm ships its first pass against real data. Document the thresholds and the rationale in `docs/systems/tasks.md` so the audit trail is interpretable.
2. **Strategy-doc parse fragility.** Regex-based markdown parsing is brittle by definition. A deliberate change to the strategy-doc format (e.g. restructuring the Impact table) could break the parse and silently zero out priorities on the next pass. Mitigation: parse errors → `BacklogMaintenanceRun { status: failed, details: { parseError } }` + alert, no priority writes. Add a smoke test that runs the parser against the current strategy doc as part of CI on `services/tasks-api`.
3. **Multi-workspace strategy doc.** Quinn's `tasks-by-impact.md` companion also references Impacts. The algorithm only reads `strategy-graph.md`. The companion is a hand-classified snapshot for Tom's review, not the live source.
4. **Existing free-text `tags` overlap.** Some existing tasks already carry `ships-without-the-bottleneck` as a free-text tag (per `tags:` arrays in task payloads). The new `impactTags` field is separate. A one-time backfill script that maps the existing free-text tags to `impactTags` could be added as a follow-up; out of scope for this PR per AC5 ("never sets a badge with no active backing").
5. **Real-time vs. pass-driven updates.** Spec mandates pass-driven (non-real-time). Documented in § Notes of the spec; respected by this design.
6. **Parked/blocked initiative semantics.** Spec says "whose only backing initiatives are parked or blocked" → skip (AC5). The algorithm drops them from the candidate set, which means `active` is the only status that contributes. A future task could extend this to surface parked/blocked in the audit note (e.g. `derivedFromInitiativeId: null, note: "only parked initiative 'X' backed this"`).
7. **Tie-break rule.** When two active initiatives tie on WSJF, the algorithm picks alphabetically by Initiative slug. Deterministic and reproducible, but arbitrary. If Quinn prefers a different tie-break (initiative priority order in the doc, or older initiative first), swap it in `scoreToPriority`-adjacent helper.
8. **`urgent` audit.** `urgent` tasks are skipped, not audited. Tom can still see the task badge hasn't changed — that is the audit. Adding `TaskPriorityAudit { taskId, oldPriority: urgent, newPriority: urgent, note: "skipped: manual urgent override" }` is cheap and may be worth it for pass transparency; flagged as Q4 to Quinn.

## Acceptance Criteria mapping

| AC | How this design satisfies it |
|---|---|
| AC1 (first-class machine-readable impact tags) | WS1: `Task.impactTags: String[]` + PATCH field + GET response + client flag. |
| AC2 (derived priority = mapped from highest-scoring active initiative's WSJF) | WS2: algorithm + `scoreToPriority` thresholds. |
| AC3 (recompute on every backlog-maintenance pass) | WS3: new Step 8 in the cron prompt invokes the script. |
| AC4 (urgent never overwritten) | WS2: explicit `if task.priority == urgent: skip`. |
| AC5 (no impact tags / only parked-blocked backing → leave unchanged) | WS2: empty-tags + no-active-initiative branches both short-circuit. |
| AC6 (audit trail per change: initiative + score) | WS1+WS2: `TaskPriorityAudit` row per change with `derivedFromInitiativeName`, `derivedFromScore`, `runId`. |
| AC7 (pass report: re-prioritised / unchanged / skipped) | WS1+WS2+WS3: `BacklogMaintenanceRun` counters + cron Step 8 emits human-readable report. |

## Open follow-ups (not blockers for this PR)

1. **Tasks UI: impact-tag editor + audit-trail panel.** Out of scope for this design — the ACs don't require UI. Tasks UI can read the `impactTags` field once it ships and add an editor in the task detail view. Add to the backlog under "tasks-app" tag.
2. **One-time backfill script** mapping existing free-text `tags` to `impactTags` where they clearly overlap (e.g. `ships-without-the-bottleneck` → `ships-without-bottleneck`). Could ship as a separate code task once the new field has been live for a few passes and we can see the actual tag overlap.
3. **Strategy-doc parse → DB mirror.** If parsing every pass becomes a bottleneck (unlikely at current strategy-doc size), mirror Impacts + Initiatives + WSJF to a DB table and read from there. Defers the second-source-of-truth question and only justified if the parse path shows up in flamegraphs.
4. **Incident lifecycle for skipped-no-backing tasks.** If a task has impact tags but no active backing for several consecutive runs, that might be worth surfacing as an incident. Out of scope here; the skipped count is the signal for now.

## Test plan

- Unit tests for the strategy-doc parser: fixtures for the current `brain/sindustries/strategy-graph.md` plus three malformed variants (missing Impact table, malformed Initiative section, unknown status). Parser must return a typed result or a structured parse error — never throw silently.
- Unit tests for `scoreToPriority` against the threshold table.
- Unit tests for the algorithm using stubbed Tasks API client: tasks with no tags, only-urgent, only-parked-backing, ambiguous tag slug, single-active-backing, multi-active-backing with score tie.
- Integration test: `POST /tasks { impactTags }` → `PATCH /tasks/:id { impactTags }` → audit row visible after a recompute pass. Use the existing tasks-api integration test fixtures.
- Tasks API client test: `--impact-tags "ships-without-bottleneck,money-or-users"` sends the right body; `--clear-impact-tags` sends `[]`.
- CI smoke test: parser runs against the live `brain/sindustries/strategy-graph.md` (pinned by workdir, not committed fixture) and confirms the result has 4 Impacts and ≥ 1 active Initiative. Fails CI on parse regression.

## Key files

- `services/tasks-api/prisma/schema.prisma` (model additions)
- `services/tasks-api/prisma/migrations/<timestamp>_priority_audit_and_run_and_impact_tags/` (migration)
- `services/tasks-api/src/routes/tasks.ts` (PATCH body validation for `impactTags`, GET response inclusion)
- `services/tasks-api/scripts/backlog-priority-recompute.ts` (new)
- `agents/crons/prompts/backlog-maintenance.md` (Step 8)
- `agents/skills/ops/tasks-api/tasks_api_client.py` (flags)
- `agents/skills/ops/tasks-api/tests/test_tasks_api_client.py` (tests)
- `services/tasks-api/test/` (new `backlog-priority-recompute.test.ts`)
- `docs/systems/tasks.md` (Derived priority section)
- `docs/specs/task-priority-inherits-from-initiative-tech-design.md` (this file)