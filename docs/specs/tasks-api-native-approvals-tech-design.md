---
status: draft
task_id: ffa30da7-d019-4413-aeae-ad211b9ea614
product_spec: brain/tasks/specs/in-progress/tasks-api-native-approvals-2026-07-17.md
shipped_pr: null
shipped_date: null
---

# Tasks API Native Approvals — Tech Design

**Task:** `ffa30da7-d019-4413-aeae-ad211b9ea614` — 🛠 Tasks API Native Approvals (urgent, `ready`)
**Spec:** `brain/tasks/specs/in-progress/tasks-api-native-approvals-2026-07-17.md` *(see Open question Q1 — spec file is not present in this worktree)*
**Branch:** `task-ffa30da7-tasks-api-native-approvals`
**Worktree:** `~/workspaces/rowan/sindustries-task-ffa30da7-tasks-api-native-approvals`
**Repo:** `Stoffer-Industries/sindustries`
**Owner (all workstreams):** Rowan

## Product intent

After this ships, approval gates in the feature-factory workflow are first-class fields on the Tasks API rather than conventions embedded in task description text and comment bodies. An agent or UI can set or read any approval (spec, tech-design, qa) via a dedicated API endpoint without parsing markdown checkboxes or comment tags. The lobster and other workflow consumers switch to reading these fields, eliminating the fragile text-matching that currently causes approvals to go missing when specs are created outside the standard skill.

Quoted from the task description.

## Service boundary and ownership

| Concern | Owner | Notes |
|---|---|---|
| `TaskApproval` persistence | `services/tasks-api` | New Prisma model, joined to `Task` by `taskId`. One row per `(taskId, type)` pair. |
| Approvals API (`GET`/`POST`/`DELETE`) | `services/tasks-api` | New routes under `/api/v1/tasks/:id/approvals`. Distinct from the existing `PATCH /tasks/:id` path. |
| `taskType → required-approvals` map | `services/tasks-api` reads `.openclaw/tasks-api/required-approvals.yaml` on startup | The map lives outside the repo (in `.openclaw/`) so Quinn or Tom can add a gate without a Rust recompile. See WS2. |
| Lobster approval reads | `agents/workflows/feature-task` (Rust crate) | Replace text-matching paths with reads from the structured `approvals` collection, fall back to legacy comment tags during the migration window. See WS3. |
| Tasks UI display | `apps/tasks` | Surface per-approval state on the task detail view. See WS4b. |
| Migration script | `services/tasks-api/scripts/migrate-legacy-approvals.ts` | One-shot script, dry-run + smoke-tests against a snapshot. See WS4a. |

**Why `services/tasks-api` and not a new service?** The Tasks API already owns task and task-comment state. Adding `TaskApproval` to the same service keeps the task record coherent (a task and its approvals are loaded, written, and versioned together) and avoids cross-service consistency. The Tasks UI already calls this service for everything task-shaped.

**Why `.openclaw/` for the required-approvals map?** Two reasons: (1) the spec acceptance criterion explicitly says "configurable without a code deploy", which means a recompile of the Rust lobster must not be in the loop when a new gate is added; (2) the existing `.openclaw/` boundary (documented in `docs/systems/tasks.md`) already handles out-of-repo configuration edits via the `[openclaw-needed]` / `[openclaw-done]` task-comment protocol, so Quinn owns the change path. A committed config file under `services/tasks-api/config/` would violate (1).

## Implementation plan

### WS1 — Approval collection + endpoint (AC1, AC2)

**`services/tasks-api/prisma/schema.prisma`** — add:

```prisma
enum ApprovalType {
  spec
  tech_design
  qa
}

enum ApprovalState {
  approved
  revoked
}

model TaskApproval {
  id          String        @id @default(uuid()) @db.Uuid
  taskId      String        @db.Uuid
  type        ApprovalType
  /// Free-text owner field: "Tom", "Quinn", "Lox", etc. Mirrors the
  /// `assignee` convention on `Task`. Not a foreign key — humans and
  /// agents both post approvals, and the field is informational.
  owner       String
  state       ApprovalState @default(approved)
  approvedAt  DateTime      @default(now())
  revokedAt   DateTime?
  /// Optional note from the approver — why this was approved or revoked.
  note        String?
  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt

  task Task @relation(fields: [taskId], references: [id], onDelete: Cascade)

  @@unique([taskId, type])
  @@index([taskId, state])
}
```

