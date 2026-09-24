---
status: draft
task_id: 91864257-df70-4256-be40-e8e05cc7c4e4
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Make Attention-Owner Escalations Deduplicated, Explainable, and Resolvable — Tech Design

## Links

- Task: `91864257-df70-4256-be40-e8e05cc7c4e4` (`💻 Make attention-owner escalations deduplicated, explainable, and resolvable`)
- Task API detail: `http://localhost:4001/api/v1/tasks/91864257-df70-4256-be40-e8e05cc7c4e4`
- Existing system doc: `docs/systems/tasks.md` (subsection *TaskAttentionOwner*)
- Existing app spec: `apps/tasks/SPEC.md`
- Predecessor tech designs (non-normative context): `docs/specs/d8fbe750-wire-attention-owners-tech-design.md`, `docs/specs/reconcile-attention-on-approval-tech-design.md`, `docs/specs/fix-lobster-attention-owners-reconciliation-draining-tech-design.md`

## Scope

- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-91864257-attention-owner-dedupe`
- Worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-91864257-attention-owner-dedupe`
- Primary code surfaces:
  - `services/tasks-api/src/routes/tasks.ts` — PATCH `attentionOwners` normalization (case-insensitive dedupe)
  - `services/tasks-api/src/routes/tasks/_validation.ts` — `normalizeAttentionOwners` returns dedup-collapsed set
  - `services/tasks-api/src/routes/taskApprovals.ts` — strip `attentionOwners` side-effect from `approvalHandoffUpdate`; gate ownership stays in `workflowHandoffRoleId/Gate/Reason` only
  - `services/tasks-api/src/routes/taskAttentionOwners.ts` *(new)* — per-row POST/PATCH/DELETE endpoints + `/self-resolve` endpoint
  - `services/tasks-api/test/taskAttentionOwners.test.ts`, `services/tasks-api/test/taskAttentionOwnersApi.test.ts` *(new)*
  - `services/tasks-api/scripts/dedupe-attention-owners.ts` *(new)* — idempotent repair path (mirrors `migrate-legacy-approvals.ts` flags: `--dry-run` / `--write` / `--rollback`)
  - `apps/tasks/src/components/StackedAvatarGroup.jsx` — cross-role visual dedupe; per-row `note` carried into the accessibility label and detail tooltip
  - `apps/tasks/src/components/AttentionOwnersPanel.jsx` *(new)* — in-task edit surface for the ordered stack (add with required reason, reorder, edit reason, remove, resolve my blocker)
  - `apps/tasks/src/tasksApi.ts` — TS bindings for the new endpoints
  - `apps/tasks/test/e2e/attention-owners.spec.js` *(new)* — Playwright user-flow coverage
  - `agents/skills/ops/tasks-api/tasks_api_client.py` — extend `add_self_to_attention_owners` to surface a required `note`; add `resolve_own_attention_owner`
  - `docs/systems/tasks.md`, `apps/tasks/SPEC.md` — durable doc updates for the new write contract, repair path, and UI flows

No `.openclaw` runtime change. No DB migration (existing `TaskAttentionOwner.note` and `TaskAttentionOwner.addedBy` columns are already in `schema.prisma`). No shared-package change. No Rust/lobster code change required — the lobster already writes `attentionOwners` exclusively through `api_patch`, which goes through the new normalization (item 1), and the approval side-effect removal (item 3) leaves the lobster as the sole writer of the stack.

## Problem summary

`attentionOwners[0]` is the next actionable owner; later entries are the ordered escalation path. Three control-plane defects make the current model unsafe in practice:

1. The PATCH endpoint accepts case-insensitive duplicates (e.g. `[Quinn, quinn]`). The mapper preserves them, the stack ends up with the same person twice, and the top-of-stack resolves to the first regardless of which one was the most recent add.
2. Approval writes for `tech_design` / `qa_agent` / `accepted` reach into the `attentionOwners` table from `approvalHandoffUpdate` and rewrite the entire stack (prepend-on-revoke / head-pop-on-approve). That stacks an explicit attention request on top of the gate-plane signal, producing duplicates and making gate ownership show up as both an `attentionOwners` row *and* a `workflowGates` entry for the same person.
3. There is no per-row write contract — every add is a full-replacement PATCH, so `note` and `addedBy` survive only by accident when the same `(taskId, owner)` pair reappears in the new array. No endpoint exists for "I am the current top, my blocker is gone, drop just me".

