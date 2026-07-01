---
status: draft
task_id: b2ab54db-6280-4179-be20-8d57b3737a77
product_spec: brain/tasks/specs/spec-resync-fluid-ac-lifecycle-2026-07-01.md
shipped_pr: null
shipped_date: null
---

# Spec Resync: Fluid AC Lifecycle Tech Design

## Product Intent

Tom can edit task acceptance criteria during QA without wedging the feature-task pipeline. When approved ACs drift, the system should make that drift visible by unchecking `- [ ] **Approved by Tom**` in the task description, block until Tom re-checks it, and let Quinn resync the private brain spec/checksum after that approval.

Source-of-truth rule from the product spec:

- `open` state: the brain spec wins.
- `ready`, `doing`, `acceptance`, `done`: the task description wins.

## Task / Repo Context

- Task: `b2ab54db-6280-4179-be20-8d57b3737a77`
- Title: `Spec resync: fluid AC lifecycle with Tom-gated drift approval`
- Repo: `Stoffer-Industries/sindustries`
- Branch: `task-b2ab54db-spec-resync`
- Worktree: `~/workspaces/rowan/sindustries`
- Product spec: `brain/tasks/specs/spec-resync-fluid-ac-lifecycle-2026-07-01.md`

## Boundary Notes

Rowan will only change files in `Stoffer-Industries/sindustries`.

The private brain spec update, stored checksum reset, and Quinn heartbeat behavior are outside this repo/worktree. Rowan will not edit `~/.openclaw/` or `brain/` directly. If the implementation needs an OpenClaw-side change, Rowan will post an `[openclaw-needed]` task comment with the exact expected behavior instead of applying it.

## Current Behavior

The existing guard has two layers:

- Rust: `agents/workflows/feature-task/src/main.rs` computes a checksum from the task description AC lines. `block_on_spec_drift` blocks `spec_check`, `ready_checks`, `verify_delivery`, `feedback_aggregate`, and `post_merge` when the current checksum differs from `task.specChecksum`.
- Tasks API: `services/tasks-api/src/routes/tasks/_spec.ts` rejects `PATCH /tasks/:id` with `description` and `POST /tasks/:id/comments` with `409 SPEC_CHECKSUM_MISMATCH` when ACs have drifted.

That behavior treats drift as an error. The new behavior treats drift as a visible approval-state transition.

## Implementation Plan

### Rust workflow changes

Primary file: `agents/workflows/feature-task/src/main.rs`

Add helpers:

- `approved_by_tom_marker_checked(description: &str) -> bool`
- `approved_by_tom_marker_unchecked(description: &str) -> bool`
- `uncheck_approved_by_tom_marker(description: &str) -> String`
- `approval_marker_failures(task: &Task) -> Vec<String>`
- `spec_drift_summary(stored, current, task) -> String`

Change `block_on_spec_drift` from a pure in-memory block into a stage helper that can:

- Detect checksum drift.
- If the task is not `open`, patch the task description to uncheck `- [x] **Approved by Tom**`.
- Post a `[feature-task-progress-checklist]` comment containing the drift summary and the AC diff.
- Block the current stage until `- [x] **Approved by Tom**` is restored and Quinn posts `[spec-resynced]`.

The helper should be idempotent. If the marker is already unchecked or the same failure fingerprint is already stored in lobster state, it should not spam comments.

### AC diff formatting

Add a small diff helper for task AC text:

- Compare the AC list represented by `task.specChecksum`'s source snapshot if available.
- If no prior AC snapshot exists, report the stored/current checksum plus the current AC list and make the comment explicit that the old text cannot be reconstructed from a checksum alone.

The minimum shippable version can use checksum + current AC list because today's system stores only the digest. A future improvement can persist canonical AC JSON if Tom wants richer diffs.

### Blocking behavior

For `ready`, `doing`, and `acceptance` tasks:

- Drift found and marker checked: uncheck marker, post drift checklist, block.
- Drift found and marker unchecked: block with "waiting for Tom to re-check Approved by Tom."
- Marker re-checked but `[spec-resynced]` missing: block with "waiting for Quinn resync."
- Marker re-checked and `[spec-resynced]` present: allow the stage to continue.

For `open` tasks:

- Keep using the brain spec as source of truth.
- Do not require task-description approval-marker semantics before the task has entered the ready pipeline.

### Tasks API behavior

Primary files:

- `services/tasks-api/src/routes/tasks/_spec.ts`
- `services/tasks-api/src/routes/tasks.ts`
- `services/tasks-api/test/read-endpoints.test.ts`

The API currently blocks drift before comments can be posted. For this task, comments that record drift/resync must remain writable after drift is detected. Update `POST /tasks/:id/comments` so it does not reject solely because the task's existing description has drifted. Keep `PATCH /tasks/:id` with a changed `description` guarded, unless the patch is the workflow's marker-only transition from checked to unchecked.

If the marker-only exception is needed, scope it tightly:

- Existing and incoming descriptions must have identical AC lines.
- The only allowed changed line is `- [x] **Approved by Tom**` to `- [ ] **Approved by Tom**`.
- `specChecksum` remains unchanged.

### Quinn / brain resync contract

Rowan's implementation will only read the resync signal:

- `[spec-resynced] <summary>` task comment means Quinn has updated the brain spec from the task description and reset the stored checksum.

The task's Quinn-owned ACs are:

- AC1: populate `- [x] **Approved by Tom**` when a spec is approved.
- AC4: detect re-check, resync brain spec, reset checksum, post `[spec-resynced]`.
- AC5: source-of-truth handling between brain spec and task description.

Rowan's branch should document the contract in `docs/systems/feature-task-workflow.md` so Quinn has a stable integration target.

## Data Model / API Contract

No database migration is planned.

Existing fields/comments:

- `Task.specChecksum`: remains the stored canonical AC checksum.
- `Task.description`: carries the visible `Approved by Tom` marker and AC text.
- `[feature-task-progress-checklist]`: records drift and what is needed next.

New task comment tag:

- `[spec-resynced] <summary>`: Quinn-owned signal that the brain spec/checksum have been reconciled after Tom re-approved drifted ACs.

## Workflow / Skill Changes

Update `docs/systems/feature-task-workflow.md` with:

- Drift no longer means "write a new spec immediately."
- Drift unchecks `Approved by Tom` on non-open tasks.
- Stage gates block until Tom re-checks and Quinn posts `[spec-resynced]`.
- `post_merge` remains covered by regression tests for the previous hard block removal.

No skill changes are required unless implementation discovers an existing Rowan/Quinn skill still instructs agents to treat every checksum mismatch as a new-spec-only path.

## Test Plan

Rust unit tests in `agents/workflows/feature-task/src/main.rs`:

- Detects a checked `Approved by Tom` marker.
- Detects an unchecked marker.
- Unchecks only the approval marker and preserves AC lines.
- Drift with checked marker produces a blocked envelope and marker-uncheck action.
- Drift with unchecked marker blocks waiting on Tom.
- Re-checked marker without `[spec-resynced]` blocks waiting on Quinn.
- Re-checked marker with `[spec-resynced]` allows progression.
- `post_merge` no longer hard-blocks solely on spec drift before the marker/resync path has run.

Tasks API tests in `services/tasks-api/test/read-endpoints.test.ts`:

- Drift still rejects arbitrary task description edits.
- Comment creation still succeeds on a drifted task so the workflow can post drift/resync state.
- Marker-only checked-to-unchecked description patch succeeds without changing AC text.
- Marker-only exception rejects any AC text change bundled with the marker change.

Validation commands:

```bash
cargo test --manifest-path agents/workflows/feature-task/Cargo.toml
npm test --workspace @sindustries/tasks-api
python3 -m unittest discover -s tests
```

## Open Questions / Risks

- The existing checksum stores only a digest, not the prior AC text, so a rich AC diff may need a follow-up persistence field. The first version can still be useful with checksum/current-AC evidence.
- The Tasks API marker-only exception must be narrow. A broad bypass would undermine the spec checksum gate.
- Quinn's resync heartbeat is a required companion. Rowan's PR can block on `[spec-resynced]`, but it cannot implement brain writes from this repo.
- `tasks_api_client.py get --id b2ab54db` currently returns HTTP 500 for the short ID even though list works. Implementation should avoid depending on short-ID GET behavior until that is fixed or use full IDs.