Add the reverse relation `approvals TaskApproval[]` on `Task`.

**`services/tasks-api/src/routes/taskApprovals.ts`** — new routes mounted under `/api/v1`:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/tasks/:id/approvals` | List approvals for the task |
| `POST` | `/tasks/:id/approvals` | Approve. Body: `{ type, owner, note? }`. Upserts on `(taskId, type)`. |
| `DELETE` | `/tasks/:id/approvals/:type` | Revoke. Sets `state=revoked, revokedAt=now()`. Does not delete the row. |

The `POST` route is idempotent: a second call for the same `(taskId, type)` updates `owner`, `note`, and re-stamps `approvedAt`. The `DELETE` is idempotent: a second call is a no-op (already revoked).

These routes do not modify `Task.description` and do not create `TaskComment` rows. They are intentionally orthogonal to the existing comment-based tag system during the migration window.

**`services/tasks-api/src/routes/tasks.ts`** — extend `GET /tasks` and `GET /tasks/:id` to include `approvals: TaskApproval[]` in the JSON shape. Optional `?include=approvals` query flag keeps response size predictable for list endpoints; always included on `GET /tasks/:id`.

### WS2 — taskType → required-approvals mapping (AC3)

**`.openclaw/tasks-api/required-approvals.yaml`** — out-of-repo config:

```yaml
# Editable by Quinn or Tom without a code deploy.
# `services/tasks-api` reads this on startup and exposes the map at
# `GET /api/v1/task-types/:taskType/required-approvals`.
version: 1
mappings:
  feature: [spec, tech_design, qa]
  code: [tech_design, qa]
  content: [spec, qa]
  research: []
```

The Tasks API loads this file at startup; if the file is missing it falls back to a built-in default (the contents of the file as shown above, hard-coded in `services/tasks-api/src/config/requiredApprovals.ts`). The fallback is logged at WARN level so an accidental `.openclaw` edit that breaks the YAML is loud.

**`services/tasks-api/src/config/requiredApprovals.ts`** — small wrapper:

```ts
export interface RequiredApprovalsConfig {
  version: number;
  mappings: Record<string, ApprovalType[]>;
}