The UI amplifies the problem: `StackedAvatarGroup` renders every role independently, so the same person can appear as delivery assignee + workflow-gate owner + attention-head all at once, and the task card never surfaces why the attention request was raised.

## Implementation plan

### 1. Normalize case-insensitive duplicates in the PATCH path

In `services/tasks-api/src/routes/tasks/_validation.ts`, replace the current implementation of `normalizeAttentionOwners` so it returns an `{ owners: [...], collapsed: [...] }` pair where `owners` is the dedupe-collapsed set (first occurrence of each case-insensitive name wins; later case-equivalent entries drop out, position of the kept entry is preserved) and `collapsed` is the array of dropped names for the audit trail. The first-occurrence ordering matches the explicit AC1 wording "preserving the first occurrence's position".

In `services/tasks-api/src/routes/tasks.ts`, the PATCH handler:

- Persists `owners` (the normalized set).
- Emits a `TaskComment` with body `Attention owners normalized: dropped duplicate "[<name>]" (case-insensitive)` for each dropped name. The comment author is `Tasks API`. The comment is the audit evidence for an idempotent re-PATCH.
- Returns 200 with the post-normalization mapper output (so the UI gets the canonical set on the same round-trip).

Caps stay at 16 entries / 64 chars per name. Empty strings still 400.

This is intentionally idempotent (200 + normalized list) rather than 400 + reject, because the AC1 wording permits either and a self-resolving client wants re-PATCH with the same input to be safe.

### 2. Per-row write endpoints for the attention stack

New file `services/tasks-api/src/routes/taskAttentionOwners.ts` exposes four endpoints under `/tasks/:id/attention-owners`. All require `requireAuth` (the existing `tasks-api/src/middleware/requireAuth.ts`) — they are general-mutation routes, not approval-specific. Per-route authorization is enforced in the handler:

| Method | Path | Body | Authz | Behaviour |
|---|---|---|---|---|
| `POST` | `/tasks/:id/attention-owners` | `{ owner: string, note: string, position?: 0 \| non-negative int }` | any authenticated actor (Tom/Quinn/Rowan/Lox/Ivy/...) | `note` is **required** (non-empty after trim, max 500 chars). `position` defaults to `0` (head insert); later positions shift the tail down by one. `addedBy` is set to the authenticated actor. Transaction includes the audit comment `Attention owner "<owner>" added at position <n> by <actor>: <note>`. 400 on missing/empty `note` (closes AC2). |
| `PATCH` | `/tasks/:id/attention-owners/:rowId` | `{ owner?: string, note?: string, position?: 0 \| non-negative int }` | Top-of-stack actor (matches `task.attentionOwners[0]` after case-insensitive trim compare) OR `Tom`/`Quinn` | Rename / move / edit note on a single row. At least one mutable field is required. Reordering preserves the relative order of all other rows. Move validation: if the new `position` equals the current one this is a no-op (200). Returns 200 with the post-update mapper output. |
| `DELETE` | `/tasks/:id/attention-owners/:rowId` | `{}` | Top-of-stack actor OR `Tom`/`Quinn` | Removes exactly the targeted row; renumbers positions contiguously. Records audit comment `Attention owner "<owner>" removed by <actor>: <reason>`. `reason` is optional. |
| `POST` | `/tasks/:id/attention-owners/self-resolve` | `{ note?: string }` | Authenticated actor whose case-insensitive trim equals `task.attentionOwners[0]` | Removes the **current top** row only; later rows renumber up by one. Preserves `dependencyBlocked`, `task.blocked`, `assignee`, `approvals`, `workflowGates`. 403 if `attentionOwners` is empty or the current top doesn't match the actor. Records audit comment `Attention blocker for <actor> resolved: <note>`. |

Authorization rules in plain English:

