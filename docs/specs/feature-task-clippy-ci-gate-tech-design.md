---
status: draft
task_id: cbe3333a-4982-456a-85c6-54a0844fb3f5
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Add feature-task clippy CI gate

## Links

- Product spec: n/a — CI quality gate task
- Tech design: `docs/specs/feature-task-clippy-ci-gate-tech-design.md`
- Task: `cbe3333a-4982-456a-85c6-54a0844fb3f5`
- Tasks API record: `http://localhost:4001/api/v1/tasks/cbe3333a-4982-456a-85c6-54a0844fb3f5`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-cbe3333a-feature-task-clippy-ci-gate`
- Worktree: `~/workspaces/rowan/sindustries`
- Expected `.openclaw` follow-up: none — CI workflow changes only.

## Scope

Add a GitHub Actions job that runs `cargo clippy --manifest-path agents/workflows/feature-task/Cargo.toml --all-targets -- -D warnings` for PRs that touch `agents/workflows/feature-task/**`. The job blocks merge when clippy fails, but only **after** the baseline is clean (sibling task `1a0fc7df`).

## Shared scope note

This task is part of the clippy rollout alongside:

- `e9c06d01` — Document clippy in Rowan PR workflow (docs).
- `1a0fc7df` — Clean feature-task clippy baseline (must land **first** or the gate fails on merge of this PR).
- `55c98158` — Enforce clippy evidence in feature-task lobster (runtime enforcement; lands after CI gate).

## Ownership boundary

- CI lives in `.github/workflows/`. Repo-local; no `.openclaw` boundary.
- We add a **new** job, not modify existing test jobs. The existing test job continues to run `cargo test` independently.

## Implementation plan

File/module scope:

- `.github/workflows/feature-task-clippy.yml` — new. Triggers on `pull_request` and `push` to `main` when paths under `agents/workflows/feature-task/**` change. Steps:
  1. `actions/checkout@v4`
  2. `dtolnay/rust-toolchain@stable` with `components: clippy`
  3. `cargo clippy --manifest-path agents/workflows/feature-task/Cargo.toml --all-targets -- -D warnings --color always`
  4. Emit SARIF via `cargo clippy --message-format=json` → `github/codeql-action/upload-sarif` so findings show in the PR's Security tab (optional, not required for AC).
- `.github/workflows/ci.yml` (or root CI workflow) — add the new job as a **required** status check for PRs touching the path. Use `paths` filter on the existing job or add a separate required check; the simpler path is to make the new clippy workflow a required check via branch protection rules. Note in the PR description that branch protection must be updated by Quinn.
- `agents/workflows/feature-task/CONTRIBUTING.md` (or WORKFLOW.md) — short note on running the same clippy command locally and how to read CI output.
- Update root CI workflow's `permissions` if SARIF upload is added.

## Data model / API contract

- None.

## Workflow / cron / skill changes

- None inside this repo. Quinn must update branch protection in GitHub repo settings to mark the new clippy check as required.

## Test plan (AC verification matrix)

| AC | Verification |
|---|---|
| AC1 — CI runs `cargo clippy --manifest-path agents/workflows/feature-task/Cargo.toml --all-targets -- -D warnings` on relevant Rust changes | Manual: open a PR that edits a file under `agents/workflows/feature-task/`; assert the job runs. Manual: open a PR that touches only docs outside that path; assert the job is skipped. |
| AC2 — clippy job is required/visible alongside existing CI checks for PRs touching `agents/workflows/feature-task/**` | Manual: confirm the check appears in the PR's required-checks list. Document the branch-protection step in the PR description (Quinn applies it). |
| AC3 — CI still runs existing feature-task tests | Manual: confirm `cargo test --manifest-path agents/workflows/feature-task/Cargo.toml` step in the existing CI still runs and passes. |
| AC4 — documentation explains how to run clippy locally | `WORKFLOW.md` / `CONTRIBUTING.md` diff contains the verbatim command. |

User-visible ACs: none — CI infrastructure. E2E not applicable. Verification is manual-on-PR plus CI status.

## Open questions and risks

- **Baseline dependency**: this task cannot land before `1a0fc7df` (baseline cleanup). Otherwise the very first CI run fails on existing lints and blocks every subsequent PR.
- **Branch protection**: Quinn owns the GitHub repo setting. Flag it explicitly.
- **Caching**: add `Swatinem/rust-cache@v2` to keep clippy under ~2 min. If cache misses on cold runs, total CI may exceed current budget.

## Linked tasks

- `e9c06d01` — Document clippy in Rowan PR workflow
- `1a0fc7df` — Clean feature-task clippy baseline (must land first)
- `55c98158` — Enforce clippy evidence in feature-task lobster