---
status: draft
task_id: d9cd8a83-df2b-49e8-9f28-c28eec88d035
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Add a pending ApprovalState — tech design

## Links

- Task: `d9cd8a83-df2b-49e8-9f28-c28eec88d035` (`💻 Add a pending ApprovalState so required gates exist from task creation`)
- Tasks API record: `http://localhost:4001/api/v1/tasks/d9cd8a83-df2b-49e8-9f28-c28eec88d035`
- Lobster migration that introduced the `revoked`-as-outstanding hack: docs/specs/add-ash-qa-agent-verifier-gate-tech-design.md (task `f6a4d56a`), "open-question #1 fallback path"

## Goal

Make "this approval has not yet been granted" a first-class state on the approval
row instead of reusing `revoked` as a proxy. After this lands:

1. `POST /tasks` materializes one **pending** row per required approval type in
   the same transaction, so every required gate has a queryable, identity-stable
   row from the moment the task exists. No required gate is ever absent.
2. The feature-task lobster no longer needs its `ensure_qa_agent_gate` POST-then-
   DELETE bootstrap (the row already exists).
3. Every existing gate-check predicate treats `pending` the same way it already
   treats a missing row — "not satisfied" — so no shipped task's pass/fail outcome
   changes.

## Why a third state, not a new table

`TaskApproval` already enforces "one row per (taskId, type)" via the
`TaskApproval_taskId_type_key` unique index. Required gate rows need that same
identity stability: a row that can be addressed by primary key for upsert
(idempotent re-approve) and by `state` for outstanding-gate derivation
(`workflowGates`). Adding a `state = pending` value keeps the existing FK /
audit / index surface area intact and avoids a parallel `PendingApproval` table
that would have to stay in sync with `TaskApproval` on every transition.

Concretely: the `pending` row is created with `state = pending`, `approvedAt =
null`, `revokedAt = null`, `owner = '<approval-type default>'` (the configured
gate owner from `requiredApprovals.yaml`, e.g. `Tom` for `spec`, `Ash` for
`qa_agent`). The first POST flips it to `state = approved` via the same upsert
path the existing route already implements; explicit DELETE flips it to
`state = revoked` (with `revokedAt` set), preserving the audit-trail semantics
documented on the `TaskApproval` model.

## Service boundary and ownership

| Concern | Owner |
|---|---|
| `ApprovalState` enum + Prisma migration | Tasks API |
| `TaskApproval` row creation at task creation | Tasks API (`POST /tasks` transaction) |
| `TaskApproval` row state transitions | Tasks API (`POST/DELETE /tasks/:id/approvals/:type`) |
| Gate reading (allowed/denied) | Tasks API (current behavior, unchanged) + lobster (read-only consumer) |
| `.openclaw/tasks-api/required-approvals.yaml` | Quinn/Tom (operator config — no schema change here) |

The Tasks API is the durable source of truth for `TaskApproval` rows. The
lobster is a reader, not a writer. The previous bootstrap route POST/DELETEd
through the lobster service credential to keep workflow invocations working
before this fix existed; once the POST `/tasks` transaction creates real
`pending` rows, the lobster can stop fabricating them. **No new producer of
approval rows appears here** — only one producer moves earlier in time.

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-d9cd8a83-add-pending-approval-state`
- Worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-d9cd8a83-add-pending-approval-state`
- No secondary repos.

## `.openclaw` boundary

- No `~/.openclaw/` writes required for this task itself.
- No new cron jobs; no new secrets, tokens, or environment variables.
- The `required-approvals.yaml` loader is unchanged. `pending` rows reuse the
  existing `DEFAULT_APPROVAL_OWNERS` map (already global per approval type).

## Implementation plan

### 1. Prisma migration: add `pending` to `ApprovalState`

New file `services/tasks-api/prisma/migrations/<timestamp>_add_approval_state_pending/migration.sql`:

