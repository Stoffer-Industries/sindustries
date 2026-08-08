---
status: draft
task_id: 66054ab4-24e2-4cc6-9847-0faa4e94f041
product_spec: brain/tasks/specs/in-progress/task-blocked-by-escalation-owners-and-stacked-avatars-2026-08-05.md
shipped_pr: null
shipped_date: null
---

# Tech Design — Blocked-by escalation owners and stacked task avatars

## Links

- Product spec: `brain/tasks/specs/in-progress/task-blocked-by-escalation-owners-and-stacked-avatars-2026-08-05.md`
- Task: `66054ab4-24e2-4cc6-9847-0faa4e94f041` (`🔧 Blocked-by escalation owners and stacked avatars`)
- Tasks API detail: `http://localhost:4001/api/v1/tasks/66054ab4-24e2-4cc6-9847-0faa4e94f041`
- Depends on: `ffa30da7-d019-4413-aeae-ad211b9ea614` (Tasks API Native Approvals — code merged on `main`; cron promotion pending in PR #372)
- Prior art: [`docs/specs/add-blocked-by-reference-tech-design.md`](./add-blocked-by-reference-tech-design.md) (the legacy `TaskDependency` design — same shape, different intent)

## Scope

- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-66054ab4-blocked-by-escalation-owners` (this tech design is the first commit on this branch)
- Implementation branches:
  - WS1 / WS2 / WS4 → `task-66054ab4-blocked-by-escalation-owners` (tasks-api + migration)
  - WS3 → `task-66054ab4-blocked-by-escalation-owners-ui` (tasks app)
- Worktree: primary repo at `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries`
- Primary code surfaces:
  - `services/tasks-api/prisma/schema.prisma`
  - `services/tasks-api/prisma/migrations/<timestamp>_add_task_blocked_by/migration.sql`
  - `services/tasks-api/src/routes/tasks.ts`
  - `services/tasks-api/src/routes/tasks/_mapper.ts`
  - `services/tasks-api/src/routes/tasks/_validation.ts`
  - `services/tasks-api/src/routes/tasks/_deps.ts` (or a sibling `_blockedBy.ts` if it stays small)
  - `services/tasks-api/src/lib/http.ts` (no new error codes expected; reuse `badRequest`)
  - `services/tasks-api/scripts/migrate-legacy-blocked.ts` (WS4 one-shot, dry-run-first)
  - `apps/tasks/src/components/TaskCardSummary.jsx`
  - `apps/tasks/src/components/TaskEditor.jsx`
  - `apps/tasks/src/utils/helpers.js`
  - `apps/tasks/src/App.jsx` (discovery queue filter wiring)
  - `apps/tasks/src/tasksApi.ts` (TS shape extension)
  - `apps/tasks/SPEC.md`
  - `agents/skills/ops/tasks-api/tasks_api_client.py`
  - `agents/skills/ops/tasks-api/tests/test_tasks_api_client.py`
  - `docs/systems/tasks.md` (durable truth updated on ship)

## Product summary

After this ships, every task can show both its delivery assignee and the people currently responsible for unblocking it. The Tasks API exposes a structured `blockedBy` list of task-participant owners; workflow gates continue to use `TaskApproval` rows; and the legacy `Task.blocked` boolean survives as a "generic unowned blocker" signal so existing tasks stay visibly blocked during the transition. UI task cards render the assignee first, then a stacked avatar group of distinct blocked-by and outstanding workflow-gate owners. The discovery queue filters `?blockedBy=<owner>` to surface each owner's per-task attention items without changing delivery assignment.

This is **two parallel ownership planes** — `TaskApproval.owner` for workflow gates (spec / tech_design / qa) and `TaskBlockedBy.owner` for the catch-all generic escalation — plus a stacked visual on the card. Task dependencies (`TaskDependency`, `dependsOnIds`) remain a separate concept and continue to derive `dependencyBlocked` exactly as today.

## Ownership boundary check

- Domain owner for the **data model** is the Tasks API. `TaskBlockedBy` is first-class relational state, just like `TaskApproval` (also landed by ffa30da7). Putting this in the Tasks API keeps referential integrity, lets the discovery queue filter through `GET /tasks?blockedBy=…`, and avoids forcing the apps to compute "who is this task blocked-by" from JSON blobs.
- Domain owner for the **stacked avatar component** is the Tasks app. `apps/tasks/src/users/assignees.js` already maps free-form assignee strings to a display name + avatar path via `findAssigneeUser`. Reuse it for both delivery assignee and blocked-by owners — no new shared package is justified for this v1.
- Durable truth lives in `docs/systems/tasks.md` (the cross-cutting system doc, not a new system doc — Tom 2026-07-25 consolidation bias). Update that file in the same PR that ships WS4.

## `.openclaw` boundary notes

- No secrets, no external services.
- No OpenClaw runtime copy needs to change because `agents/skills/ops/tasks-api/tasks_api_client.py` lives in this repo and is symlinked into `.openclaw` at heartbeat time. After merge, the next heartbeat automatically picks up the new `--blocked-by` flag.
- The heartbeat cadence rule "if any assigned task is in `ready` and lacks a `[tech-design]` comment, prioritise writing and posting that tech design" already routed Rowan here; nothing further needed.

## Data model changes

Add `TaskBlockedBy` as a self-referential join from `Task` to a free-form string owner, parallel to `TaskApproval` in shape but without the `type` / `state` columns (every row means "this owner has an outstanding blocker action").

```prisma
model Task {
  // existing fields...
  blockedBy TaskBlockedBy[]
}

model TaskBlockedBy {
  id        String   @id @default(uuid()) @db.Uuid
  taskId    String   @db.Uuid
  owner     String
  addedBy   String?
  note      String?
  createdAt DateTime @default(now())

  task Task @relation(fields: [taskId], references: [id], onDelete: Cascade)

  // One row per (task, owner). Upsert targets this unique index. Duplicate
  // owners in a single PATCH are normalized away in the route layer before
  // the upsert so race conditions across two PATCHes collapse cleanly.
  @@unique([taskId, owner])
  @@index([owner])
  @@index([taskId, createdAt])
}
```

Why a join table (not a `String[]` on Task):
- Lets the discovery queue `?blockedBy=Rowan` use an indexed SQL filter instead of `arraycontains`.
- Captures `addedBy` and `note` for an audit trail of who escalated whom (cheap, helps when Quinn passes a blocker to Tom).
- Matches the existing `TaskDependency` precedent and the `TaskApproval` precedent (ffa30da7) so reviewers don't see a one-off shape.

Why we keep `Task.blocked`:
- AC8 requires existing `blocked=true` tasks to remain visibly blocked during the transition.
- Treat `Task.blocked=true && TaskBlockedBy rows absent` as the "generic unowned blocker" state. The UI keeps showing a `Blocked` badge in that case and surfaces a `Add owner` affordance; once any owner is added, the badge stays but the badge text shifts to `Blocked by N`.

`owner` vocabulary: same free-form policy as `Task.assignee` — recognised task participants (`Tom`, `Quinn`, `Rowan`, `Ivy`, `Lox`) plus any free-form agent or human label the caller supplies. Case-insensitive normalization happens in the route layer; storage is canonical-cased (`Tom`, not `tom`) so `findAssigneeUser` lookups work.

Migration: `services/tasks-api/prisma/migrations/<timestamp>_add_task_blocked_by/migration.sql` adds the table and indexes. No backfill required — existing tasks start with empty `blockedBy`.

## API contract changes

### `GET /tasks/:id` response shape (additive)

```json
{
  "id": "uuid",
  "title": "…",
  "blockedBy": ["Quinn", "Tom"],
  "blockedByIds": [
    { "owner": "Quinn", "addedBy": "Rowan", "note": null, "createdAt": "2026-08-08T…" },
    { "owner": "Tom",   "addedBy": "Quinn", "note": "policy call", "createdAt": "2026-08-08T…" }
  ],
  "hasBlockedBy": true,
  "genericBlocked": false,
  "…": "all existing fields unchanged"
}
```

- `blockedBy`: distinct, normalized, insertion-ordered list of owner strings (humans/UI consume this).
- `blockedByIds`: full rows including `addedBy`, `note`, `createdAt` (detail view + audit consume this).
- `hasBlockedBy`: derived — `blockedBy.length > 0`.
- `genericBlocked`: derived — `task.blocked === true && blockedBy.length === 0`. Lets the UI distinguish "manually blocked, no owner yet" from "blocked, Quinn owns it" without re-deriving in JS.

### `PATCH /tasks/:id` body shape (additive)

```json
{
  "blockedBy": ["Quinn", "Tom"]
}
```

Full replacement matches `tags` and `dependsOnIds` semantics already shipped. Omitted `blockedBy` means no change. Empty array clears all blocked-by owners (and does NOT touch `task.blocked` — that's a separate concern; clearing `blockedBy` is not a promise to clear `blocked`). Validation:

- `blockedBy` must be an array of non-empty strings.
- Duplicate strings normalize away.
- Case-insensitive owner comparison against the recognised participant set (`Tom`, `Quinn`, `Rowan`, `Ivy`, `Lox`) — free-form strings outside the set are accepted and stored verbatim (mirrors `Task.assignee` policy).
- Maximum length per row: 64 chars. Maximum rows per task: 16 (keeps the stacked avatar group legible and bounds memory).

Implementation: in the route handler, if `blockedBy` is present, run the upsert/delete inside a Prisma transaction alongside any other field updates. The transaction deletes rows whose owner is not in the new set, then upserts rows whose owner is new (or whose `note` differs). If only owner identity changes, `note` is preserved.

### `GET /tasks` query (additive filter)

```
GET /tasks?blockedBy=Quinn
```

Adds a new `blockedBy` query parameter to the existing filter surface. Accepts a single owner string. Combines with the existing filters (`status`, `assignee`, `priority`, etc.) via AND semantics.

Implementation: in `routes/tasks.ts`, add to the `where` clause:
```js
...(blockedBy ? { blockedBy: { some: { owner: { equals: String(blockedBy), mode: 'insensitive' } } } } : {})
```

For multi-owner filtering, the discovery queue UI can call the endpoint once per owner or accept a CSV-shaped extension — out of scope for v1.

Include `blockedBy` rows in the list query's Prisma `include` so `mapTask` can render the response without an N+1 round trip. List responses do not include `blockedByIds` (heavy); only `blockedBy`, `hasBlockedBy`, `genericBlocked`.

### Tasks API client

Update `agents/skills/ops/tasks-api/tasks_api_client.py`:

- `get` and `list` print the new fields unchanged.
- `patch` accepts `--blocked-by owner1 owner2` (full replacement) and `--clear-blocked-by` (explicit clear, distinct from "omitted = no change"). Map `--blocked-by` to `{"blockedBy": [...]}`.

Tests in `agents/skills/ops/tasks-api/tests/test_tasks_api_client.py` cover: list/get preserves `blockedBy`/`hasBlockedBy`/`genericBlocked`, patch sets blocked-by rows, patch with no blocked-by flag is a no-op, `--clear-blocked-by` clears rows.

## UI behavior

### TaskEditor (`apps/tasks/src/components/TaskEditor.jsx`)

Add a "Blocked by" multi-select control alongside the existing `Blocked` checkbox. Source options from `ASSIGNEE_USERS` (registered users) plus a free-text path that creates a custom owner on save. PATCH the new `blockedBy` array together with the existing `blocked` boolean when both change.

UX:
- Below the existing `Blocked` checkbox.
- Show current blocked-by owners as removable chips.
- "Add owner" opens a dropdown of registered participants + a "Custom…" entry that prompts for a name.
- Empty list renders as `No escalation owners` placeholder; users can still set `Blocked` without owners (the generic-blocked case).

### TaskCardSummary (`apps/tasks/src/components/TaskCardSummary.jsx`)

Render the stacked avatar group after the existing delivery assignee avatar. Composition:

1. Delivery assignee avatar (today's behavior — `<Avatar>` with first-letter fallback).
2. Distinct blocked-by avatars, each with a `title` / `aria-label` like `Blocked by Quinn`.
3. Distinct outstanding workflow-gate owners from `task.approvals` where `state === 'approved'`, deduped against the assignee and against blocked-by owners.
4. Wrap the whole group in a flex container with negative margins or gap so the avatars overlap ~25% (stacked-avatar visual).

De-duplication rule: a person renders at most once even if they appear in multiple planes (assignee + blocked-by + approvals all "Quinn" → one avatar). Order: assignee first, then blocked-by in stable insertion order, then approvals in `type` order (`spec`, `tech_design`, `qa`).

`genericBlocked` case (`task.blocked && !task.hasBlockedBy`): keep the existing "Blocked" badge in `task-card-footer-tags` exactly as today. Don't add an avatar for the generic case — there's no one to show.

Accessibility:
- Each avatar gets a unique `aria-label`.
- The stacked group has a single accessible name like `Assigned to Rowan; blocked by Quinn and Tom; QA by Tom`.
- Mirror the same description in `TaskEditor.jsx`'s detail view title bar.

### Discovery queue wiring (`apps/tasks/src/App.jsx`)

The existing "attention" / discovery queue is implemented as a filter on `GET /tasks` — typically the agent's "what do I need to do" view. Add a new filter chip / URL state `blockedBy=<owner>` that maps to the `?blockedBy=<owner>` query parameter. When the user is signed in as a registered participant (Quinn / Ivy / Lox / Rowan / Tom), the default landing view filters `blockedBy=<self>` so escalation items surface first.

Per AC4: each attention item shows the task title, delivery assignee, blocker reason (from `TaskBlockedBy.note` if set, else `Blocked by <owner>`), and the action expected from the owner ("unblock" — a single-link target to the task detail).

Per AC5: when the owner is removed from `blockedBy`, the task drops out of that owner's queue automatically because the route filter is `?blockedBy=...` and the filter won't match.

### Apps spec

Update `apps/tasks/SPEC.md` (per DoD in CONVENTIONS.md):
- "Create a task" flow: mention the new `Blocked by` control.
- "Edit a task" flow: same.
- "Discovery queue" flow: document the `?blockedBy=<owner>` filter and the default landing view.
- "Task card" screen: document the stacked avatar group composition rule.

## Migration (WS4)

`services/tasks-api/scripts/migrate-legacy-blocked.ts` — a one-shot script that:

1. Reads every non-archived task where `blocked === true`.
2. For each such task, if `TaskBlockedBy` is already populated, skip (manual owner already assigned).
3. Otherwise, log a `DRY_RUN` line: `task=<id> title=<title> blocked=true blockedBy=<empty>` and do nothing else.
4. `--write` mode is a no-op for now — the migration is purely informational because AC8 explicitly requires the legacy `blocked` indicator to remain visible until ownership is made explicit. The script's only job is to surface the list so Quinn/Tom can decide whether to manually add owners in bulk or leave tasks in the generic-blocked state.

This is intentionally **not** a backfill. Auto-picking an owner for "manual blocked" rows would violate the non-goal "Automatically deciding who should own a blocker when no owner is supplied." The script is a reporting tool; Quinn can use its output to triage.

A separate `--dry-run` printout is the deliverable. No snapshot/rollback path is needed because the script writes nothing.

## Implementation plan

1. Add the `TaskBlockedBy` model and Prisma migration.
2. Extend `routes/tasks/_mapper.ts` to map `blockedBy`, `blockedByIds`, `hasBlockedBy`, `genericBlocked` from the joined rows.
3. Add `normalizeBlockedBy` to `_validation.ts` (trim, case-fold against `validAssignees`, drop empties, cap at 16).
4. Add `replaceBlockedBy` to `_deps.ts` (or a sibling `_blockedBy.ts`) — Prisma transaction that diffs existing vs. new rows and upserts/deletes.
5. Update `routes/tasks.ts` GET to include `blockedBy` rows in the list query and apply the `?blockedBy=` filter.
6. Update `routes/tasks.ts` PATCH to accept `blockedBy` and call `replaceBlockedBy` in the same transaction as other field updates.
7. Update `apps/tasks/src/tasksApi.ts` types.
8. Update `apps/tasks/src/components/TaskCardSummary.jsx` to render the stacked avatar group.
9. Update `apps/tasks/src/components/TaskEditor.jsx` to expose the "Blocked by" multi-select.
10. Update `apps/tasks/src/App.jsx` to wire `?blockedBy=` filter on the discovery queue landing view.
11. Update `apps/tasks/SPEC.md` with the new flows + screens.
12. Update `agents/skills/ops/tasks-api/tasks_api_client.py` with `--blocked-by` and `--clear-blocked-by` flags.
13. Ship `services/tasks-api/scripts/migrate-legacy-blocked.ts` as `--dry-run`-only.
14. Update `docs/systems/tasks.md` with a "Blocked-by ownership" section under the durable architecture truth.

## Test plan — AC verification matrix

| AC | Verification |
| --- | --- |
| AC1: zero/one/many **Blocked by** owners, independent of delivery assignee | Unit tests in `tasks/_validation.test.ts` (if present) or new `tasks/_blockedBy.test.ts` assert normalization (empty, single, multi, duplicates). API test: PATCH a task with `assignee=Rowan` and `blockedBy=["Quinn","Tom"]`, GET it back, assert `assignee==="Rowan"` and `blockedBy` is `["Quinn","Tom"]` (order preserved). API test: PATCH `blockedBy=[]` and confirm both `blockedBy` and `blockedByIds` are empty while `assignee` is unchanged. |
| AC2: blocked state from blocked-by; clearing removes generic escalation; assignee untouched | API test: create a task with `blocked=true, blockedBy=[]`, assert `genericBlocked===true`. PATCH `blockedBy=["Quinn"]`, assert `genericBlocked===false, hasBlockedBy===true, blocked===true` (boolean is orthogonal). PATCH `blockedBy=[]`, assert back to `genericBlocked===true`. Throughout, assert `assignee` is unchanged. |
| AC3: workflow-gate owners and generic blocked-by visible; no replacement / no duplication | API test: create a task, POST a `TaskApproval` for `type=qa, owner=Tom`, then PATCH `blockedBy=["Tom"]`. GET it back, assert `approvals[0].owner==="Tom"`, `blockedBy==["Tom"]`. The response shape exposes both planes independently — they don't replace each other. UI test: render a task with assignee=`Rowan`, blockedBy=`["Quinn","Tom"]`, approvals=`[{type:"qa",owner:"Tom",state:"approved"}]`, assert the stacked avatar group has 3 distinct avatars: Rowan, Quinn, Tom (Tom appears once even though both `blockedBy` and `approvals` name him). |
| AC4: discovery queue attention item per blocked-by owner with task / assignee / reason / action | API test: `GET /tasks?blockedBy=Quinn` returns one entry per task where Quinn is a blocked-by owner; the response carries `assignee` (delivery) and each entry's `blockedByIds[i].note` (or `Blocked by Quinn` fallback). UI test: discovery queue landing view filters by the signed-in owner and renders the action link to `/tasks/:id`. |
| AC5: resolving one owner preserves others; owner with no remaining action drops from their queue | API test: PATCH `blockedBy=["Quinn","Tom"]` → PATCH `blockedBy=["Quinn"]`, assert the Tom row is deleted, Quinn row remains (history). Then `GET /tasks?blockedBy=Tom` returns 0 rows for that task, `GET /tasks?blockedBy=Quinn` still returns it. |
| AC6: stacked avatars — assignee first, then distinct blocked-by + workflow-gate owners; duplicates once | UI test (component): `TaskCardSummary.test.jsx` renders the fixture above and asserts the avatar order is `[Rowan, Quinn, Tom]` (assignee, blocked-by, workflow-gate) and the avatars visually overlap (snapshot or class assertion). De-dup test: same fixture, but `approvals=[{owner:"Quinn",...}]` — assert Quinn appears exactly once even though blocked-by and approvals both name her. |
| AC7: avatar labels / detail views distinguish delivery vs. unblocker; accessible names | UI test: aria-label on each avatar asserts `Assignee Rowan`, `Blocked by Quinn`, `QA by Tom`. TaskEditor detail view exposes the same hierarchy in the metadata block. axe-core lint passes (or manual a11y check covers it). |
| AC8: legacy `blocked=true` rows remain visible during transition; task dependencies still separate | API test: insert a row directly with `blocked=true, blockedBy=[]` (bypass PATCH validation), GET it back, assert `genericBlocked===true` and the existing `dependencyBlocked` field is unchanged for tasks with `dependsOn`. UI test: a card with `genericBlocked===true` shows the existing `Blocked` badge and **no** stacked avatar (no owner to show). A separate card with both `dependencyBlocked===true` and `blockedBy=["Quinn"]` shows the dependency warning plus Quinn's avatar — they're not merged. |

Additional test layers:

- `npm test --workspace services/tasks-api` — all mapper, validation, route tests above.
- `npm test --workspace apps/tasks` — `TaskCardSummary.test.jsx`, `TaskEditor.test.jsx`, discovery queue landing render.
- `python3 -m pytest agents/skills/ops/tasks-api/tests` — CLI flag mapping for `--blocked-by` and `--clear-blocked-by`.
- E2E (Playwright `apps/tasks/test/e2e/`): add a focused spec that creates a task, sets a blocked-by owner, then asserts the card renders the stacked avatar. The existing `apps/tasks/test/e2e/happy-path.spec.js` already covers the assignee path; mirror that style.
- Manual smoke: run `services/tasks-api/scripts/migrate-legacy-blocked.ts --dry-run` against prodlike Postgres and confirm the output lists only the rows Quinn/Tom expect to triage.

## Open questions and risks

- **Owner vocabulary** — `TaskBlockedBy.owner` accepts free-form strings like `Task.assignee` does. Should the API reject anything outside `validAssignees`? Recommendation: accept free-form to mirror assignee, but log a `console.warn` server-side and surface a soft warning in the editor UI ("Unrecognized owner — won't show in discovery queue for registered users"). Decision deferred to Quinn's review of the tech design.
- **Backward compat of `task.blocked`** — keeping the boolean is per AC8, but it leaves two ways to express "blocked." A follow-up task could collapse them once the migration is complete and tasks are triaged. Out of scope here.
- **Approval de-dup with blocked-by** — Tom can be both `blockedBy=Tom` and `TaskApproval.owner=Tom` for `qa`. The UI dedups. Do we want a stricter model where the workflow gate "owns" the unblock once the gate is approved? Recommendation: no — keep them independent planes per the product spec ("Workflow gates use their structured owners, while the task's generic **Blocked by** control captures blockers that do not belong to a defined gate").
- **Discovery queue default view** — landing the user on `?blockedBy=<self>` means the home view changes the moment they sign in. Per Quinn 2026-07-29 "temper incremental delivery with architecture judgment": this is the durable shape, but it should be flagged in the PR description so reviewers know the home-screen behavior shifts.
- **Capacity gate** — Rowan is at 2/2 in `doing` (ffa30da7 + e9c06d01). This task remains in `ready` until Quinn approves `[tech-design-approved] true`. Once approved, the next heartbeat will not auto-promote because the capacity gate is full — ffa30da7 or e9c06d01 must close first. Documenting here so the lobster's classifier doesn't surprise anyone.