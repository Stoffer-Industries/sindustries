---
status: draft
task_id: 593ee264-a62d-4e9a-9ba2-fc959813165c
product_spec: brain/tasks/specs/manually-blocked-tasks-must-not-advance-2026-06-29.md
shipped_pr: null
shipped_date: null
---

# Manual Block Guard — Tech Design

## Links

- Product spec: `brain/tasks/specs/manually-blocked-tasks-must-not-advance-2026-06-29.md`
- Task: `593ee264-a62d-4e9a-9ba2-fc959813165c` (`🔧 Manually blocked tasks must not advance`)
- Task API detail: `http://localhost:4001/api/v1/tasks/593ee264-a62d-4e9a-9ba2-fc959813165c`

## Scope

- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-593ee264-manual-block-guard`
- Worktree: `~/workspaces/rowan/sindustries`
- Primary code surfaces:
  - `agents/workflows/feature-task/src/main.rs` — lobster Rust worker (add manual-block guard at every orchestration stage)
  - `agents/workflows/feature-task/fixtures/` — fixture tasks for tests (one blocked, one unblocked)

No `.openclaw` runtime change. No schema or API surface change. The `blocked` field already exists on the Tasks API; the lobster simply needs to honour it.

## Product Summary

The Tasks API exposes a `blocked: bool` field on every task. Tom and Quinn set it manually to pause a task in flight without archiving it. Today the lobster does not check it before orchestrating a state transition, so a manually blocked task can still drift forward when a cron run fires.

This change adds a guard at the start of every orchestration stage (`spec_check`, `ready_checks`, `verify_delivery`, `feedback_aggregate`, `post_merge`):

- If `task.blocked == true`, the stage emits a clear `[feature-task-blocked]` comment and the lobster does **not** transition the task.
- The `dependencyBlocked` flag is left untouched. That remains a computed property of unfinished dependencies; this guard only watches the explicit manual flag.

## Implementation Plan

### 1. New helper: `manual_block_failures`

In `agents/workflows/feature-task/src/main.rs`, add a small helper alongside `block_on_spec_drift`:

```rust
fn manual_block_failures(task: &Task) -> Vec<String> {
    if task.blocked {
        vec![
            "Task is manually blocked (`blocked: true`); \
             clear the block to allow progression. \
             (`dependencyBlocked` is a separate computed flag and is not affected.)"
                .to_string(),
        ]
    } else {
        Vec::new()
    }
}
```

The failure text is human-readable and names both flags so the operator reading the comment knows which one applies and that they are distinct.

### 2. Apply the guard at every stage

At the top of each orchestration stage function, after `block_on_spec_drift` and before any other work, add the same pattern:

```rust
fn ready_checks(args: StageArgs) -> Result<Envelope> {
    let mut env = read_envelope()?;
    if let Some(blocked) = block_on_spec_drift(env.clone(), "ready_checks") {
        return Ok(blocked);
    }
    let block_failures = manual_block_failures(&env.task);
    if !block_failures.is_empty() {
        return Ok(block_with_block_failures(args, env, "ready_checks", block_failures));
    }
    // ...existing logic...
}
```

Stages to cover:

- `spec_check` (line 195)
- `ready_checks` (line 234)
- `verify_delivery` (line 262)
- `feedback_aggregate` (line 310)
- `post_merge` (line 383)

A small shared helper `block_with_block_failures(args, env, action, failures)` writes a `[feature-task-blocked]` comment, records the failure fingerprint, and returns an `Envelope` with `criteria_met = false` and `action_taken = "<action>_blocked"`. This mirrors the existing branch in `transition_or_block` but is reached before any state work, so no `api_patch` is ever called for a manually blocked task.

The `discover` step (handled by the lobster wrapper) does not need a guard at the Rust level — its job is to list active tasks. The Tasks API will continue to return blocked tasks; the guard fires at the per-stage entry point.

### 3. Distinct from `dependencyBlocked`

`dependencyBlocked` is a computed property of unfinished dependencies and remains untouched. The guard only checks `task.blocked` (the explicit manual flag). A unit test (`manual_block_guard_does_not_touch_dependency_blocked`) asserts the two are independent: a task with `dependencyBlocked: true` and `blocked: false` proceeds as today, and a task with `blocked: true` is blocked regardless of dependency state.

### 4. Tests

New unit tests in `agents/workflows/feature-task/src/main.rs` `mod tests`:

- `manual_block_failures_returns_empty_when_unblocked` — `Task { blocked: false, .. }` returns `vec![]`.
- `manual_block_failures_returns_message_when_blocked` — `Task { blocked: true, .. }` returns the documented failure string.
- `manual_block_guard_skips_transition_when_blocked` — stage function for `ready_checks` returns early with `criteria_met: false`, no `api_patch` is invoked, and a `[feature-task-blocked]` comment is queued.
- `manual_block_guard_allows_unblocked_task_to_continue` — same stage, `blocked: false`, falls through to the normal failure set (e.g. `[tech-design] <url>` missing).
- `manual_block_guard_does_not_touch_dependency_blocked` — `dependencyBlocked: true, blocked: false` does not trigger the guard; `blocked: true, dependencyBlocked: false` does.
- `manual_block_guard_message_distinguishes_manual_flag` — failure string contains `blocked: true` and explicitly mentions `dependencyBlocked` is separate.

Fixtures: extend `agents/workflows/feature-task/fixtures/` with a pair of fixture tasks (one blocked, one unblocked) plus a synthetic envelope so the stage-level test can run without live API calls.

### 5. Documentation

- `brain/bookmarks/specs/feature-factory-v2-2026-06-04.md` already documents `blocked` and `dependencyBlocked`. Add a short paragraph under the `feature-task` section noting the lobster now honours `blocked` as a hard stop. (Owner: this PR, since the change is lobster-side. AC3 in the product spec is the explicit acceptance for this clarity.)
- No `docs/systems/` system spec change — the lobster is internal agent tooling, not a user-facing system. The `no-system-spec-change` rationale will be posted on the PR with the standard justification.

## Test Plan

- `cd agents/workflows/feature-task && cargo test`
  - all existing tests still pass (no surface change to the happy path)
  - new `manual_block_*` tests pass
- `cargo build --manifest-path agents/workflows/feature-task/Cargo.toml` compiles cleanly
- Manual smoke:
  - mark a real task `blocked: true` via the Tasks API
  - run the lobster wrapper (`feature-task check-acceptance` or `post-merge` on the task)
  - confirm the task is not transitioned, the fingerprint updates, and a `[feature-task-blocked]` comment is posted
  - clear the block, re-run — task proceeds normally

Coverage summary:

- AC1 (no advance under any circumstance) — covered by `manual_block_guard_skips_transition_when_blocked` plus manual smoke
- AC2 (clear output) — covered by `manual_block_failures_returns_message_when_blocked` and the smoke run
- AC3 (distinct from `dependencyBlocked`) — covered by `manual_block_guard_does_not_touch_dependency_blocked`
- AC4 (tests cover the guard) — covered by the full test set above

## Open Questions and Risks

- **Guard placement:** adding the guard at the top of every stage function is repetitive but explicit. An alternative would be a single early-exit at the discover / envelope-loading step; that would prevent any command (including dry-runs) from operating on a blocked task, which is stronger than the spec requires. The per-stage placement matches the existing `block_on_spec_drift` pattern and keeps the door open for future commands that should ignore the block (e.g. an explicit `force-unblock` operator). Flagged as a follow-up if Quinn prefers the stronger placement.
- **Comment churn:** the lobster already de-duplicates comments by failure fingerprint, so repeated cron runs against the same blocked task will not spam the thread. Verified by reading the `block_on_spec_drift` flow that uses the same pattern.
- **Race conditions:** if a user sets `blocked: true` mid-orchestration, the next cron run will pick it up. The lobster is idempotent and re-reads task state on every run, so there is no window where a transition slips through after a block lands.
- **No system spec change** (lobster is internal tooling). Standard `no-system-spec-change` rationale will be posted on the PR.