```sql
-- New `pending` value on `ApprovalState`: the durable "this required gate
-- has a row, but the gate has not been granted yet" state. Replaces the
-- `revoked`-as-outstanding hack documented in
-- docs/specs/add-ash-qa-agent-verifier-gate-tech-design.md (task f6a4d56a).
--
-- Implementation note: same Prisma-transaction + "new enum value must be
-- committed before use" restriction that already applies to `ApprovalType`
-- per the existing 2026-08-18 migration. Recreate the enum inside one
-- transaction using the same pattern; the existing `('approved', 'revoked')`
-- rows are preserved verbatim because the type is widened (not renamed).
--
-- Preflight (run before applying):
--   SELECT state, count(*) FROM "TaskApproval" GROUP BY state;
-- Expected (intentionally chosen to be empty, see step 2): zero `pending`,
--   any count of `approved` and `revoked` rows.
-- Post-apply: same query. Expected: zero `pending` rows again (the migration
--   does NOT back-fill existing rows; see "Migration ordering" below).

ALTER TYPE "ApprovalState" ADD VALUE IF NOT EXISTS 'pending';
ALTER TYPE "ApprovalState_new" RENAME TO "ApprovalState";  -- not literally;
                                                       -- see recreate below
```

Concrete migrate.ts (matches the pattern in
`20260818000000_extend_approval_types_rename_qa_to_accepted/migration.sql`):

```sql
ALTER TYPE "ApprovalState" ADD VALUE IF NOT EXISTS 'pending';

CREATE TYPE "ApprovalState_new" AS ENUM ('pending', 'approved', 'revoked');
ALTER TABLE "TaskApproval" ALTER COLUMN state TYPE "ApprovalState_new"
  USING state::text::"ApprovalState_new";
DROP TYPE "ApprovalState";
ALTER TYPE "ApprovalState_new" RENAME TO "ApprovalState";
```