export async function loadRequiredApprovalsConfig(): Promise<RequiredApprovalsConfig> { ... }
export function requiredApprovalsFor(taskType: string | null): ApprovalType[] { ... }
```

**`GET /api/v1/task-types/:taskType/required-approvals`** — read-only endpoint that returns the resolved list for a given task type. The lobster reads this once per `load-task` invocation and caches for the run.

**`PATCH /api/v1/tasks/:id`** does NOT accept approval state — approvals go through the dedicated `POST` / `DELETE` endpoints. This keeps the partial-update semantics of `PATCH /tasks/:id` (which today accepts `status`, `priority`, `assignee`, `tags`, `specChecksum`, `description`, `dependsOnIds`) from leaking approval writes into the drift-guarded surface.

### WS3 — Lobster reads from API fields (AC4)

**Branch:** `task-ffa30da7-feature-task-lobster-approval-rewire` (separate branch — the lobster is a separate Rust crate with its own build cycle).

**`agents/workflows/feature-task/src/main.rs`** — add a helper:

```rust
/// Resolve the approval state for `approval_type` on `task`.
/// Reads `task.approvals` first; falls back to legacy comment-tag
/// detection (e.g. `[tech-design-approved] true`, `[qa-ac-verified] true`,
/// `**Approved by Tom**` in description) only if no structured row
/// exists. Logs a WARN on fallback so we can see migration progress.
pub fn approval_state(task: &Task, approval_type: ApprovalType) -> ApprovalState { ... }
```

The three gate sites that currently read text are:

1. `ready_checks` — reads `[tech-design-approved] true` and `specChecksum`. Replace with `approval_state(task, TechDesign) == Approved && approval_state(task, Spec) == Approved` plus the existing `specChecksum` check (drift detection stays).
2. `verify_delivery` — reads `[qa-ac-verified] true` (during `acceptance → done`). Replace with `approval_state(task, QA) == Approved`. The AC-text check stays — that's a separate concern.
3. `spec_check` — reads `**Approved by Tom**` in the description. Replace with `approval_state(task, Spec) == Approved`. Falls back to description parsing if no structured row exists.

**Legacy fallback contract:** the legacy text paths stay intact for at least one release after this lands. A new flag `--approval-source=auto|api|legacy` on the lobster CLI defaults to `auto` (try API first, fall back to legacy). When `auto` falls back, it emits a stderr WARN line. The migration script (WS4a) and a follow-up run of the lobster on the full task set will populate the structured rows; once the structured coverage exceeds ~99%, a later task can flip the default to `api` and remove the legacy paths entirely.

This is the **riskiest** WS: the lobster is binary-only and a regression here blocks the lobster cron. Mitigation: keep the legacy paths in place, gate the WS3 PR behind a green feature-factory dry-run on the full active task set, and require Quinn to manually run `feature-task ready-checks --approval-source=auto` on at least one feature task in `ready` and one in `doing` before merge.

### WS4 — Migration + UI (AC5, AC6)

**WS4a — Migration script (AC5):**

**`services/tasks-api/scripts/migrate-legacy-approvals.ts`** — one-shot Node script. Algorithm:

1. Fetch every non-archived task via `GET /api/v1/tasks?limit=200&cursor=...`.
2. For each task, inspect:
   - `**Approved by Tom**` checked in description → `INSERT TaskApproval (type=spec, owner='Tom', state=approved)`.
   - `[tech-design-approved] true` comment → `INSERT TaskApproval (type=tech_design, owner=comment.author, state=approved)`.
   - `[qa-ac-verified] true` comment → `INSERT TaskApproval (type=qa, owner=comment.author, state=approved)`.
   - `- [ ] **Approved by Tom**` in description → no `spec` row (correctly absent).
3. Skip rows that already exist (idempotent on `(taskId, type)`).
4. Emit a JSON summary: `{ totalTasks, createdApprovals, skippedExisting, breakdownByType }`.

Two modes:
- `--dry-run` — runs the algorithm, prints the summary, makes no DB writes.
- `--write` — runs the algorithm and writes via the new `POST /tasks/:id/approvals` endpoint (so the audit trail goes through the canonical write path).

Required safety steps before the `--write` pass:
1. Snapshot the `task_approvals` table (and `task_comments` if needed for rollback audit).
2. Run `--dry-run` first; require the summary to look sane (count ≈ number of tasks with at least one legacy approval signal).
3. Smoke-test the lobster on a single feature task in `ready` with `--approval-source=auto` to confirm it now reads from the structured row.
4. Then `--write`.

A `--rollback <snapshot-path>` option restores from the snapshot if a follow-up lobster run shows regression. Rollback is intentionally crude (drop all rows from the snapshot's `(taskId, type)` set) — the legacy comments and description checkboxes are untouched, so the system reverts to the pre-migration behavior immediately.

**WS4b — Tasks UI (AC6):**

**`apps/tasks/src/tabs/TaskDetail.jsx`** — extend the task detail view to render an `Approvals` section:

```
Approvals
  Spec          Approved by Tom on 2026-07-15
  Tech Design   Approved by Quinn on 2026-07-20
  QA            Pending
