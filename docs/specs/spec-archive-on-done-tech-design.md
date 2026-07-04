---
status: draft
task_id: c40ae956-a213-4c5d-896e-fbdbe4b8f232
product_spec: brain/tasks/specs/spec-archive-on-done-2026-07-04.md
shipped_pr: null
shipped_date: null
---

# Archive Spec Files When Feature Tasks Move to Done — Tech Design

## Product Spec Link

- Product spec: `brain/tasks/specs/spec-archive-on-done-2026-07-04.md`
- Task API detail: `http://localhost:4001/api/v1/tasks/c40ae956-a213-4c5d-896e-fbdbe4b8f232`

The local product spec file was not present in this worktree during design. This design is based on the approved task description and acceptance criteria in the Tasks API record.

## Task / Repo Context

- Task ID: `c40ae956-a213-4c5d-896e-fbdbe4b8f232`
- Task title: `🔧 🗃️ Archive spec files when feature tasks move to done`
- Repository: `Stoffer-Industries/sindustries`
- Branch: `docs/spec-archive-on-done-tech-design`
- Implementation branch recommendation: `task-c40ae956-spec-archive-on-done`
- Design worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/spec-archive-on-done-tech-design`
- Implementation worktree recommendation: `~/workspaces/rowan/sindustries-spec-archive-on-done`

## Product Intent Summary

When a feature task completes, its active product spec should leave `brain/tasks/specs/` and move into `brain/tasks/specs/done/`. The task description's `**Spec:**` line should be rewritten to the archived path so future readers can still find the spec. The move must be safe and narrow:

- only run when a task transitions to `done`;
- only move specs under `brain/tasks/specs/<slug>.md`;
- no-op when the spec is already under `brain/tasks/specs/done/`;
- never touch `brain/bookmarks/specs/`, `docs/specs/`, or other Markdown files.

## `.openclaw` Boundary Notes

The implementation must not touch `~/.openclaw/`.

The affected `brain/tasks/specs/` paths are workspace files outside the `Stoffer-Industries/sindustries` repo checkout. Existing feature-task workflow code already resolves brain spec paths against the workspace root and rewrites brain specs during spec resync. This task may extend that repo-owned workflow code to move workspace brain files at runtime, but Rowan should not edit the live brain files during implementation or tests except through isolated temp fixtures.

If Quinn wants the archival move performed by an OpenClaw heartbeat instead of the repo-owned feature-task workflow, Rowan should stop and request `[openclaw-needed]`. This design recommends keeping the behaviour in `agents/workflows/feature-task` because the acceptance trigger is the feature-task `done` transition.

## Implementation Plan

### 1. Add narrow spec archive path helpers

Primary file:

- `agents/workflows/feature-task/src/main.rs`

Add helpers near the existing product-spec path functions:

- `task_spec_archive_target(spec_path: &str, workspace_root: &Path) -> ArchiveSpecPlan`
- `is_archivable_task_spec_path(spec_path: &str) -> bool`
- `is_already_archived_task_spec_path(spec_path: &str) -> bool`
- `archive_spec_path_for(spec_path: &str) -> Option<String>`
- `rewrite_spec_line(description: &str, old_path: &str, new_path: &str) -> String`

Recommended plan enum:

```rust
enum ArchiveSpecPlan {
    Move { from: PathBuf, to: PathBuf, new_spec_ref: String },
    AlreadyArchived,
    NotTaskSpec,
    MissingSpecRef,
}
```

Rules:

- Accept only relative paths matching `brain/tasks/specs/<filename>.md` with no additional subdirectory except `done/`.
- Reject paths containing `..`, absolute paths outside the workspace, non-`.md` files, `brain/bookmarks/specs/`, and `docs/specs/`.
- `brain/tasks/specs/done/<filename>.md` returns `AlreadyArchived`.
- Move target is `brain/tasks/specs/done/<filename>.md`.

Do not reuse the broader `safe_brain_spec_path` without additional narrowing. It intentionally allows multiple brain subtrees for spec resync; this task requires a much tighter boundary.

### 2. Archive after the `done` transition succeeds

The safest point is inside or immediately after `transition_or_block(..., "done", "post_merge", failures)` in `post_merge`:

1. Run all existing post-merge gates.
2. Patch task status to `done` through the existing `transition_or_block` path.
3. Only if the transition succeeds and the resulting task status is `done`, run `archive_done_task_spec`.
4. If archival succeeds and rewrites the task description, patch the task description and update the returned envelope's task.
5. If archival fails, return a blocked/error envelope or post a `[feature-task-progress-checklist]` comment without rolling the task status back.

Recommendation: treat archival failure as a feature-task blocked condition visible in comments, but do not revert `done` to `acceptance`. The task has shipped; losing the archive move should be fixed idempotently on the next run.

Pseudo-flow:

```rust
let env = transition_or_block(&args, env, "done", "post_merge", failures)?;
if env.criteria_met && env.task.status == "done" {
    return archive_done_task_spec(&args, env);
}
Ok(env)
```

If `transition_or_block` currently returns `Result<Envelope>` in a shape that makes this awkward, add a small wrapper for the `done` case only rather than rewriting all stage transitions.

### 3. Implement `archive_done_task_spec`

Inputs:

- stage args for `base_url`, `repo`, and dry-run behaviour;
- current `Envelope` with the latest task returned by the Tasks API.

Behaviour:

1. Parse `product_spec(&env.task)` from the task description.
2. If no spec ref, return success/no-op.
3. Build the narrow archive plan.
4. For `NotTaskSpec`, return success/no-op. This satisfies AC4 by ignoring `brain/bookmarks/specs/` and `docs/specs/`.
5. For `AlreadyArchived`, return success/no-op. This satisfies AC3.
6. For `Move`:
   - ensure `brain/tasks/specs/done/` exists;
   - if source exists and destination does not, `fs::rename(from, to)`;
   - if source missing and destination exists, treat as already moved and continue;
   - if both source and destination exist, do not overwrite; block with a clear failure;
   - if neither exists, block with a clear failure because the active spec path could not be archived;
   - rewrite only the `**Spec:**` line from old ref to new ref;
   - patch task `description` with the rewritten text.

Idempotence details:

- A second run after a successful move sees the description already pointing at `brain/tasks/specs/done/<slug>.md` and returns no-op.
- A retry after the file moved but before the description patch sees source missing and destination present, then patches the description.
- A retry after description patch but before state persistence returns no-op.

### 4. Respect spec drift and checksum behaviour

Patching the task description after `done` can trigger spec checksum guards if AC text changes. This feature rewrites only the `**Spec:**` line and must preserve acceptance criteria text byte-for-byte.

If the Tasks API rejects all description patches when a `specChecksum` is locked, use the existing safe patch path only if it allows non-AC changes. If not, add a narrow Tasks API exception for spec-line-only updates:

- existing and incoming AC lines must be identical;
- only the `**Spec:**` line may change;
- old path must be `brain/tasks/specs/<slug>.md`;
- new path must be `brain/tasks/specs/done/<slug>.md`;
- `specChecksum` remains unchanged.

This exception belongs in:

- `services/tasks-api/src/routes/tasks/_spec.ts`
- `services/tasks-api/src/routes/tasks.ts`
- `services/tasks-api/test/read-endpoints.test.ts` or a more focused write/patch test file if present.

Do not weaken checksum protection for arbitrary description edits.

### 5. Comments and observability

The user specifically instructed this design phase not to post task comments other than `[tech-design]`. For implementation, comments are acceptable as workflow output if needed.

Suggested implementation comments:

- On archive success, either no comment or a concise `[feature-task-progress-checklist] Archived spec to brain/tasks/specs/done/<slug>.md` if existing lobster conventions favour visible actions.
- On archive block/failure, post `[feature-task-progress-checklist]` with the exact file/path reason.

Keep comments idempotent by folding the archive status into the existing lobster-state failure fingerprint if possible.

## Data Model or API Contract Changes

No database schema changes.

Potential narrow Tasks API behaviour change only if current checksum guard blocks spec-line-only description updates:

- `PATCH /tasks/:id` with `description` may allow changing exactly the `**Spec:**` line from `brain/tasks/specs/<slug>.md` to `brain/tasks/specs/done/<slug>.md` while AC lines are unchanged.
- All other checksum mismatch protections remain in force.

The task object already stores `description` and `specChecksum`; no new fields are needed.

Filesystem contract:

- Runtime workflow may move files under workspace `brain/tasks/specs/` to `brain/tasks/specs/done/`.
- It must not move files outside that exact source directory.

## Workflow, Cron, and Skill Changes

Workflow change:

- `agents/workflows/feature-task/src/main.rs` gains a post-`done` archival step in the `post_merge` stage.

Cron changes:

- No cron prompt changes required. Existing feature-task cron will pick up the updated workflow binary/script after deployment.

Skill changes:

- No skill changes required.
- If this becomes a documented operator behaviour, update `docs/systems/feature-task-workflow.md` on ship with a short runbook note about spec archival and idempotent retries.

## Test Plan

Rust unit tests in `agents/workflows/feature-task/src/main.rs`:

- `archive_plan_moves_active_task_spec`
  - `brain/tasks/specs/example.md` maps to `brain/tasks/specs/done/example.md`.
- `archive_plan_noops_done_spec`
  - `brain/tasks/specs/done/example.md` is `AlreadyArchived`.
- `archive_plan_ignores_bookmark_specs`
  - `brain/bookmarks/specs/example.md` is `NotTaskSpec`.
- `archive_plan_ignores_docs_specs`
  - `docs/specs/example-tech-design.md` is `NotTaskSpec`.
- `archive_plan_rejects_traversal`
  - paths containing `..` do not produce a move plan.
- `rewrite_spec_line_updates_only_spec_ref`
  - AC lines are byte-identical after rewrite.
- `archive_done_task_spec_moves_file_and_patches_description`
  - temp workspace with active spec; verifies file moved and task patch payload contains the done path.
- `archive_done_task_spec_idempotent_when_already_done`
  - done path in description and destination file present; no filesystem or API patch attempted.
- `archive_done_task_spec_repairs_partial_move`
  - source missing, destination present, description still old; patches description only.
- `archive_done_task_spec_blocks_on_destination_conflict`
  - both source and destination exist; does not overwrite.

Tasks API tests only if the spec-line-only exception is needed:

- allows active-to-done spec-line rewrite with unchanged ACs;
- rejects spec-line rewrite for bookmark/docs paths;
- rejects description edits that also change ACs;
- leaves `specChecksum` unchanged.

Manual smoke in a throwaway workspace fixture:

1. Create a feature task envelope with `status=acceptance`, checked ACs, merged PR signals, and `**Spec:** brain/tasks/specs/example.md`.
2. Place `brain/tasks/specs/example.md` under the temp workspace.
3. Run the `post_merge` stage against a test Tasks API or mocked API.
4. Confirm status reaches `done`.
5. Confirm spec file exists at `brain/tasks/specs/done/example.md`.
6. Confirm task description points at the done path.
7. Re-run and confirm no-op success.

## Open Questions and Risks

- The product spec file was unavailable locally, so Quinn should verify that the recommended workflow-owned move matches the private spec.
- This task intentionally crosses from repo-owned workflow code into workspace `brain/` files at runtime. The path guard must be tight and well-tested to avoid moving bookmark specs or docs specs.
- Description patching after completion may interact with spec checksum protection. If a Tasks API exception is needed, it must be narrow and AC-preserving.
- Failure semantics after a task is already `done` need Quinn review. This design recommends idempotent retry and visible block comments rather than reverting shipped tasks out of `done`.