This ordering follows the same `ADD VALUE IF NOT EXISTS` + recreate-enum pattern
already used for `ApprovalType` in the 2026-08-18 migration; both restrictions
("new enum value must be committed before use" and "DROP VALUE cannot run
inside a transaction") apply identically here.

### 2. `services/tasks-api/prisma/schema.prisma`

Add `'pending'` to the `ApprovalState` enum in the same order as the SQL.

```prisma
enum ApprovalState {
  pending
  approved
  revoked
}
```

### 3. Regenerate the Prisma client

`pnpm --filter @sindustries/tasks-api prisma generate` (script already in
`services/tasks-api/package.json`). The generated client gains the new variant
automatically. No hand-edits.

### 4. `services/tasks-api/src/routes/tasks/_constants.ts`

Add `'pending'` to the mirrored `validApprovalStates` set so the route-layer
vocabulary stays in sync with the Prisma enum (per the file's own comment).
The set is currently a vocabulary mirror only (not yet imported anywhere
synchronously), so this is documentation-level rather than functional.

```ts
export const validApprovalStates = new Set(['pending', 'approved', 'revoked']);
```

### 5. `services/tasks-api/src/lib/migrateLegacyApprovals.ts`

Widen the local `state` type union to include `'pending'`. This file is part
of the legacy migration helper that backfills structured rows from the old
`- [x] AC<...> Approved by <actor>` description markers. It does not create
`pending` rows (it only creates `approved`/`revoked` based on observed
marker presence), so the wider type is purely for compilation correctness.

### 6. `services/tasks-api/src/routes/tasks.ts` — `POST /tasks`

Inside the existing `POST /tasks` transaction (currently a single
`prisma.task.create({ … })` call), expand to a `prisma.$transaction(async (tx)`
=> …`) so the task row and its pending-approval rows commit atomically. Read
required approval types from the existing
`loadRequiredApprovalsConfig() / requiredApprovalsFor(config, taskType)`
helper — already used by the `requiredApprovals` GET route and the lobster's
required-approvals fetch, so no new policy surface.

When `taskType` is supplied and the resolved required list is non-empty,
create one row per type with:

```ts
create: {
  taskId: created.id,
  type,
  owner: gateOwnerFor(config, type) ?? 'Unknown',
  state: 'pending',
  // approvedAt / revokedAt intentionally omitted (null defaults)
}
```

The `owner` should be the configured gate owner (e.g. `'Tom'` for `spec`,
`'Ash'` for `qa_agent`). For research tasks or any task where the loader
returns `[]`, no rows are created (existing behavior — research has no
required approvals). For `taskType: null`, no rows are created (mirrors
existing behavior — required-approvals lookup returns `[]` for null taskType).

The `TaskApproval_taskId_type_key` unique index naturally upserts if the same
type is requested twice; we create exactly one row per required type, so
duplicates are impossible.

No audit comment is posted at task creation. Audit comments are reserved for
human/agent decisions (POST approval, DELETE revoke, Tasks-API auto-revoke on
spec drift per task `e2aba106`). "Created pending" is a system event with no
decision to record; the row's `createdAt` is the audit trail.

### 7. `agents/workflows/feature-task/src/main.rs` — drop the bootstrap

Remove:

- The `ensure_qa_agent_gate` function entirely (lines 1137–1189, plus its
  41-line doc comment block at 1109–1136).
- The call site at line 787 inside `verify_delivery` (delete the
  `let _ = ensure_qa_agent_gate(&args, &env);` line).
- The reference comment at line 617 (it cross-references a function that no
  longer exists).

Drop `feature_task_lobster` from the `qa_agent` service credential grant in
`approvalAuth.ts:ACTOR_PERMISSIONS`. With pending rows created at task
creation, the lobster no longer needs POST/DELETE on `qa_agent` — Ash owns
the only transition into `approved` for that gate type. (`qa_agent` actor
permission may remain `'write'` or be downgraded to `'read'`, per convention
from the credential-loader surface; whichever minimizes churn in the test
suite — see Test plan.)

`feature_task_lobster` retains its `add_comment` / read-only surface; the
lobster still authenticates with `FEATURE_TASK_LOBSTER_TOKEN` for everything
that is not an approval row write.

### 8. No other code changes

- `services/tasks-api/src/routes/taskApprovals.ts` — `validApprovalStates`
  is the only vocabulary check and is unused synchronously. The POST /
  DELETE handlers never take `state` from the request body (state is
  server-derived from actor + intent), so no validation widening is needed.
- `services/tasks-api/src/routes/tasks/_mapper.ts` line 133 — the
  `(task.approvals ?? []).filter((a) => a?.state === 'approved' && !a.revokedAt)`
  predicate already excludes `pending` rows from "currently approved".
  `pending` rows naturally fall through to `derivedGates` as
  `state: 'outstanding'`, which is the correct surface for the
  workflow-gates field. AC4 is satisfied without a one-character change.
- `agents/workflows/feature-task/src/main.rs:1065` —
  `task_approval_granted(task, type)` returns `true` only when
  `state == "approved"`. Pending rows return `false` via the existing
  "fail closed" semantics documented on the function: *"Missing, revoked,
  and unknown states fail closed."* The gate readers
  (`spec_approval_granted`, `qa_agent_verified`, `accepted_structured`,
  `tech_design_granted`) all delegate through this predicate.
  AC4 is satisfied for every Rust-side gate reader without a one-character
  change.

## Migration ordering

Postgres backfill is **not** part of this migration. The migration only adds
the enum value; existing rows keep their `state = approved`/`revoked`
values. Out of the 33 tasks assigned to Rowan visible in the heartbeat queue
at the time of writing, all are in `open`/`acceptance`/`doing`/`ready` —
they were created under the bootstrap pattern and currently have
`state = revoked` rows for `qa_agent`. After this PR merges:

- New tasks (created after deploy) get real `pending` rows.
- Existing tasks keep their existing `revoked` `qa_agent` rows. They are
  correct (`qa_agent_verified` returns `false` on `revoked`, same as on
  `pending`), but the audit body now says "revoked" instead of "outstanding".

This is acceptable because the lobster's audit trail distinction between
"revoked" and "outstanding" was implicit and only visible to the queue
viewer, not the Tasks API. AC4 forbids any change to *gate pass/fail
outcome* — not to row text — so the existing rows remain correct.

If a future task wants to back-fill existing `revoked` `qa_agent` rows to
`pending` (semantically closer to the truth), that is a separate piece of
work: it would need to confirm each row is "still pending" by checking
that no `qa_agent` approval has been granted in between. Out of scope for
this design.

## Test plan

### AC-by-AC verification matrix

| AC | Verification |
|---|---|
| AC1 (`pending` enum value exists) | New migration applies on a fresh DB; `prisma.validate` passes; integration test queries `enum_range(NULL::"ApprovalState")` post-migration and asserts `'pending'` is a value. **Test layer: integration** (Vitest + real Postgres, per existing test layout). No E2E needed — enum shape is internal. |
| AC2 (`POST /tasks` creates pending rows) | New integration test: POST a `taskType: feature` task, expect 201 with the response containing `approvals` of length 4 (spec, tech_design, qa_agent, accepted), each with `state: 'pending'` and the correct `owner` from `DEFAULT_APPROVAL_OWNERS`. POST a `taskType: research` task, expect `approvals: []`. POST without `taskType`, expect `approvals: []`. **Test layer: integration.** The existing `taskApprovals.test.ts` transactional mocks extend naturally. |
| AC3 (`ensure_qa_agent_gate` removed) | Run `cargo check` in `agents/workflows/feature-task`. Confirm no remaining references to `ensure_qa_agent_gate` in the crate. The lobster's `tests/…/verify_delivery.rs` no-ops the bootstrap call (already conditional on env token) — that test stub is deleted, the test continues to pass because pending rows now exist at task creation. |
| AC4 (every existing gate predicate treats `pending` as missing; no outcome change) | Three layers: (a) **Vitest unit/integration** — extend `taskApprovals.test.ts` with a `'pending row evaluates as outstanding via workflowGates'` case asserting `_mapper.ts:derivedGates` includes a `state: 'outstanding'` entry for each pending type and excludes it from `approvedTypes`. (b) **Rust unit** — add a case to `task_approval_granted` in `tests/…/verify_delivery.rs` asserting the predicate returns `false` for a synthesized approval with `state: "pending"`. (c) **Rust regression** — re-run the full existing `cargo test -p feature-task --test verify_delivery` and `cargo test -p feature-task` test matrices; every existing assert that gates on `state == "approved"`/`state == "revoked"` continues to pass unchanged because `pending` is not equal to either literal. (d) **Vitest regression** — re-run `taskApprovals.test.ts` and `requiredApprovals.test.ts` unchanged; both pass without mod. (e) **E2E optional** — write one integration test asserting a `taskType: feature` task with `pending` approval rows cannot reach `done` via the existing lobster state machine, because `spec_check`, `ready_checks`, `verify_delivery`, and `feedback_aggregate` each evaluate at least one required gate and refuse without an `approved` row. This is the "no observable change to any existing task's gate pass/fail outcome" guarantee from AC4 at the user-visible layer. |

### Coverage of the rollback story

The migration is non-destructive (additive enum-value widening). The
recreate-enum step maps `'approved' → 'approved'`, `'revoked' → 'revoked'`
via the `USING` clause, so existing rows survive. A `git revert` of this PR
on top of a fresh migration would require a symmetric
`ALTER TYPE "ApprovalState" { DROP VALUE 'pending' }`-equivalent recreate
back to `('approved', 'revoked')`, dropping any `pending` rows created
between deploy and revert. Because the migration adds a step before any
`pending` rows can be created (the durable change is the `POST /tasks`
expansion, which is in the same PR), revert is recoverable in a single
release cycle with no data loss for tasks that had not yet been created
since deploy.

## Open questions and risks

1. **Approval-type defaults for the `owner` field on pending rows.**
   For `spec`, `tech_design`, `qa_agent`, `accepted` the `owner` is the
   configured gate owner (`DEFAULT_APPROVAL_OWNERS`). For unknown types
   present in a future YAML edit, the design falls back to the literal
   `'Unknown'`. The lobster-side `task_approval_granted` predicate does not
   read `owner`, so this fallback has no behavioral impact — the row is
   still recognized as the type's gate by `(taskId, type)`. **Risk:** any
   human UI that filters approvals by `owner` to highlight "your
   outstanding gates" will show "Unknown" for typos until the YAML is fixed.
   **Mitigation:** prefer the same lenient-skip behavior the YAML loader
   already uses (`validApprovalTypes.has(approvalType)` guards in
   `parseRequiredApprovalsYaml`) and surface a startup log if any
   required type has no configured owner. The `gateOwnerFor` helper already
   returns `null` for unknown types — pass that through as the `owner`
   value (null is valid on the column). **Decision pending:** confirm with
   Quinn whether `owner = null` on pending rows is acceptable, or whether
   the loader should fall back to `'Unknown'` for backward compatibility
   with any UI that filters by non-null owner. Trivial to resolve at
   implementation time.

2. **Lobster audit comments for the bootstrap removal.**
   The deleted `ensure_qa_agent_gate` previously wrote a short audit body
   — *"[lobster] initial qa_agent gate (revoke-as-outstanding proxy)"* —
   into the `note` field of the bootstrapped `revoked` row. Existing
   rows retain that note. New tasks get no such note (the `pending`
   row is created without a note, since the lobster no longer authors
   approval rows). **Risk:** low. The note is informational; no UI
   depends on it; the audit trail via `TaskComment` is unaffected.

3. **`feature_task_lobster` service credential downgrade.**
   With pending rows created at task creation, the lobster no longer
   needs to write `qa_agent` approvals. The credential can be downgraded
   from `'write'` to `'read'` (or removed entirely from the qa_agent
   grant). This requires a YAML/credential-file change in
   `approvalAuth.ts:ACTOR_PERMISSIONS`. **Risk:** low. The lobster
   still needs write access on `add_comment` for normal operation. Only
   the `qa_agent`-specific grant changes. **Decision pending:** confirm
   with Quinn whether to keep the `feature_task_lobster` qa_agent grant
   at `'write'` (paranoia for future bootstrap exceptions) or to
   downgrade it on the same PR. The default in this design is
   **downgrade**, on the principle that reduced credential surface is
   safer and the durability of the pending row is sufficient.

## DoD checklist

- [ ] New Prisma migration checked in
- [ ] `prisma.schema` updated + `prisma generate` re-run
- [ ] `validApprovalStates` extended for vocabulary mirror
- [ ] `migrateLegacyApprovals.ts` widened for compilation
- [ ] `POST /tasks` writes `pending` rows in a single transaction
- [ ] `ensure_qa_agent_gate` and its test stub removed from the lobster
- [ ] `feature_task_lobster` qa_agent grant downgraded in `approvalAuth.ts` (or kept, per open question 3)
- [ ] AC verification matrix executed; all pass
- [ ] `cargo test -p feature-task` passes
- [ ] `pnpm --filter @sindustries/tasks-api test` passes
- [ ] `docs/systems/tasks.md` updated (the lobster-state-machine section
      needs a paragraph covering the new pending row semantics)
- [ ] `apps/mission-control/SPEC.md` updated only if a user-visible
      approval-rendering change ships with the PR (it should not — the
      mapper already filters on `state === 'approved'`)
- [ ] PR opened with AC checklist per `agents/skills/dev/pr-open/SKILL.md`
