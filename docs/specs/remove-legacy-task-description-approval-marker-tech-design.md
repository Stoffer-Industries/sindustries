---
status: draft
task_id: e2aba106-e1f6-4faf-ad81-3e5bec1b4574
product_spec: /Users/quinnstoffer/.openclaw/workspace/brain/tasks/specs/in-progress/remove-legacy-task-description-approval-marker-2026-08-09.md
shipped_pr: null
shipped_date: null
---

# Remove legacy task-description approval marker — tech design

## Task and repository

- Task ID: `e2aba106-e1f6-4faf-ad81-3e5bec1b4574`
- Task title: `💻 Remove legacy task-description approval marker`
- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-e2aba106-remove-legacy-approval-tech-design` (this design only — implementation lands on a fresh branch off `origin/main`)
- Workflows touched: `agents/workflows/feature-task` (Rust lobster) and `services/tasks-api` (Node)
- Parent design: `docs/specs/tasks-api-native-approvals-tech-design.md` — introduced structured `TaskApproval` rows. WS4a of that parent design extracted the migration detection logic into `services/tasks-api/src/lib/legacyApprovals.ts` and wired the CLI script `services/tasks-api/scripts/migrate-legacy-approvals.ts`.
- Migration script: `services/tasks-api/scripts/migrate-legacy-approvals.ts` (with `src/lib/migrateLegacyApprovals.ts` orchestrator and `src/lib/legacyApprovals.ts` detector). Already idempotent on `(taskId, type)` and snapshot-backed for rollback.

## Problem statement

Structured `TaskApproval` rows are already documented as the sole source of truth for spec, tech-design, and QA approval (`agents/workflows/feature-task/src/main.rs` ~line 2671: `Structured TaskApproval rows are the sole source of spec approval.`; ~line 3068: same for tech-design). The legacy `- [x] **Approved by Tom**` checkbox in task descriptions is the residual that remains because:

1. The feature-task lobster still reads it via `product_spec_approved_by_tom(text)` (`main.rs` ~line 2690, regex `(?m)^\s*-\s*\[[xX]\]\s+\*\*Approved by Tom\*\*\s*$`) and the related `unchecked_re` / checked-form regexes at ~line 2721 / ~line 2745 / ~line 2762. Two call sites still depend on it: the spec-gate check at ~line 1495 (`!product_spec_approved_by_tom(spec_text)`) and the spec-drift resync path at ~line 2062 (`!product_spec_approved_by_tom(&pre_existing_text)`).
2. The lobster auto-unchecks the marker on drift via the line-filter at ~line 2038 (`.filter(|l| l.trim() != "**Approved by Tom**")` inside a description rewrite pass) and writes the unchecked form back via `.replace(text, "- [x] **Approved by Tom**")` at ~line 2725 and the line-toggle regex at ~line 2762.
3. The Tasks API description-handling surface is the implicit partner: any preservation, auto-uncheck, or runtime-state behaviour over the legacy checkbox has to be audited and removed.
4. The legacy checkbox is **indistinguishable in surface syntax** from the file-level approval marker that lives inside brain spec files (e.g. `**Spec:** ...` blocks with `- [x] **Approved by Tom**` underneath) and inside bookmark spec files. The detection helper `detectLegacyApprovals` in `legacyApprovals.ts` currently scopes by source (`description` vs `comments`) but does not distinguish task-description content from brain/bookmark-spec file content posted as comment bodies.

This task closes the gap by removing the task-description-side legacy checkbox from all read/write paths, while preserving the brain-spec and bookmark-spec file-level marker (AC4) as a separate workflow.

## Goals and non-goals

**Goals**

- The feature-task lobster reads approval state exclusively from structured `TaskApproval` rows fetched through the Tasks API. No code path consults the task-description checkbox.
- The Tasks API does not preserve, auto-uncheck, or otherwise treat the legacy task-description checkbox as runtime state. Description writes/reads treat it as inert markdown.
- Existing tasks that carry the legacy checkbox have a one-time migration path that uses the existing `migrate-legacy-approvals.ts` script to convert the spec row, leaving no task-description marker required for any future run.
- Brain-spec and bookmark-spec file-level `- [x] **Approved by Tom**` markers (and any sibling markers like `[tech-design-approved] true` / `[qa-ac-verified] true` in comment bodies that the Tasks API also surfaced as approval state) are out of scope for removal and remain supported.

**Non-goals**

- No changes to the brain-spec file lifecycle (`brain/tasks/specs/{open,in-progress,done,archived}/`) or its approval markers.
- No changes to the bookmark-spec workflow (`agents/workflows/bookmarks`) or its approval markers.
- No changes to the structured `TaskApproval` schema or to the Tasks API approval endpoints.
- No re-running of the migration on tasks that already have structured rows — the script is already idempotent on `(taskId, type)`.

## Current implementation map (anchor lines)

### Rust lobster (`agents/workflows/feature-task/src/main.rs`)

- ~line 130: `TaskApproval` struct mirroring the Tasks API schema. Already populated from the task fetch.
- ~line 904: structured QA approval failure message — confirms the structured path is the gate. No code change needed.
- ~line 1495: `!product_spec_approved_by_tom(spec_text)` — reads the checkbox in some `spec_text` blob. Investigate whether `spec_text` here is brain-spec file content (KEEP) or task-description content (REMOVE).
- ~line 2038: `.filter(|l| l.trim() != "**Approved by Tom**")` — line filter inside a description rewrite, presumably stripping the marker during drift. REMOVE for task descriptions.
- ~line 2062 / ~line 2070: `product_spec_approved_by_tom(&pre_existing_text)` and the resync message. Same source-scoped audit needed as 1495.
- ~line 2209: `Brain spec at ... is no longer marked Approved by Tom; refusing to resync.` — KEEP. This message targets brain spec file content.
- ~line 2274–2275: messages about Quinn's role in unchecking and re-checking — investigate whether these target task-description or brain-spec content.
- ~line 2334: error `Approval marker **Approved by Tom** is unchecked.` — same audit.
- ~line 2645: structured spec approval failure — already structured. No code change.
- ~line 2671: comment `Structured TaskApproval rows are the sole source of spec approval.` — aspirational; the residual code below contradicts it.
- ~line 2690: `product_spec_approved_by_tom(text: &str) -> bool` — regex check on `- [x] **Approved by Tom**`. Needs source scoping: keep for brain-spec content, remove for task-description.
- ~line 2711 / ~line 2721 / ~line 2725: unchecked-form regex and the unchecked→checked rewrite pass. Target task description; REMOVE.
- ~line 2745 / ~line 2749 / ~line 2762: `checked_re`, `unchecked_re`, and the line-toggle regex (`^(\s*-\s*)\[[xX]\]\s+(\*\*Approved by Tom\*\*\s*)$`). REMOVE if scoped to task descriptions.
- ~line 3068: comment `Structured TaskApproval rows are the sole source of tech-design approval.` — same aspirational pattern. The remaining tech-design-side legacy handling should be similarly scoped.
- ~line 3407 / ~line 3417 / ~line 3442 / ~line 3452 / ~line 3467: tests asserting checkbox presence/absence in task descriptions. Audit and convert to structured-state tests.
- ~line 3519 / ~line 3884 / ~line 3905 / ~line 4291+: `TaskApproval` row builders and approval-marker tests. Some of these assert the legacy checkbox in `description: Some("- [x] **Approved by Tom**".into())`. Convert to use the structured API.

### Tasks API (`services/tasks-api/`)

- `src/lib/legacyApprovals.ts`: detector (`detectLegacyApprovals`). Already source-scoped (`description` field of the task). KEEP, but extend the comment-body path to NOT detect markers inside brain/bookmark-spec file content that has been uploaded as a comment body. (This is the only place where the file-level marker could leak into task-description-style detection.)
- `src/lib/migrateLegacyApprovals.ts`: orchestrator (`planMigration`, `runDryRun`, `runWrite`, `runRollback`). No code change.
- `scripts/migrate-legacy-approvals.ts`: CLI script with `--dry-run`, `--write`, `--rollback`. No code change. This is the migration path (AC3).
- `test/migrateLegacyApprovals.test.ts`, `test/migrateLegacyApprovalsFetch.test.ts`, `test/legacyApprovals.test.ts`: existing test coverage of detection and orchestration.
- Description-handling routes (`src/routes/tasks/`, `src/routes/tasks/_spec.ts`): audit any path that reads/writes/rewrites the `- [x] **Approved by Tom**` marker. The existing `_spec.ts` was found by grep and is the prime suspect. Most likely no runtime behaviour depends on the marker, but the audit must confirm.

## Implementation plan

### 1. Source-scope `product_spec_approved_by_tom` and its neighbours

Refactor `product_spec_approved_by_tom` (and the unchecked/checked regexes at lines 2711–2762) so the function name and the docstring make the source explicit. Recommended split:

- Keep a function `brain_spec_approved_by_tom(spec_text: &str) -> bool` for content of a brain spec file (AC4 preservation). All current callers that pass brain spec content continue to work.
- Remove the unchecked-form regex and the toggle/rewrite helpers (~line 2711–2762) when they target the task-description case. If any caller relied on them for brain-spec file rewrites (unlikely given the test data), preserve them under a `brain_spec_` prefix.

Audit each call site (~line 1495, ~line 2038, ~line 2062, ~line 2209, ~line 2274–2275, ~line 2334, ~line 3068 area) to confirm the source:

- If `text` is brain-spec file content, route through `brain_spec_approved_by_tom`. No behaviour change.
- If `text` is task description, remove the call and replace with structured `TaskApproval` lookup.

### 2. Replace task-description checkbox reads with `TaskApproval` lookups

For each task-description-side approval gate currently driven by the checkbox:

- Spec gate (~line 1495): replace with `task.approvals.iter().any(|a| a.type == "spec" && a.state == "approved")`. The struct already exists at ~line 130; the API already returns rows. The check becomes a one-liner over the existing `Vec<TaskApproval>`.
- Spec-drift resync gate (~line 2062): same replacement, with the same source-of-truth rationale.
- Tech-design gate: the comment at ~line 3068 already asserts structured is authoritative. Verify the gate code uses `TaskApproval` and remove any legacy fallback path.
- QA gate (~line 904): already structured. Verify and leave alone.

### 3. Remove the auto-uncheck and toggle-rewrite helpers

Delete or repurpose the line-filter at ~line 2038 (drift auto-uncheck), the unchecked-form regex at ~line 2721, the unchecked→checked rewrite at ~line 2725, the `checked_re`/`unchecked_re` pair at ~line 2745/2749, and the line-toggle regex at ~line 2762 — *only* if and where they target the task-description source. Replace drift-resync behaviour with the structured path: when drift is detected, the lobster revokes (or marks pending revoke on) the `spec` `TaskApproval` row and posts a task comment explaining the reason. Quinn unchecks the spec file content and re-approves via the structured endpoint.

### 4. Audit and freeze the Tasks API description-handling surface

For `src/routes/tasks/_spec.ts` and any route that builds or updates a `description`:

- Confirm there is no `replace_all("- [x] **Approved by Tom**", ...)` or unchecked-form auto-fix path.
- Confirm description inputs are passed through verbatim except for explicit user-driven edits.
- Add a comment at the top of the description-write helper: "The legacy `- [x] **Approved by Tom**` checkbox is intentionally not preserved, auto-unchecked, or rewritten. Use the structured `TaskApproval` API for approval state."

If any unrelated code does happen to read the checkbox (e.g. a stale comment renderer), remove it. The detector in `legacyApprovals.ts` remains as the one piece that still *reads* the marker, but only because it feeds the migration (item 5).

### 5. Promote the migration to a clean one-shot cutover

The existing `services/tasks-api/scripts/migrate-legacy-approvals.ts --write` is the AC3 migration. No code changes are needed in the script. Operational additions:

- Add a one-time checklist to `docs/systems/approvals.md` (or whatever the canonical approval-systems doc becomes): run `--dry-run` first, capture the summary, run `--write`, capture the snapshot path. After the write completes, run `--dry-run` again to confirm zero rows would be created (idempotency proof).
- Add a TaskComment posted by `Lobster` after the migration completes, per migrated task: `Legacy approval migrated to structured TaskApproval. Snapshot: <path>. Rollback: --rollback <path>.`
- Audit the audit-trail requirement (AC3: "records an auditable result"): the snapshot file is the auditable artifact. Document the snapshot schema in the script's `--help` output if not already there.

The migration is one-shot. After it runs, no production task has the legacy checkbox in its description; the detector in `legacyApprovals.ts` may then be deleted in a follow-up cleanup once we have a release or two of confidence. (Defer that deletion; it's outside this task.)

### 6. Brain-spec and bookmark-spec preservation (AC4)

The detection logic in `legacyApprovals.ts` reads the task-description field. It does not (currently) read brain-spec or bookmark-spec file content. The risk vector is comment bodies: if a comment body contains a brain-spec file upload whose content includes `- [x] **Approved by Tom**`, the detector would misclassify it as a `spec` legacy approval. Audit the comment-body branch and add a guard:

- If the comment body is structured as a brain-spec upload (`{"kind": "brainSpec", "path": "..."}` or similar — confirm against the actual upload schema), skip approval detection. Document the guard.

The bookmark-spec workflow (`agents/workflows/bookmarks`) is separate and not touched by this design. Verify by inspection.

### 7. Tests (AC5)

New tests, organised by AC:

- **AC1 — lobster reads structured.** Convert existing `product_spec_approved_by_tom` tests (~line 3407+) to `TaskApproval`-driven tests. Add tests asserting that a task with a checked legacy checkbox in its description but no structured `spec` approval is rejected at the spec gate.
- **AC2 — Tasks API does not preserve/auto-uncheck.** Round-trip test: POST a task with `- [x] **Approved by Tom**`, GET it back, assert the description is unchanged. Round-trip test for the unchecked form. Add a negative test: PATCH the description with the unchecked form, assert it stays unchecked (no auto-fix).
- **AC3 — migration of checked and unchecked legacy descriptions.** Existing `migrateLegacyApprovals.test.ts` already covers the checked form (creates a `spec` row). Add a test for the unchecked form (no `spec` row created). Add an end-to-end test of `runWrite` against a fake API and assert the snapshot file structure.
- **AC4 — brain-spec / bookmark-spec preservation.** Add a comment-body guard test: a comment body containing a brain-spec upload with `- [x] **Approved by Tom**` inside does NOT trigger a `spec` approval migration. Add a structural assertion that `agents/workflows/bookmarks` import graph and its approval-detection helpers are unchanged.
- **AC5 — drift/resync path uses structured.** Convert existing drift/resync tests (~line 2038, ~line 2209, ~line 2274–2275, ~line 2334) to assert the structured-state behaviour: drift revokes the `spec` `TaskApproval`, posts a comment explaining the reason, and does NOT rewrite the description.
- **AC5 — absence of task-description marker dependencies.** Static check or grep-based test: no production code path under `agents/workflows/feature-task/src` or `services/tasks-api/src` references the literal `- [x] **Approved by Tom**` regex or the related toggle helpers, except in the detector that feeds the migration (and in tests that explicitly test the detector). Add a `pnpm` script `lint:no-legacy-approval-marker` that fails the build if a new occurrence appears.

### 8. Documentation (AC5)

- Update `docs/systems/approvals.md` (or the parent `tasks-api-native-approvals-tech-design.md`'s appendices) to add: the cutover plan, the migration snapshot format, the rollback procedure, the brain-spec / bookmark-spec preservation rule.
- Update `apps/tasks/SPEC.md` if the UI surfaces the legacy checkbox anywhere — likely it already shows only the structured approval row, but verify.
- Add a release note: "Feature-task approval state is now exclusively structured. The legacy `- [x] **Approved by Tom**` task-description checkbox is no longer read or written. Tasks migrated via `migrate-legacy-approvals.ts --write`. Brain-spec and bookmark-spec file-level markers are unchanged."

### 9. Rollout sequencing

1. Land this design as a tech-design PR (this branch).
2. Land the lobster-side cleanup as PR #1 against a fresh branch. Include the source-scope split, the `TaskApproval` lookups, and the auto-uncheck removal.
3. Land the Tasks API description-handling freeze as PR #2.
4. Run `migrate-legacy-approvals.ts --dry-run`, capture summary, post the summary to `docs/systems/approvals.md` cutover page.
5. Run `migrate-legacy-approvals.ts --write`, capture snapshot path.
6. Run `--dry-run` again, confirm zero rows would be created.
7. Post the post-migration lobster-state comment per task.
8. Land the test sweep (PR #3) — new tests + the `lint:no-legacy-approval-marker` script.

The detector in `legacyApprovals.ts` stays in the codebase until a follow-up task deletes it (out of scope here, but should be tracked).

## Open questions and risks

1. **Comment-body guard.** The detector's comment-body branch is the only place where brain-spec or bookmark-spec file content uploaded as a comment could be misclassified. The exact upload schema must be confirmed before the guard is added. If there is no structured upload marker, this is a non-issue.
2. **Drift auto-uncheck semantics.** Today the lobster auto-unchecks the legacy checkbox on drift. The replacement behaviour — revoking the structured `spec` row and posting a comment — is functionally different for users. The product spec should call out the UX change explicitly.
3. **Snapshot retention.** The migration writes a snapshot to `.openclaw/tasks-api/snapshots/<timestamp>.json`. The cutover plan should specify retention (forever? until next migration? until the legacy checkbox is fully removed from the codebase?).
4. **Detector deletion.** Removing `legacyApprovals.ts` in a follow-up is straightforward but should not happen until at least one release has shipped with the new structured-only path, so we have a clean rollback window if a missed legacy case surfaces.
5. **Other workflow callers.** The legacy checkbox may be read by other workflows not covered here (e.g. `code-task-workflow` if it shares product-spec approval). Audit cross-workflow usage before landing the lobster-side cleanup.

## AC verification matrix

| AC | Verification approach | Planned evidence |
| --- | --- | --- |
| AC1 | Static check: no production lobster code reads the legacy checkbox from task description. Unit tests assert spec gate uses structured rows. | `lint:no-legacy-approval-marker` script + new unit tests. |
| AC2 | Round-trip API tests for description preservation; negative test for auto-uncheck. | Tasks API description-handling tests. |
| AC3 | Migration script dry-run + write + dry-run idempotency; per-task lobster comment after migration. | Migration run output + comment audit. |
| AC4 | Comment-body guard test; structural assertion that bookmark workflow is unchanged. | New guard test + grep-based static check. |
| AC5 | Convert existing drift/resync tests to structured-state tests; add `lint:no-legacy-approval-marker` script; update approval systems doc. | New + converted tests, lint script, docs PR. |
