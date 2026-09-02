---
status: draft
task_id: d578e547-e0ab-413d-abbb-3fd1a0098921
product_spec: n/a (refactor task from repo-audit-2026-W36, tag `repo-audit-2026-w36`)
shipped_pr: null
shipped_date: null
---

# Feature-task `main.rs`: split into focused modules + harden cited-test matching (A3 + A4)

## Links

- Product spec: n/a — task is from the weekly repo audit (`repo-audit-2026-w36`); goal is "split `agents/workflows/feature-task/src/main.rs` into modules alongside the existing `ac_parsing.rs` / `analytics.rs` pattern, and harden `cargo_test_leaf_outcome` so cross-module leaf-name collisions resolve deterministically."
- Tech design: `docs/specs/feature-task-main-rs-split-tech-design.md` (this file)
- Task: `d578e547-e0ab-413d-abbb-3fd1a0098921`
- Tasks API record: `http://localhost:4001/api/v1/tasks/d578e547-e0ab-413d-abbb-3fd1a0098921`
- Audit finding: `docs/repo-audits/2026-W36.md` findings **A3** + **A4** (PR #546, merged 2026-08-31)
- Sibling pattern (already in this crate): `ac_parsing.rs` (1,419 lines, extracted 2026-W32) and `analytics.rs` (626 lines, extracted task `f170e344`) — both prove the `pub(crate)` module split works for this binary
- Predecessor clippy-gate fix: task `afe39f3d-df3d-44ce-b5d8-3effe2ee6c8f` ("clippy-evidence gate fail-open", audit A2). The audit's Task Plan **T2.1 depends on QW1** so the gate fix isn't in flight during the mechanical move. PR #557 ships A2; A3+A4 work begins after that merge lands

## Problem statement

`agents/workflows/feature-task/src/main.rs` is **8,602 lines** (per audit snapshot; +68 since last week's audit) and holds **205 top-level `fn/struct/impl/enum/const` items** in one file. Among them:

- All five `TestRunner` implementations (`Pnpm/Cargo/Shell/Pytest/Dispatching`, `src/main.rs:4146-4509`) plus `cargo_test_leaf_outcome` (`:4209`), `select_test_runner_kind` (`:4410`), and the `TestRunnerKind` enum
- All PR-gate helpers (`pr_changed_files` `:4449`, `clippy_evidence_failures` `:4521`, plus `body_has_clippy_evidence`, `touches_rust_feature_workflow`, `clippy_enforce_enabled`, `clippy_evidence_missing_failure`, `decode_pr_body_output`, `parse_github_review_state`, `body_has_checked_acceptance`, the `ReviewState` enum)
- Test resolution helpers (`resolve_repo_file_by_name` `:4263`, `nearest_pyproject_dir` `:4342`, `repo_root_dir` `:4238`, `SEARCH_EXCLUDE_DIRS` `:4249`)
- ~198 inline `#[test]` / `#[cfg(test)]` markers spread across those clusters

The crate already has the pattern: `ac_parsing.rs` (1,419 lines, pure parsing, no I/O) and `analytics.rs` (626 lines, side-effect-only POSTs). `main.rs` is the holdout — single-binary CLI dispatch + ~8.5k lines of mixed concerns. The audit's T2.1 explicitly lists the items to move; this design is the ordered, reviewable plan.

**A4 (folded in, audit T3.1):** `cargo_test_leaf_outcome` (`src/main.rs:4209-4222`) compares only the post-`::` leaf segment of each cited test. Two same-leaf tests in different modules produce a false pass for whichever one is currently green — and a typo'd `test_name` with a same-leaf coincidence elsewhere gets marked "satisfied." This contradicts `resolve_repo_file_by_name`'s ambiguity-error discipline (`:4263+` errors on zero or multiple matches) and is a latent evidence-integrity gap. Low severity (rare in current code), but a fix costs ~20 lines and removes a category of mechanical-evidence false positives.

The fix is **mechanical extraction + a one-function behavior change**. No new public surface; no new dependency; no caller-visible behavior change beyond the leaf-match hardening.

## Scope

**In scope (modules + their contents):**

1. **`src/test_runners.rs`** — `PnpmTestRunner` (struct + `impl ac_parsing::TestRunner`), `CargoTestRunner`, `ShellTestRunner`, `PytestTestRunner`, `DispatchingTestRunner`, `cargo_test_leaf_outcome`, `select_test_runner_kind`, `TestRunnerKind`, plus `repo_root_dir` (used by `ShellTestRunner`'s `cwd` resolution) and `ShellTestRunner`'s inline `#[cfg(test)]` block. Every `#[test]` marker in the listed line ranges moves with its code.
2. **`src/test_resolution.rs`** — `resolve_repo_file_by_name`, `nearest_pyproject_dir`, `SEARCH_EXCLUDE_DIRS` const. Pure helpers; no I/O; `pub(crate)` surface consumed by `test_runners.rs` and by callers in `main.rs` (the lifecycle helpers at `select_matching_task_worktrees` and friends do not consume these, so the surface stays narrow).
3. **`src/pr_gates.rs`** — `pr_changed_files`, `body_has_clippy_evidence`, `touches_rust_feature_workflow`, `clippy_evidence_missing_failure`, `clippy_enforce_enabled`, `clippy_evidence_failures`, `CLIPPY_EVIDENCE_COMMAND`, `FEATURE_TASK_RUST_PREFIX`, `decode_pr_body_output`, `parse_github_review_state`, `body_has_checked_acceptance`, and the `ReviewState` enum (`:262-269`, currently a private enum — `pub(crate)` after extraction). All `#[cfg(test)]` blocks in this cluster move with their code.

**Out of scope (stays in `main.rs`):**

- CLI entry/dispatch (`Cli` struct, `Commands` enum, `main`, every `fn <stage>_checks`/`fn <stage>_deliver`/etc. stage function)
- Brain spec reconciliation cluster (`reconciliation_spec_link`, `plan_brain_spec_approval`, `grant_reconciled_spec_approval`, `reconcile_brain_spec_approvals`) — out of scope this round; mentioned here only so future extractions have a clean map
- Spec lifecycle cluster (`plan_chat_spec_lifecycle_move`, `archive_*`, `rewrite_*`, `move_approved_chat_spec_if_needed`, `archive_done_task_specs_sweep`) — same
- API helpers (`api_get`, `api_patch`, `api_delete`, `add_comment`, `handle_api_result`, `api_status_error`, `lobster_service_token`, `authenticated_api_patch_request`)
- Capacity + workflow-attention helpers (`task_implementer`, `is_actionable_for`, `implementer_doing_capacity_failures`, `workflow_attention_owner`, `managed_owner_reason_satisfied`, `reconciled_attention_owners`, `reconcile_workflow_attention`, `workflow_handoff`, `transition_or_block`)
- Spec-drift block helpers (`block_on_spec_drift_fluid`, `publish_spec_approval_handoff`, `manual_block_failures`, `block_with_manual_block`)
- Worktree helpers (`parse_git_worktree_porcelain`, `select_matching_task_worktrees`, `remove_worktrees_best_effort`, `cleanup_task_worktree_for_task`, `format_worktree_cleanup_summary`, `run_post_merge_worktree_cleanup`)
- Lobster state + spec checksum helpers (`parse_lobster_state`, `spec_failures`, `missing_spec_checksum_failures`, `spec_is_approved`, `acceptance_criteria_*`, `canonical_json_*`, `workstreams`, `parse_workstreams`, `tagged_values`, `tech_design_*`, `implementer_pr_urls`, `implementer_active_pr_urls_with`, `inspect_pr`, `pr_body`)

These out-of-scope clusters already have clean boundaries; the audit's T2.1 names the items to extract this round, and this design honours that scope. A follow-up audit (W37+ if findings warrant) can propose the next tranche.

**Behaviour-preserving by construction:** no caller-visible change except (a) the A4 leaf-match hardening (called out below) and (b) the `ReviewState` visibility bump to `pub(crate)` (no external consumer exists — it's only used inside this crate).

## Current state

### Module pattern already proven in this crate

`ac_parsing.rs` is the canonical reference: a single `mod ac_parsing;` declaration in `main.rs:16`, with everything else accessed as `ac_parsing::<symbol>`. `analytics.rs` follows the same pattern (`mod analytics;` at `main.rs:17`). Both files declare `use` imports at the top, own their inline tests, and use `pub(crate)` for symbols consumed by `main.rs`.

The new modules follow this pattern exactly:

- `mod test_runners;` at the top of `main.rs`
- `mod test_resolution;` at the top of `main.rs`
- `mod pr_gates;` at the top of `main.rs`

`main.rs` keeps `mod ac_parsing;` and `mod analytics;` (unchanged) and the `Cli` / `Commands` / `main()` / every stage function unchanged.

### A4: leaf-only matcher (current)

```rust
fn cargo_test_leaf_outcome(stdout: &str, test_name: &str) -> i32 {
    let mut found = false;
    for line in stdout.lines() {
        let Some(rest) = line.strip_prefix("test ") else { continue; };
        let Some((path, status)) = rest.rsplit_once(" ... ") else { continue; };
        if path.rsplit("::").next().unwrap_or(path) != test_name { continue; }
        found = true;
        if status.trim() != "ok" { return 1; }
    }
    if found { 0 } else { 1 }
}
```

Path: `agents/workflows/feature-task/src/main.rs:4209-4222`. Behaviour in the failure mode the audit flagged: if two modules define `tests::works` and a third module defines `unit::works`, the cited bare name `works` matches whichever leaf last appears in stdout — and a typo'd name that collides with an unrelated passing test gets marked "found".

### Sibling ambiguity discipline (the pattern to mirror)

`resolve_repo_file_by_name` (`src/main.rs:4263-4312`) walks the repo tree once and applies a clear policy on count:

```text
0 matches → Err("no file named <name> in repo")
1 match   → Ok(<abs-path>)
>1 matches → Err("ambiguous citation: <name>; candidates: …")
```

`cargo_test_leaf_outcome` should mirror this discipline for cited test names. The exact rule is in the **Architecture approach** below.

### Inline test inventory

The three extracted clusters carry the following `#[cfg(test)]` blocks (audit-confirmed counts are approximate; the design does not depend on exact counts — each `#[test]` moves with its parent code):

- `test_runners` cluster: ~50 inline tests (Pnpm/Cargo/Shell/Pytest/Dispatching runner tests + `cargo_test_leaf_outcome` parser tests + `select_test_runner_kind` dispatch tests + `TestRunnerKind` cases)
- `test_resolution` cluster: ~10 inline tests (`resolve_repo_file_by_name` happy-path + 0-match + >1-match cases; `nearest_pyproject_dir` walks)
- `pr_gates` cluster: ~30 inline tests (`pr_changed_files` empty/gh-failure paths, `body_has_clippy_evidence` positive/negative, `touches_rust_feature_workflow` prefix matching, `clippy_enforce_enabled` env parsing, `clippy_evidence_failures` gate-on/off/rust/no-rust, `parse_github_review_state` JSON shapes, `decode_pr_body_output` JSON-string vs raw, `body_has_checked_acceptance` regex)

All move with their code.

## Architecture approach

### Source of truth for module boundaries

Three new modules, **no `pub` symbols** — only `pub(crate)`. Every `pub(crate)` symbol on the new modules is consumed exclusively by `main.rs` (already true today). The `ReviewState` enum currently has no visibility modifier (`enum ReviewState` at `:262`) — that means private to the `main.rs` file. After extraction it becomes `pub(crate) enum ReviewState` in `pr_gates.rs`. No external crate consumes it (verified: grep `ReviewState` across the workspace — only matches in this file).

### Module file contents (precise inventory)

#### `src/test_runners.rs`

Imports: `use std::path::{Path, PathBuf};`, `use std::process::Command;`, `use anyhow::Result;`, `use crate::ac_parsing;`.

Symbols:

- `struct PnpmTestRunner;`
- `impl ac_parsing::TestRunner for PnpmTestRunner { fn run(&self, test_name: &str) -> Result<ac_parsing::TestOutcome, String> { … } }`
- `struct CargoTestRunner;`
- `impl ac_parsing::TestRunner for CargoTestRunner { … }` — body invokes `cargo_test_leaf_outcome` (now `crate::test_runners::cargo_test_leaf_outcome`, but since both live in the same module, it's just `cargo_test_leaf_outcome`)
- `struct ShellTestRunner { cwd: PathBuf }` (the `cwd` field is set by `DispatchingTestRunner`; verify by reading `:4314-4328` at extraction time)
- `impl ShellTestRunner { fn run_with_cwd(&self, test_name: &str) -> … }` — extracts the existing per-runner invocation logic that currently lives inline
- `impl ac_parsing::TestRunner for ShellTestRunner { … }`
- `struct PytestTestRunner;`
- `impl ac_parsing::TestRunner for PytestTestRunner { … }`
- `enum TestRunnerKind { Shell, Pytest, Cargo, Pnpm }`
- `fn select_test_runner_kind(test_name: &str, is_rust_pr: bool) -> TestRunnerKind`
- `fn cargo_test_leaf_outcome(stdout: &str, test_name: &str) -> i32` — **A4 hardening applied here** (see "A4 fix" below)
- `fn repo_root_dir() -> PathBuf` — moves with `ShellTestRunner` because the constructor wires it into `cwd`
- All `#[cfg(test)] mod tests` blocks currently living between `main.rs:4135-4430`

#### `src/test_resolution.rs`

Imports: `use std::path::{Path, PathBuf};`, `use anyhow::Result;`, `use walkdir::WalkDir;` (already in `Cargo.toml` for this crate; verify at extraction time — if not present, add it).

Symbols:

- `const SEARCH_EXCLUDE_DIRS: &[&str] = &[".git", "target", "node_modules", ".venv", "dist", "build"];`
- `fn resolve_repo_file_by_name(repo_root: &Path, name: &str) -> Result<PathBuf, String>` — current behaviour preserved as-is
- `fn nearest_pyproject_dir(repo_root: &Path, start_file: &Path) -> Option<PathBuf>`
- `#[cfg(test)] mod tests` block currently at `main.rs:~4308`

#### `src/pr_gates.rs`

Imports: `use std::process::Command;`, `use anyhow::Result;`, `use regex::Regex;`, `use serde_json::Value;`, `use crate::pr_body;` (re-import the existing `pr_body` function from `main.rs` so `parse_github_review_state` keeps working — or hoist it too in a follow-up; this design keeps `pr_body` in `main.rs` since it's also used by `inspect_pr` and friends).

Symbols:

- `pub(crate) enum ReviewState { Approved, Required, ChangesRequested, CommentsPresent, Merged, ClosedUnmerged }` (visibility bump from file-private)
- `const CLIPPY_EVIDENCE_COMMAND: &str = "cargo clippy --manifest-path agents/workflows/feature-task/Cargo.toml --all-targets -- -D warnings";`
- `const FEATURE_TASK_RUST_PREFIX: &str = "agents/workflows/feature-task/";`
- `fn pr_changed_files(url: &str) -> Vec<String>` — current behaviour preserved (the A2 fix from `afe39f3d` may have already changed its signature; if so, this design documents the post-A2 shape and moves it as-is)
- `fn body_has_clippy_evidence(body: &str) -> bool`
- `fn touches_rust_feature_workflow(files: &[String]) -> bool`
- `fn clippy_evidence_missing_failure() -> String`
- `fn clippy_enforce_enabled() -> bool`
- `fn clippy_evidence_failures(url: &str) -> Vec<String>`
- `fn decode_pr_body_output(raw: &str) -> String`
- `fn parse_github_review_state(raw: &str) -> Result<ReviewState>`
- `fn body_has_checked_acceptance(body: &str) -> bool`
- All `#[cfg(test)] mod tests` blocks in `main.rs:4477-4610`

### A4 fix: `cargo_test_leaf_outcome` matches full path or errors on ambiguity

Replace the leaf-only match with the same ambiguity-error discipline `resolve_repo_file_by_name` applies. Pseudocode:

```rust
fn cargo_test_leaf_outcome(stdout: &str, test_name: &str) -> i32 {
    let mut candidates: Vec<&str> = Vec::new();
    for line in stdout.lines() {
        let Some(rest) = line.strip_prefix("test ") else { continue; };
        let Some((path, status)) = rest.rsplit_once(" ... ") else { continue; };
        if path == test_name || path.rsplit("::").next().unwrap_or(path) == test_name {
            candidates.push(path);
            if status.trim() != "ok" { return 1; } // any failing match is a fail
        }
    }
    match candidates.len() {
        0 => 1,                                            // no match → fail (current behaviour)
        1 => 0,                                            // single match → pass iff all matched lines were "ok" (already enforced above)
        _ if all_paths_fully_distinct(candidates, test_name) => 0, // distinct paths, all ok
        _ => 1,                                            // ambiguous leaf collision → fail
    }
}
```

Where `all_paths_fully_distinct` is true iff no two candidates share the same `rsplit("::").next()` leaf **and** `test_name` does not itself contain `::`. If `test_name` is a fully-qualified path (`tests::works`), match exactly; if `test_name` is a leaf (`works`), require that exactly one candidate's leaf matches. Mirror `resolve_repo_file_by_name`'s `Err` text in a stderr line that `TestOutcome.stderr` carries so the failure surfaces in `clippy_evidence_failures` / `cargo_test_leaf_outcome`-driven gate checks.

The new test (AC5) covers two scenarios:

- `tests::works` in module A + `unit::works` in module B, cited as `tests::works` → resolves to module A
- `tests::works` in module A + `unit::works` in module B, cited as bare `works` → returns 1 with stderr `"ambiguous citation: 'works' matches multiple test paths (tests::works, unit::works); cite the full path"`

### Extraction ordering (PR-by-PR sequence)

To keep each PR reviewable and bisectable, extract in **three sequential PRs** that each leave the crate green:

1. **PR-A: extract `pr_gates.rs`** — move the `pr_gates` cluster (function-by-function, smallest blast radius — no public surface change, all internal). Verify `cargo test --bin feature-task` stays green. Verify `clippy_evidence_failures` + `parse_github_review_state` callers in `main.rs` continue to compile (visibility change to `ReviewState` is the only knock-on, handled by `pub(crate)`).
2. **PR-B: extract `test_resolution.rs`** — move `resolve_repo_file_by_name` + `nearest_pyproject_dir` + `SEARCH_EXCLUDE_DIRS`. Pure helpers; no behaviour change. Verify `cargo test` green.
3. **PR-C: extract `test_runners.rs` + apply A4 fix** — move the five `TestRunner` impls + `cargo_test_leaf_outcome` + `select_test_runner_kind` + `TestRunnerKind` + `repo_root_dir`. Apply the A4 hardening in the same PR (or its own PR-D immediately after — see Open Questions). Verify `cargo test` green and the new AC5 test passes.

PR-C is the largest by line count (~300 lines including inline tests) but the smallest by risk because `TestRunner` impls are entirely behind `ac_parsing::TestRunner` and consumed only via the dispatch path.

The A4 fix can ship as PR-D (one commit on top of PR-C) if Quinn prefers the fix isolated. If Quinn prefers the fix and the move in one PR, PR-C carries both.

### What the final `main.rs` looks like

After PR-A + PR-B + PR-C (and PR-D if separated):

```rust
mod ac_parsing;
mod analytics;
mod test_runners;
mod test_resolution;
mod pr_gates;
```

plus all out-of-scope clusters unchanged. Estimated line-count target after all three extractions: `main.rs` ~5,000 lines (down from 8,602). AC1's "<~2,000 lines" target is not achievable in this round — it requires extracting at least one more large cluster (brain-spec reconciliation ~700 lines, spec lifecycle ~700 lines, API helpers ~150 lines, worktree helpers ~250 lines, lobster-state + spec-checksum helpers ~600 lines). **This design explicitly defers AC1's hard "<~2,000" line target to a follow-up audit**: A3's primary goal (named modules per concern, each reviewable in isolation) is met; the line-count target is a stretch that requires a second tranche of extractions. Quinn to confirm in design review whether AC1 should be revised to "<~5,000 lines after A3+A4" or whether AC1's "<~2,000 lines" stays as-is and a second audit/cycle delivers it.

### Migration safety

- **`use` re-exports:** none of the three modules needs to re-export anything to `main.rs`. Every call site in `main.rs` already uses the existing `<symbol>` lookup pattern; after extraction it becomes `pr_gates::<symbol>`, `test_runners::<symbol>`, `test_resolution::<symbol>`. Mechanical find-replace per PR.
- **`pub(crate)` surface:** every extracted symbol gains `pub(crate)` visibility. No symbol on the new modules is `pub` (no external crate consumes any of them).
- **Inline tests:** `#[cfg(test)] mod tests` blocks move with their parent code. No test is lost, added, or skipped during the move.
- **`clippy --all-targets -- -D warnings`:** the audit A1 sibling PR's clippy gate applies to the new modules. The extraction commits must leave the crate clippy-clean; PR-A/B/C all run clippy as part of the local verification (no CI gate today — the audit's T1.1 / A1 sibling ensures clippy evidence is in the PR body).

## Acceptance Criteria mapping

- **AC1 → deferred (Quinn to confirm in review).** Hard "<~2,000 lines" target requires a second tranche of extractions beyond A3+A4's scope. Post-A3+A4 estimate: `main.rs` ~5,000 lines. Recommend revising AC1 to "<~5,000 lines after A3+A4, with named modules per concern" or keeping AC1 as-is and adding a follow-up task for the next tranche.
- **AC2 → all of PR-A + PR-B + PR-C.** Every named function moves to a named module. `TestRunnerKind` and `ReviewState` enums move to `test_runners.rs` and `pr_gates.rs` respectively.
- **AC3 → PR-C (or PR-D).** `cargo_test_leaf_outcome` matches the full cited path (or errors on multiple leaf matches). Mirror `resolve_repo_file_by_name` ambiguity discipline.
- **AC4 → all of PR-A + PR-B + PR-C.** Existing tests stay green unchanged. The same number of `#[test]` markers exists before and after extraction; each moves with its parent code.
- **AC5 → PR-C (or PR-D).** A new test demonstrates deterministic behaviour on a multi-module same-leaf scenario — either resolves the intended module or fails as ambiguous. Test file: `agents/workflows/feature-task/src/test_runners.rs::tests`.
- **AC6 → this file.** Tech design committed and reviewed before the first extraction PR opens; covers module boundaries, ordering, and how inline tests move with their code. **Status: this PR.**

## Open Questions for Quinn

1. **AC1 line-count target.** Should AC1 stay "<~2,000 lines" (requires follow-up task + audit for the second tranche), or revise to "<~5,000 lines after A3+A4, with named modules per concern"? My recommendation: revise to "<~5,000 lines after A3+A4, with named modules per concern" — this matches the audit's T2.1 scope and lets the second tranche land on its own audit when findings warrant.
2. **A4 fix isolation.** Apply the A4 hardening in PR-C alongside the `test_runners` extraction, or in a separate PR-D immediately after? My recommendation: PR-D isolated. The move is mechanical; the A4 fix is a behaviour change (even if tiny). Keeping them separate keeps bisection clean and lets the A4 fix get its own review focus.
3. **`pr_body` extraction.** `pr_gates::parse_github_review_state` uses `pr_body(url)` (currently at `main.rs:4118`). `pr_body` is also used by `inspect_pr` (which lives outside this PR's scope). Two options: (a) keep `pr_body` in `main.rs` and `use crate::pr_body;` from `pr_gates.rs`; (b) extract `pr_body` to `pr_gates.rs` alongside `parse_github_review_state`. My recommendation: option (a) — `pr_body` belongs with `inspect_pr`, which is consumed by capacity helpers that stay in `main.rs`.
4. **`ReviewState` visibility bump.** Currently file-private. Extracting to `pr_gates.rs` requires `pub(crate)`. Confirms that no external crate imports `feature_task::ReviewState` (verified by grep across the workspace — no matches outside this crate). OK to proceed?

## Implementation sketch

### PR-A (extract `pr_gates.rs`)

```bash
git mv agents/workflows/feature-task/src/main.rs agents/workflows/feature-task/src/_main_rs_pr_a_pre.rs  # temp
# rewrite _main_rs_pr_a_pre.rs with new mod declarations and slim-down (manual edit)
git mv agents/workflows/feature-task/src/_main_rs_pr_a_pre.rs agents/workflows/feature-task/src/main.rs
git add agents/workflows/feature-task/src/main.rs agents/workflows/feature-task/src/pr_gates.rs
# commit + push + PR (no [implementer-prs] delivery — pure refactor)
```

Concretely:

1. Create `src/pr_gates.rs` with the imports + the `pub(crate) enum ReviewState` + the 11 functions above (moved 1:1, no behaviour change) + the inline tests.
2. Edit `src/main.rs`: add `mod pr_gates;`, delete the moved blocks, change call sites from `review_state` to `pr_gates::review_state` (and likewise for every other extracted symbol). Mechanical grep + edit.
3. `cargo build --bin feature-task` — verify it compiles.
4. `cargo test --bin feature-task` — verify all existing tests stay green.
5. `cargo clippy --manifest-path agents/workflows/feature-task/Cargo.toml --all-targets -- -D warnings` — verify clippy clean (per audit A1 sibling PR's clippy-evidence convention).
6. Commit, push, open PR with the standard refactor PR template (no AC list — refactor only; no `qa_agent` gate).

### PR-B (extract `test_resolution.rs`)

Same pattern. `src/test_resolution.rs` gets the three symbols (two functions, one const) + the inline tests. `main.rs` adds `mod test_resolution;` and updates two call sites (`ShellTestRunner`'s `cwd` resolution, and the `repo_root_dir` consumers).

### PR-C (extract `test_runners.rs`)

Same pattern. Larger surface (five impls + three free functions + one struct + one enum + `repo_root_dir`) but bounded — no behaviour change at this step. `main.rs` adds `mod test_runners;` and updates all call sites in `DispatchingTestRunner`'s match arms + the lifecycle helpers that consume `TestRunnerKind`.

### PR-D (A4 hardening) — only if Quinn chooses option-2 above

Isolated one-commit change to `cargo_test_leaf_outcome` in `test_runners.rs`. Adds the AC5 multi-module same-leaf test. No call-site changes (the function signature stays the same; only the matcher body changes).

### Post-merge

Same merge rule: I (opener) merge after Quinn approves each PR and CI is green; Tom tests post-merge in main; his sign-off is `[qa-ac-verified] true` on `d578e547` after the A4 PR-D lands (the three extraction PRs are pure refactors and do not gate task acceptance).

## Status

- Task remains in `open` until Quinn flips the `tech_design` approval gate to `approved`
- After Quinn approval: implementation begins in three (or four, if PR-D is isolated) sequential PRs from `d578e547-feature-task-split-tech-design` → branched worktree
- Each extraction PR is a pure refactor — no `qa_agent` gate, no `[implementer-prs]` delivery comment per PR; the final A4 PR (PR-C or PR-D) is the only one that satisfies `qa-ac-verified` and posts `[implementer-prs]` with the AC-list body
- Merge: opener (me) merges after Quinn approves + green CI per PR; Tom tests post-merge in main