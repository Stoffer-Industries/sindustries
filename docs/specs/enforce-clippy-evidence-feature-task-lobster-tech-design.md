---
status: draft
task_id: 55c98158-00e0-4f0e-b201-42a66f03e605
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Enforce clippy evidence in feature-task lobster

## Links

- Product spec: n/a — workflow enforcement task
- Tech design: `docs/specs/enforce-clippy-evidence-feature-task-lobster-tech-design.md`
- Task: `55c98158-00e0-4f0e-b201-42a66f03e605`
- Tasks API record: `http://localhost:4001/api/v1/tasks/55c98158-00e0-4f0e-b201-42a66f03e605`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-55c98158-enforce-clippy-evidence-feature-task-lobster`
- Worktree: `~/workspaces/rowan/sindustries`
- Expected `.openclaw` follow-up: none — workflow code only.

## Scope

Add clippy-evidence enforcement to `agents/workflows/feature-task/` lobster so that PRs touching the Rust crate must include the clippy command output (or a clean CI link) in the PR body. The task title says "optionally" — we treat it as opt-in but the wiring ships so Quinn can flip the gate on once CI proves stable.

## Shared scope note

This is the **last** piece of the clippy rollout:

- `1a0fc7df` — Clean feature-task clippy baseline (must land first).
- `cbe3333a` — Add feature-task clippy CI gate (must land second).
- `e9c06d01` — Document clippy in Rowan PR workflow.
- `55c98158` — this task (last; ships enforcement on top of an existing CI gate).

## Ownership boundary

- All changes inside `agents/workflows/feature-task/`. Repo-local; no `.openclaw` boundary.
- The enforcement is a Rust-side check in `verify_delivery` (the existing post-PR checks module). It inspects the PR body text plus the list of files changed; only Rust-touching PRs are subject to the gate.

## Implementation plan

File/module scope:

- `agents/workflows/feature-task/src/verify_delivery.rs` — extend `verify_delivery` to detect "Rust workflow PR" via `changed_paths_contain("agents/workflows/feature-task/")`. When true:
  - Parse the PR body looking for a fenced code block whose first line starts with `cargo clippy` or a literal substring `clippy --manifest-path agents/workflows/feature-task/Cargo.toml --all-targets -- -D warnings`.
  - If found → mark `[feature-task-progress-checklist]` clippy line as ✅.
  - If missing → emit a blocker: `[feature-task-progress-checklist] missing clippy evidence. Run: cargo clippy --manifest-path agents/workflows/feature-task/Cargo.toml --all-targets -- -D warnings` with a stable tag the lobster can recognize.
- `agents/workflows/feature-task/src/verify_delivery.rs` — add a feature flag (env or const) `CLIPPY_ENFORCE=true|false`. Default `false` so the rollout is opt-in; flip to `true` once CI has been green for ≥1 week.
- `agents/workflows/feature-task/src/verify_delivery.rs` — non-Rust / content-only PRs are explicitly skipped. Add a guard at the top of the new branch: `if !touches_rust_workflow { return Ok(NoOp); }`.
- `agents/workflows/feature-task/src/verify_delivery.rs` — add unit tests for the three cases (required, missing, not-applicable). Use existing test fixtures for the PR body parser.
- `agents/workflows/feature-task/WORKFLOW.md` — note that the gate is opt-in via `CLIPPY_ENFORCE` and that the matching PR-body template lives in `agents/agents/PR_OPENING_GUIDANCE.md`.

## Data model / API contract

- None.

## Workflow / cron / skill changes

- None outside the Rust workflow. The `verify_delivery` lobster already runs on feature-task PRs; we are extending its checks, not adding a new pipeline.

## Test plan (AC verification matrix)

| AC | Verification |
|---|---|
| AC1 — `verify_delivery` detects Rust workflow PRs touching `agents/workflows/feature-task/**` and requires clippy evidence | Unit test: fixture with `changed_paths = ["agents/workflows/feature-task/src/foo.rs"]` + PR body without clippy block → blocker emitted. |
| AC2 — missing clippy evidence produces a clear `[feature-task-progress-checklist]` blocker with the exact command | Unit test: same fixture as AC1; assert blocker text contains the exact `cargo clippy --manifest-path agents/workflows/feature-task/Cargo.toml --all-targets -- -D warnings` command. |
| AC3 — non-Rust / content-only PRs are not blocked by the clippy evidence gate | Unit test: fixture with `changed_paths = ["docs/specs/foo.md"]` → returns `NoOp` / no blocker regardless of PR body. |
| AC4 — unit tests cover required, missing, and not-applicable cases | Three tests, one per case, all green. |

User-visible ACs: none — internal workflow enforcement. E2E not applicable. Verification is at the lobster unit-test layer.

## Open questions and risks

- **PR body parsing fragility**: PR bodies are free-form text. We anchor on the exact cargo command string (stable across templates) rather than parsing markdown structure. If the template changes, the matching string changes too.
- **Bypass via CI link**: a cleaner long-term design is to read the GitHub check status for the clippy CI job instead of parsing PR bodies. That requires a GitHub API call from the lobster; out of scope for this task.
- **Enabling the gate**: this task ships the gate disabled by default. Quinn should flip `CLIPPY_ENFORCE=true` once `cbe3333a` has been green for ≥1 week.

## Linked tasks

- `1a0fc7df` — Clean feature-task clippy baseline
- `cbe3333a` — Add feature-task clippy CI gate
- `e9c06d01` — Document clippy in Rowan PR workflow