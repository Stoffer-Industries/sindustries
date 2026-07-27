---
status: draft
task_id: 1a0fc7df-bc10-492e-87db-94f4da611815
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Clean feature-task clippy baseline

## Links

- Product spec: n/a — code cleanup task
- Tech design: `docs/specs/feature-task-clippy-baseline-cleanup-tech-design.md`
- Task: `1a0fc7df-bc10-492e-87db-94f4da611815`
- Tasks API record: `http://localhost:4001/api/v1/tasks/1a0fc7df-bc10-492e-87db-94f4da611815`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-1a0fc7df-feature-task-clippy-baseline-cleanup`
- Worktree: `~/workspaces/rowan/sindustries`
- Expected `.openclaw` follow-up: none.

## Scope

The `agents/workflows/feature-task/` Rust crate has accumulated clippy findings (e.g. dead code stranded by PR #259 such as `tagged_path_values`). Before a clippy CI gate can block regressions, the baseline must exit zero under `cargo clippy --all-targets -- -D warnings`.

## Shared scope note

This is the **prerequisite** for the clippy rollout:

- `cbe3333a` — Add feature-task clippy CI gate (cannot land until this PR merges).
- `e9c06d01` — Document clippy in Rowan PR workflow.
- `55c98158` — Enforce clippy evidence in feature-task lobster.

Land order: **this task first**, then CI gate, then docs, then lobster enforcement.

## Ownership boundary

- All changes are inside `agents/workflows/feature-task/`. Repo-local; no `.openclaw` boundary.

## Implementation plan

File/module scope (intentionally narrow — this is a cleanup PR, not a refactor):

- `agents/workflows/feature-task/src/**/*.rs` — fix lints surfaced by `cargo clippy --all-targets -- -D warnings`. Categorize each:
  - **Fix**: rename, add `#[must_use]`, remove dead code, replace `.unwrap()` with `?` where reasonable, collapse `match` arms that are just delegations.
  - **Allow with rationale**: only for items where the fix is genuinely undesirable (e.g. an `enum` variant kept for forward compat). Use `#[allow(clippy::lint_name)]` with a one-line comment explaining why, per project convention.
- `agents/workflows/feature-task/src/**/tagged_path_values*` (or wherever the PR #259 stranded code lives) — explicitly delete if dead, or wire it back in if it's actually used. If the symbol is referenced by tests only, delete the tests too.
- `agents/workflows/feature-task/Cargo.toml` — no version bump. No new dependencies.
- New file `agents/workflows/feature-task/CLIPPY_NOTES.md` — one-page log: which lints were fixed vs allowed, with a one-line rationale per allow. Helps reviewers and future cleanups.

## Data model / API contract

- None. This is purely a code-quality cleanup.

## Workflow / cron / skill changes

- None.

## Test plan (AC verification matrix)

| AC | Verification |
|---|---|
| AC1 — `cargo clippy --manifest-path agents/workflows/feature-task/Cargo.toml --all-targets -- -D warnings` exits zero locally | CI runs the same command and reports green. Local run by the author before opening PR. |
| AC2 — dead code stranded by PR #259 (incl. `tagged_path_values`) is removed or justified with explicit allow/expect | Grep test: `rg "tagged_path_values" agents/workflows/feature-task/` returns zero hits OR returns a hit annotated with `#[allow(...)]` + comment. `CLIPPY_NOTES.md` documents each surviving item. |
| AC3 — existing clippy findings are either fixed or deliberately scoped with documented rationale | `CLIPPY_NOTES.md` enumerates every lint touched, classified fixed vs allowed-with-reason. |
| AC4 — `cargo test --manifest-path agents/workflows/feature-task/Cargo.toml` remains green | CI runs the test command; same set of tests as pre-PR. |

User-visible ACs: none — internal code quality. E2E not applicable. Verification is at the CI + cargo command layer.

## Open questions and risks

- **Test churn**: some tests may exercise the dead code and need to be deleted. That's expected; AC2 covers it.
- **Lint allowlist drift**: if we add more `#[allow]`s than we fix, the baseline is weaker than expected. The PR description should call out the ratio.
- **`-D warnings` vs `-D clippy::all`**: we stick with `-D warnings` because that matches sibling task `cbe3333a` and `e9c06d01`. If we want to enforce style lints separately, that's a future task.

## Linked tasks

- `cbe3333a` — Add feature-task clippy CI gate
- `e9c06d01` — Document clippy in Rowan PR workflow
- `55c98158` — Enforce clippy evidence in feature-task lobster