```

Each approval renders: type label, state (Approved / Revoked / Pending), owner, timestamp, optional note. The list is sourced from `task.approvals` (always present on `GET /tasks/:id`) and resolved against `requiredApprovalsFor(task.taskType)` so a Pending state is shown for any required type that has no row.

No kanban-card changes. No task-list changes. Just the detail view.

## Test plan (AC verification matrix)

| AC | Test layer | Test file / fixture | Coverage |
|---|---|---|---|
| AC1 | integration | `services/tasks-api/test/integration/taskApprovals.test.ts` | Create approval via `POST`, read via `GET /tasks/:id`, verify JSON shape includes `type`, `owner`, `state`, `approvedAt`. |
| AC1 | unit | `services/tasks-api/test/unit/_approvalRoutes.test.ts` | Verify `?include=approvals` flag works on `GET /tasks`. |
| AC2 | integration | `services/tasks-api/test/integration/taskApprovals.test.ts` | Approve, revoke, re-approve (state transitions). Verify description and comments unchanged. |
| AC2 | integration | `services/tasks-api/test/integration/taskApprovals.test.ts` | Approve via `POST`, then `GET /tasks/:id` — assert no `TaskComment` row was created and `description` bytes equal pre-call. |
| AC3 | unit | `services/tasks-api/test/unit/requiredApprovals.test.ts` | Load `.openclaw/tasks-api/required-approvals.yaml`, assert `feature → [spec, tech_design, qa]`, `content → [spec, qa]`. Fall back to default if file missing. |
| AC3 | integration | `services/tasks-api/test/integration/requiredApprovals.test.ts` | `GET /api/v1/task-types/feature/required-approvals` returns the configured list. |
| AC4 | unit | `agents/workflows/feature-task/src/approval_state.rs` (new file) | `approval_state(task, TechDesign)` reads from `task.approvals` when present, falls back to comment-tag parsing otherwise. |
| AC4 | integration | `agents/workflows/feature-task/test/integration/ready-checks-approvals.test.rs` | Run `ready-checks` against a fixture task with both a `[tech-design-approved]` comment AND a `TaskApproval` row — assert API field wins. |
| AC4 | manual | Quinn-run smoke test on one `ready` and one `doing` feature task with `--approval-source=auto` before WS3 PR merges. |
| AC5 | integration | `services/tasks-api/test/integration/migrate-legacy-approvals.test.ts` | Run the migration script against a fixture set of tasks with the full mix of legacy approval signals; assert correct rows created, idempotent on re-run. |
| AC5 | e2e | `apps/tasks/test/e2e/approvals-display.cy.js` (Playwright) | Pre-migration: a feature task with `[qa-ac-verified] true` comment passes the lobster's `acceptance → done` gate. Post-migration: same task passes after migration has written the `TaskApproval` row and the legacy comment is deleted. |
| AC6 | e2e | `apps/tasks/test/e2e/approvals-display.cy.js` (Playwright) | Open a task detail view; verify the Approvals section renders one row per required type with correct state/owner/timestamp. |

User-visible ACs (AC6) get e2e coverage. The lobster binary tests (AC4) are integration tests with the Rust crate — no e2e is possible because the lobster is not a UI. AC5's pre/post-migration behavior is verified end-to-end through the lobster running on fixture data.

## Risks and tradeoffs

1. **Lobster binary regression (WS3).** The lobster is rebuilt on every release and any regression in `approval_state()` blocks the feature-task cron. Mitigation: legacy fallback paths stay in place for at least one release, `--approval-source=auto` defaults to API-with-fallback, and Quinn smoke-tests on at least one feature task in each of `ready` and `doing` before the WS3 PR merges.

2. **Migration script partial failure (WS4a).** If the script fails mid-way, in-flight tasks lose their approval state. Mitigation: `--dry-run` first, snapshot-before-write, `--rollback` from snapshot, smoke-test on a single task, then `--write`. The script is also idempotent on `(taskId, type)`, so a re-run picks up where the failure left off without duplication.

3. **`.openclaw/` config edit path.** Quinn or Tom must edit `tasks-api/required-approvals.yaml` for any new gate. Today `.openclaw/` is Quinn's domain via the `[openclaw-needed]` protocol. No new tooling is needed, but the change is gated on Quinn being available. If the file is missing or malformed, the Tasks API falls back to the hard-coded default — this is logged at WARN level so Quinn notices.

4. **Approval `owner` field is a string, not a foreign key.** This matches the existing `Task.assignee` convention (also a free-text string) and lets humans and agents both post approvals without a separate identity service. Trade-off: no referential integrity on `owner`. Acceptable for v1; if abuse becomes a problem, a follow-up can switch to a username enum.

5. **No approval expiry.** Approvals stay approved until explicitly revoked. Matches current behavior (no expiry on `[tech-design-approved]` either). Out of scope for v1.

6. **Spec file (`brain/tasks/specs/in-progress/tasks-api-native-approvals-2026-07-17.md`) is not present in this worktree.** I cannot quote it verbatim or link to it in the `product_spec:` frontmatter. See Open question Q1.

## Open questions

1. **Q1 — Spec file location.** The task description points at `brain/tasks/specs/in-progress/tasks-api-native-approvals-2026-07-17.md`. This file does not exist anywhere in `brain/tasks/specs/` on this worktree (`/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries`). The `brain/` tree at workspace level (`lobster/brain/`) contains no `tasks/specs/in-progress/` subdirectory either. The task description itself (with full AC text + workstream breakdown) is the most complete product spec available. **Decision needed:** is the spec file at a path Quinn expects me to read from (outside this worktree), or is the task description canonical for this design? If the spec lives in Quinn's private tree and is expected to remain there, the `product_spec:` frontmatter field is `n/a` and the task description is the canonical product spec.

2. **Q2 — Revocation policy.** If Tom revokes his `[qa-ac-verified] true` after a PR has already moved the task to `done`, does the revocation matter? My read is **no** — `done` is terminal. The lobster's `post_merge` runs once and records the terminal summary. A revocation on a `done` task would write a `TaskApproval` row with `state=revoked` but the task stays `done`. Worth confirming with Tom.

3. **Q3 — Bookmark-spec approval reuse.** Bookmarks have their own approval flow (the `bookmark-workflow` system doc). The bookmark-approval task `55ac9240` is in `acceptance` and currently DEPENDENCY_BLOCKED on the Tasks API Native Approvals task. Do bookmark-spec approvals get a separate `ApprovalType` value (e.g. `bookmark_spec`), or do they reuse `spec`? My read: reuse `spec` and have the bookmark workflow write a `TaskApproval` row with `owner='Tom'` for each approved bookmark spec. This keeps the type vocabulary small. Worth confirming with Quinn.

4. **Q4 — Default `code` task required-approvals.** My proposed mapping has `code → [tech_design, qa]`. But the code-task workflow today doesn't always have a Tom product sign-off — some code tasks skip the tech design (waiver) and go straight to implementation. Should `code → []` (no required approvals) be the default, with the existing waiver mechanism covering the rest? Worth confirming with Quinn — my tech design proposal needs Quinn's call before WS2 ships.

## `.openclaw` boundary

No `.openclaw/` edits are required from this repo. The WS2 config file lives in `.openclaw/tasks-api/required-approvals.yaml` — Quinn owns that edit via the existing `[openclaw-needed]` protocol.

## Branch / PR plan

| Workstream | Branch | PR | Reviewer |
|---|---|---|---|
| WS1 (data model + endpoint) | `task-ffa30da7-tasks-api-native-approvals` | PR #TBD | Quinn |
| WS2 (required-approvals map) | same | same PR | Quinn |
| WS3 (lobster rewire) | `task-ffa30da7-feature-task-lobster-approval-rewire` | separate PR | Quinn |
| WS4a (migration script) | `task-ffa30da7-tasks-api-native-approvals` | same PR as WS1+WS2 | Quinn |
| WS4b (UI) | `task-ffa30da7-tasks-api-native-approvals` | same PR | Quinn |

WS1+WS2+WS4a+WS4b ship together in a single PR (single migration + UI surface + API change is one coherent review unit). WS3 lands separately because the lobster crate has its own build cycle and a lobster regression blocks the cron — separate PR keeps the blast radius small.

Quinn merges after Quinn approval + green CI per the standard merge rule.

## Decisions needed before implementation

1. Resolve Q1 (spec file location). If the task description is canonical, no action; if Quinn expects me to read the spec from a private path, Quinn provides the URL and I link it.
2. Resolve Q2 (revocation policy on `done` tasks).
3. Resolve Q3 (bookmark-spec approval reuse).
4. Resolve Q4 (default `code` task required-approvals).
5. Quinn approves the tech design at the linked branch blob URL.