- **"Top-of-stack actor"** = authenticated user whose normalised name equals `task.attentionOwners[0]`, after trim+lower-case compare.
- **Tom/Quinn** are the only override path because every `Rowan`/`Ash`/`Lox` task is already handled by their own credential; anyone other than the top-of-stack actor needs Tom/Quinn authorization (matching the lobster's escalation policy).
- The endpoints never write to `TaskDependency`, `Task` (other than the position renumber), `TaskApproval`, or `workflowHandoffRoleId/Gate/Reason`. The existing cross-row validation contract stays — assert in tests that none of those planes mutate.

API responses keep the existing `mapTask` shape so the Tasks app sees `attentionOwners`, `topAttentionOwner`, and `attentionOwnerDetails` exactly as today.

### 3. Approval writes stop touching the attention stack

In `services/tasks-api/src/routes/taskApprovals.ts`:

- `approvalHandoffUpdate(task, type, action)` keeps the `workflowHandoffRoleId / workflowHandoffGate / workflowHandoffReason` writes (the gate-plane field).
- It stops writing `attentionOwners`. The closure of the `update.attentionOwners = { deleteMany, createMany }` branch is the small surgery that lands AC3 — removing the existing `deleteMany`/`createMany` plus the `attentionOwnersForApproval` helper now has no consumers in this file; the helper itself stays exported (the lobster-side Rust calls do their own reconciliation, so the TS helper has no on-Tasks-API caller left, but the export keeps the test surface stable).
- The `attentionOwners` write path that survives is exclusively the lobster's `api_patch` (with the new normalization from item 1) and the new per-row endpoints from item 2.

This separation makes the contract explicit: **gate ownership lives in `workflowHandoffRoleId / Gate / Reason`. Action routing lives in `attentionOwners`. The two planes never co-write.**

### 4. Idempotent repair script

New `services/tasks-api/scripts/dedupe-attention-owners.ts` mirrors the patterns in `scripts/migrate-legacy-approvals.ts`:

- `tsx scripts/dedupe-attention-owners.ts --dry-run` — scans every task with two or more `TaskAttentionOwner` rows; for each, computes the dedupe-collapsed set (per item 1); prints a summary table by task. No DB writes.
- `tsx scripts/dedupe-attention-owners.ts --write` — performs the same scan; for each, runs the collapse inside a single `$transaction`: deletes the duplicate rows in `TaskAttentionOwner`, renumbers `position` contiguously, and emits a `TaskComment` audit row per removed duplicate (`Duplicate attention owner "<name>" (case-insensitive) collapsed by repair script; preserved note: "<note>"`). Snapshots the pre-state to `.openclaw/tasks-api/snapshots/<ts>.json` for rollback.
- `tsx scripts/dedupe-attention-owners.ts --rollback <path>` — restores the snapshot rows.

The script is **the** runbook for AC7. It is intentionally idempotent — re-running `--dry-run` or `--write` after a previous successful write is a no-op (no duplicates left to collapse).

### 5. Frontend: cross-role visual dedupe and reason in accessibility label

In `apps/tasks/src/components/StackedAvatarGroup.jsx`:

- The `buildStackedOwnerLayers` builder gets a new `collapseAcrossRoles` pass: the same case-insensitive name appearing in more than one role renders one avatar per *role tier* (delivery, workflow-gate, attention), but a single name spanning two role tiers is collapsed into the higher-tier role (attention > workflow-gate > delivery). Within the attention tier, repeats are still preserved as separate slots because that is the escalation shape; within delivery and workflow-gate tiers, repeats are impossible by construction (single-row planes).
- The per-row `note` flows into the rendered avatar's accessibility label: a Tom attention request with note `needs eyes on the spec revision` becomes `Tom — attention owner — needs eyes on the spec revision` rather than the current `attention owner Tom`. The truncation rule is "first 80 chars of the note + ellipsis" so the label stays under the WAI-ARIA recommendation.
- `task-owner-stack-item` carries a `data-reason` attribute (the raw note string) so the task details surface can render it without a second API call.
- The 4-and-overflow logic is unchanged because the dedupe pass never grows or shrinks the visible set within a single task.

The existing test `preserves repeated people as separate avatars in the full Rowan/Ash/Rowan stack` is updated — Rowan stays visible as separate slots inside the attention tier (two slots), but a hypothetical Rowan task-card where Rowan is *also* the delivery assignee renders one Rowan avatar (delivery collapsed into attention because it's higher tier). New tests pin:

- the cross-role collapse rule (delivery+attention spans both tiers → one avatar in attention);
- the attention-within-tier repeat rule (Rowan, Rowan, Tom → three attention slots);
- the `data-reason` attribute presence + accessibility label format with a real note.

### 6. Frontend: in-task manage panel + "Resolve my blocker"

New `apps/tasks/src/components/AttentionOwnersPanel.jsx`:

- Renders one row per `attentionOwnerDetails` entry: owner, note (inline-edit text), position chip, addedBy, createdAt. Each row has **remove** and **move up / move down** buttons.
- An "Add attention owner" affordance opens an inline composer that requires both owner and reason inputs. The "Add" submit button is disabled until both are non-empty.
- A "Resolve my blocker" button is rendered **only** when the local user matches `topAttentionOwner`. The button posts to `/tasks/:id/attention-owners/self-resolve`. Successful self-resolve removes the row optimistically and surfaces the `Top-of-stack is now <next owner>` toast.
- Edits call the per-row PATCH / DELETE endpoints. The Add button calls POST `/tasks/:id/attention-owners`. The panel re-renders against the mapper response.
- It is mounted from `TaskEditor.jsx` under a new "Attention owners" section, and from the read-only `TaskDetailDrawer` as a non-editable summary view with reasons shown.

The panel owns no clipboard / toast logic itself — both come from existing helpers (`useToast`, `clipboard`). All four endpoints have task-API wrappers added in `apps/tasks/src/tasksApi.ts`.

### 7. Test plan

The test matrix uses Vitest component + service tests, Playwright E2E for the user-flow ACs, and a snapshot-based migration unit test for the repair script.

| AC | Layer | Test |
|---|---|---|
| **AC1** case-insensitive duplicate rejection / normalisation | Unit (`normalizeAttentionOwners`) | `preserves first occurrence position when later entries are case-equivalent` — input `['Quinn', 'quinn', 'Rowan']` → output `['Quinn', 'Rowan']`. Integration (`tasks.ts` PATCH): PATCH `['quinn', 'Quinn']`, expect 200, mapper shows `attentionOwners: ['quinn', ...]` and the persisted set has one Quinn row. Plus `--dry-run` output of the repair script asserts no remaining duplicates. |
| **AC2** write contract requires reason | Unit | `POST` without `note` → 400 `INVALID_ATTENTION_OWNER_NOTE`. `POST` with empty/whitespace note → 400. `POST` with note → audit `TaskComment` body contains the note text exactly. Mapper response includes the `note` on the new row. |
| **AC3** approval transitions do not create duplicate attention rows | Integration | Service route test: existing approval route test passes still; new test asserts `await prisma.taskAttentionOwner.count({ where: { taskId } })` is unchanged after a `POST /tasks/:id/approvals` for `tech_design`, `qa_agent`, and `accepted`. Approve-then-revoke round-trip counts the rows once. |
| **AC4** UI renders distinct roles + visual dedupe + reason in label | Component | New test cases in `StackedAvatarGroup.test.jsx`: `renders one avatar per person across delivery, workflow-gate, and attention tiers when the name repeats`; `preserves separate attention slots for repeated names within the attention tier`; `exposes the per-row note in the accessibility label and the data-reason attribute`. The earlier `keeps each repeated role slot independently labelled` test name is replaced with `renders distinct role tiers with cross-role dedupe`. |
| **AC5** self-resolve | Integration + UI | Service: `POST /self-resolve` as `Quinn` when `attentionOwners[0] === 'Quinn'` → 200, only the Quinn row removed, `task.blocked`, `dependencyBlocked`, `assignee`, `approvals` unchanged. Same call as `Tom` → 403 `NOT_TOP_OWNER`. Same call when `attentionOwners` is empty → 403. UI: Playwright spec signs in as a known actor, opens a task where they are the top attention owner, clicks "Resolve my blocker", asserts the row disappears and the success toast renders. |
| **AC6** UI edits the ordered stack | UI + Playwright | Component: `AttentionOwnersPanel` tests cover add (with required reason), remove, move up/down, edit reason. Playwright spec covers the full user journey in `test/e2e/attention-owners.spec.js`: open task → add row with reason → assert UI reorders → edit reason → assert the `data-reason` updates → remove a row → assert the persistence survives a page refresh. |
| **AC7** repair path + tests for every other AC | Service + script | New `dedupe-attention-owners.test.ts` instantiates a Prisma fixture with duplicate rows, runs the script in `--dry-run` mode (no DB writes), then `--write` mode and asserts the duplicate is gone, `note` preserved from the kept row, audit comment present. `--rollback` restores the snapshot. Combined with the AC matrix above, every AC has at least one asserted unit / integration / E2E test. |

E2E coverage is planned for AC4 (cross-role dedupe), AC5 (self-resolve), AC6 (manage panel), and the full happy-path AC1+AC2+AC7 cycle. The 422 `e2e` test surface is already large (`apps/tasks/test/e2e/`); one new spec file is proportionate because the new UI surface is non-trivial and the user-flow risk is real.

`.openclaw` boundary coverage is intentionally none — no skill or runtime change.

## Ownership boundary check

- **Natural source of truth:** Tasks API for the write contract and persistence; Tasks app for the read/edit/resolve UI; Lobster (Rust) remains the producer of the ordered stack via `api_patch` with the new normalization in place. No boundary drift; the durable solution is the same shape as the interim shim would be (per-row endpoints + normalization) because both planes already exist (`note`, `addedBy`, `position`, `createdAt` columns are all there).
- **Incremental-delivery posture:** none. The interim shim (separate per-row endpoints added later, normalisation patched later) would be the same shape and the same effort. Doing both in one PR avoids the dual-source-of-truth trap.
- **Cross-service consumers:** none. Tasks app is the only consumer that renders the stack today; Mission Control reads the same mapper output via `workflow_gate_owner` and `attention_owner` filters and is unaffected by the write contract change.
- **Lobster stays in control.** The Rust `reconciled_attention_owners` flow continues to drive the ordered stack via `api_patch`. The repair script is the only writer a human runs; both go through `requireAuth`.

## Data model / API contract changes

- **No Prisma migration.** Existing `TaskAttentionOwner` schema already carries `id`, `taskId`, `owner`, `position`, `addedBy`, `note`, `createdAt` and the `@@unique([taskId, position])` constraint.
- **API contract additions:**
  - `POST /tasks/:id/attention-owners` body `{ owner, note, position? }` → 200 (existing task mapper shape).
  - `PATCH /tasks/:id/attention-owners/:rowId` body `{ owner?, note?, position? }` → 200.
  - `DELETE /tasks/:id/attention-owners/:rowId` → 200 or 204.
  - `POST /tasks/:id/attention-owners/self-resolve` body `{ note? }` → 200.
- **PATCH `/tasks/:id` `attentionOwners`:** contract change is **idempotent normalisation** of case-insensitive duplicates — same input that previously persisted two rows now persists one. The PATCH HTTP contract stays: 200 response with normalised set. This is the only possible behavioural break — see Risks.
- **`taskApprovals.ts`:** approval-write side-effect to `attentionOwners` removed. The `workflowHandoffRoleId / Gate / Reason` writes stay. Net effect: after approval of `tech_design` the `attentionOwners` array is left exactly as the lobster (or a human UI editor) last left it.

## Workflow, cron, and skill changes

- **Lobster (Rust, `agents/workflows/feature-task`):** no code change required. The lobster's `api_patch` path passes its existing normalisation-and-write through the new PATCH normalisation in item 1. The lobster's `reconciled_attention_owners` invariant ("only the head slot routes actionably, lower-slots are dormant") is unchanged because the PATCH normalisation preserves within-stack position order.
- **`agents/skills/ops/tasks-api/tasks_api_client.py`:**
  - `add_self_to_attention_owners(task_id, actor, note)` requires `note` (raises if missing/empty). The Python helper surfaces the note in the audit body and returns the new mapper state so callers can see the post-add `topAttentionOwner`.
  - `resolve_own_attention_owner(task_id, actor, note=None)` calls the new `/self-resolve` endpoint, returns the post-resolve mapper state.
  - `dedupe_attention_owners(task_id=None, dry_run=True)` thin wrapper around the repair script so other skills (cron auto-cleanup) can call it. Default to `dry_run=True` so unattended callers must opt into writes.
- **Cron:** no new cron job. The repair is on-demand. If future automation wants daily de-duping, that is a separate task — out of scope here.
- **Heartbeat (`agents/rowan/HEARTBEAT.md`):** no behaviour change. The `agent_task_queue.py` reads `topAttentionOwner`; the new endpoints do not change that field's semantics.

## Spec / system doc updates

- `docs/systems/tasks.md` subsection *TaskAttentionOwner*: rewrite the "Persistence rules" block to describe (a) case-insensitive normalisation; (b) the four new endpoints with authz summary; (c) the approval-route side-effect removal; (d) the repair script. Keep the ordered-stack, position-0-only-actionable invariant, and the four ownership planes unchanged.
- `docs/systems/tasks.md` subsection *Task ownership planes*: add a row noting that the **action / escalation** plane now refuses case-insensitive duplicates and requires a reason for every newly added row.
- `apps/tasks/SPEC.md`:
  - Add a "Manage attention owners" flow under §Flows (numbered alongside the existing flow list).
  - Add a "Resolve my blocker" flow under §Flows.
  - Add a row in the data-shape table for `attentionOwnerDetails` showing that `note` is now required for new rows.
- `apps/tasks/SPEC.md` §Screens: add `AttentionOwnersPanel` to the editor screen description and `data-reason` to the avatar stack tooltip description.

## Open questions and risks

- **Risk: PATCH behavioural change for existing clients.** The case-insensitive dedupe is a response-shape change (the persisted and returned set is now the dedupe-collapsed one), but the HTTP contract stays "200 + mapper output" so a client that re-PATCHes gets the same canonical result. The audit comment surfaces what dropped. Do not list this as a breaking change in the PR description; flag it in the system doc change log.
- **Risk: lobster stale attention stack after the approval-side-effect removal.** The lobster already calls `api_patch` to write `attentionOwners`, so the only behaviour change is that an approval write no longer touches the stack. If the lobster hasn't been running recently, a task with stale `attentionOwners` will not self-correct without a lobster sweep — the same shape of staleness exists today and is solved by the lobster's `reconcile_workflow_attention` invocation. No new severity.
- **Risk: the cross-role dedupe changes a visible avatar.** Updating one component test is required (item 5). The visual change is intentional and matches the AC4 wording, but it is a UX-visible change that should ship with the Playwright screenshot in the PR body.
- **Risk: Playwright flakiness on `AttentionOwnersPanel`.** The e2e spec uses deterministic network mocks where possible; the resolve-my-blocker button relies on a signed-in actor matching `topAttentionOwner`, which is seeded from the test fixture.
- **Open question — should `position` on POST be tunable or always 0?** The AC2 wording says "add an owner with a reason"; position is not pinned. I land on `position` with a default of `0` and a documented opt-in because: (a) every existing add in production is effectively a head insert (the lobster and the CLI helpers all do head inserts today); (b) a UI reorder surface still needs the same `position` field for move-up/move-down; (c) rejecting an arbitrary `position` would force the UI to choose between 0 and the special "tail" value, which is more surprising than "default 0, opt-in otherwise". Quinn — if you'd rather lock it to head-only and remove the param, say so before approval.
- **Open question — should `PATCH /:rowId` allow editing the `owner` field at all?** The lobster's `api_patch` is the only writer that reuses an existing row's `note`/`addedBy`; renaming an attention owner mid-life is rare. I land on allowing `owner` rename because the UI's edit affordance is simpler (one PATCH handles rename + note + move) and the audit trail still works (a comment records the rename). If Quinn would rather forbid owner renames entirely, the route handler can hard-fail with 400 `OWNER_RENAME_FORBIDDEN` and force a delete+re-add cycle.

If Quinn approves with one or both open questions resolved differently, the implementation plan adjusts in the same PR — no new tech design needed.
