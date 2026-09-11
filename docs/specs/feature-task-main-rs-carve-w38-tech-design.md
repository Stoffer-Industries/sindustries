---
status: shipped
task_id: fd1aeef8-cd32-4d66-9149-6af8fa93e7d0
product_spec: n/a (refactor task from repo-audit-2026-W37, finding A3, W38+ second tranche)
shipped_pr: 647
shipped_date: 2026-09-12
---

# Feature-task `main.rs` — W38+ second tranche (finish the carve)

## Links

- Product spec: n/a — task is the W38+ follow-up to the W37 A3 carve, also sourced from the W37 audit (`docs/repo-audits/2026-W37.md` finding A3). Goal: bring `agents/workflows/feature-task/src/main.rs` below ~3,000 lines so AC1 (orchestration-only) closes.
- Tech design: `docs/specs/feature-task-main-rs-carve-w38-tech-design.md` (this file)
- Task: `fd1aeef8-cd32-4d66-9149-6af8fa93e7d0` — the W38+ second tranche ledger entry
- Tasks API record: `http://localhost:4001/api/v1/tasks/fd1aeef8-cd32-4d66-9149-6af8fa93e7d0`
- Audit finding: `docs/repo-audits/2026-W37.md` finding **A3** (also referenced in PR #642 audit-ledger update)
- Predecessor tech design: `docs/specs/feature-task-main-rs-carve-w37-tech-design.md` (W37 A3 first tranche, task `9b10c65a`, PRs #615 / #621 / #623 / #624 / #625 / #626 / #632 / #636 / #639 / #640 / #641, all MERGED 2026-09-09/10)
- Predecessor task: `9b10c65a-0eb3-4ff2-92ca-d262e12c2e10` — W37 A3 first tranche (10 PRs landed, AC2/AC3 satisfied per slice, AC1/AC4 deferred to this task)
- Audit-ledger PR: #642 (link W37 A3 finding to `fd1aeef8`, opened 2026-09-10, awaits Quinn + Stoff81 review)
- Sibling pattern in this crate: every extracted module uses `pub(crate)` for items consumed only inside the crate, owns its inline `#[cfg(test)]` block, declares `mod <name>;` at the top of `main.rs`, and ships a `//!` doc comment listing its public surface. The 15 modules carved in W37 (`ac_parsing`, `analytics`, `api_client`, `brain_spec_lifecycle`, `feedback_aggregate`, `git_worktree`, `lobster_state`, `post_merge`, `pr_gates`, `product_spec_parsing`, `spec_check_ready`, `task_approvals`, `test_resolution`, `test_runners`, `verify_delivery`) are the reference shapes.

## Problem statement

After the W37 A3 first tranche (PR-A1 through PR-J), `agents/workflows/feature-task/src/main.rs` is **4,592 lines** (down from 8,090 baseline, -43.2%) with 56 top-level items. Fifteen sibling modules exist. The W37 audit's `main.rs` god-file concern remains open because AC1 (< 3,000 lines) is not yet met.

Per the W37 tech design's out-of-scope section, the following clusters were deliberately left in `main.rs` after PR-J:

1. **Analytics replay cluster** (~155 lines) — `analytics_replay`, `replay_envelope`, `print_replay`, `format_seconds`, `format_evidence`, `load_dotenv_token` (lines 308–480).
2. **CLI dispatch / load_task / pr_body helpers** (~120 lines) — `gh_command`, `pr_body`, `load_task` (lines 476–539).
3. **Brain-spec reconciliation + archive planning cluster** (~670 lines) — `BrainSpecApprovalPlan` + `reconciliation_spec_link` + `plan_brain_spec_approval` + `feature_policy_requires_spec` + `grant_reconciled_spec_approval` + `reconcile_brain_spec_approvals` (the open→ready reconcile bridge) plus the archive-cluster enums (`ArchiveSpecPlan`, `ArchiveOutcome`, `ArchiveSkipReason`, `ChatApprovalMovePlan`) and the archive-cluster helpers (`bootstrap_task_spec_layout`, `normalize_rel_path`, `plan_chat_spec_lifecycle_move`, `move_approved_chat_spec_if_needed`, `plan_task_spec_archive`, `resolve_archive_plan`, `rewrite_spec_line_in_description`, `archive_task_spec_for_done_task`) plus the BRAIN_DIR/TASK_SPECS_* constants and the TASK_SPEC_LIFECYCLE_DIRS const (lines 540–1207). The split with the existing `brain_spec_lifecycle.rs` is deliberate: `brain_spec_lifecycle.rs` = post-decision archive/cleanup outcome + spec-resync mechanics (PR-E #626); `brain_spec_reconcile.rs` (this PR's slice) = pre-decision planning + reconciliation + lifecycle move planning.
4. **Inline `#[cfg(test)] mod tests` block** (~3,100 lines, 144 `#[test]` functions) — the bulk of the remaining file (68% of the 4,592-line post-PR-J baseline). Tests live at `main.rs:1223-4592` and reference a mix of main.rs private items and `crate::module::*` paths.

Each cluster is a self-contained Rust module with a clean import boundary; every helper has a single testable purpose; none has a network or filesystem boundary the rest of the crate does not already share. The W37 design left them in `main.rs` because they each cross multiple stage boundaries (orchestration glue per the W36 pr_gates.rs docstring rationale). W38 reverses that call for the same reason W37 reversed the W36 call: the W36 trade-off was review-surface minimization; the W37 trade-off was line-count reduction with the same per-PR review-surface minimization. W38 picks up the line-count reduction where W37 stopped.

## Scope

**In scope (this task's multi-PR trajectory — ordered by cleanest cluster boundary first, then by per-PR review-surface minimization):**

1. **Slice 1 — `analytics_replay.rs`** (~155 lines moved out). Extract the `analytics_replay(args: AnalyticsArgs)` stage handler, `replay_envelope`, `print_replay`, `format_seconds`, `format_evidence`, `load_dotenv_token` from `src/main.rs` (lines 308–480) into a new `src/analytics_replay.rs` module. All `pub(crate)`. CLI dispatch reroute: `Commands::Analytics(args) => analytics_replay::analytics_replay(args)?`. Test relocation: `format_seconds` / `format_evidence` / `print_replay` / `load_dotenv_token_*` tests move into `analytics_replay::tests`. Cross-module dependency: `analytics_replay` consumes `crate::analytics::chrono_like_now_iso()` (already pub(crate) since PR-A1) and `crate::api_client::handle_api_result` (already pub(crate) since PR-G #636).
2. **Slice 2 — `cli_utils.rs`** (~120 lines moved out). Extract `pr_body`, `load_task`, `gh_command` from `src/main.rs` (lines 476–539) into a new `src/cli_utils.rs` module. All three are `pub(crate)`. CLI dispatch reroute: `Commands::LoadTask { base_url, task_id } => cli_utils::load_task(&base_url, &task_id)?`. `gh_command` stays module-private (only called inside `cli_utils`). Test relocation: `pr_body_*` / `load_task_*` / `gh_command_*` tests move into `cli_utils::tests`. Cross-module dependency: `load_task` consumes `crate::ac_parsing::*`, `crate::pr_gates::*`, `crate::brain_spec_lifecycle::*`, `crate::task_approvals::*` (all already pub(crate) since the relevant earlier carve PRs).
3. **Slice 3 — `brain_spec_reconcile.rs`** (~670 lines moved out). Extract the brain-spec reconciliation + archive-planning cluster from `src/main.rs` (lines 540–1207) into a new `src/brain_spec_reconcile.rs` module. 19 `pub(crate)` items: `BrainSpecApprovalPlan`, `reconciliation_spec_link`, `plan_brain_spec_approval`, `feature_policy_requires_spec`, `grant_reconciled_spec_approval`, `reconcile_brain_spec_approvals`, `ArchiveSpecPlan`, `ArchiveOutcome`, `ArchiveSkipReason`, `ChatApprovalMovePlan`, `bootstrap_task_spec_layout`, `normalize_rel_path`, `plan_chat_spec_lifecycle_move`, `move_approved_chat_spec_if_needed`, `plan_task_spec_archive`, `resolve_archive_plan`, `rewrite_spec_line_in_description`, `archive_task_spec_for_done_task`. Constants (`BRAIN_DIR`, `TASK_SPECS_DIR`, `TASK_SPECS_OPEN_DIR`, `TASK_SPECS_IN_PROGRESS_DIR`, `TASK_SPECS_DONE_DIR`, `BRAIN_SPEC_APPROVAL_NOTE_PREFIX`, `TASK_SPEC_LIFECYCLE_DIRS`) move with the cluster (`pub(crate) const`). The `impl ArchiveSkipReason` block moves with the enum. CLI dispatch reroute: `Commands::ReconcileBrainSpecApprovals(args) => brain_spec_reconcile::reconcile_brain_spec_approvals(args)?`. Cross-module dependency: `brain_spec_reconcile` consumes `crate::brain_spec_lifecycle::*` (already pub(crate) since PR-E #626), `crate::product_spec_parsing::*` (already pub(crate) since PR-F #632), `crate::api_client::*` (already pub(crate) since PR-G #636). Test relocation: `archive_task_spec_for_done_task_*` / `rewrite_spec_line_in_description_*` / `plan_task_spec_archive_*` / `resolve_archive_plan_*` / `reconciliation_spec_link_*` / `plan_brain_spec_approval_*` tests move into `brain_spec_reconcile::tests`. The existing `brain_spec_lifecycle::tests` block stays where it is — no test relocation across module boundaries.
4. **Slice 4 — `tests_integration.rs` + `mod tests` split** (~3,100 lines moved out). Split the inline `#[cfg(test)] mod tests` block at `main.rs:1223-4592` across:
   - **Per-module test blocks** (already the W37 carve pattern): the `archive_task_spec_for_done_task_*` / `rewrite_spec_line_in_description_*` / `plan_task_spec_archive_*` / `resolve_archive_plan_*` / `reconciliation_spec_link_*` / `plan_brain_spec_approval_*` tests move into `brain_spec_reconcile::tests` (the Slice 3 module). The `format_*` / `print_replay` / `load_dotenv_token_*` tests move into `analytics_replay::tests` (the Slice 1 module). The `pr_body_*` / `load_task_*` / `gh_command_*` tests move into `cli_utils::tests` (the Slice 2 module). The `load_dotenv_token` test is a special case: it mutates the process-global HOME env var, so it must remain a single test (per its current comment) — move to `analytics_replay::tests` verbatim.
   - **A new `src/tests_integration.rs` module** with `#[cfg(test)] mod tests` hosting the cross-cutting tests that reference multiple modules via `crate::module::*` paths. These include the `routing_*` cluster (workflow attention owner routing; references `crate::spec_check_ready::*`, `crate::task_approvals::*`), the `workflow_for_task_*` cluster, the `implementer_capacity_*` cluster (references `crate::lobster_state::*`), the `latest_implementer_pr_urls_*` cluster (references `crate::product_spec_parsing::*`), the `parses_multiple_workstreams_*` + `parses_bold_workstreams_*` + `parses_generic_workstreams_*` cluster (references `crate::product_spec_parsing::*`), and the cross-stage integration tests like `structured_approval_rows_are_the_only_gate_source`. Each test is relocated by name with the assertion logic unchanged.
   - **Stays in `main.rs::tests`**: a ~50-line dispatch-level smoke (CLI byte-equivalent + envelope JSON shape) and a 2-line wiring `#[cfg(test)] mod tests_integration;` declaration (the `#[cfg(test)]` module declaration is the only `mod` line that main.rs keeps post-Slice-4).

After Slice 4, `main.rs` lands at ~600 lines of orchestration + ~50 lines of dispatch tests + ~50 lines of `mod <name>;` declarations (15 carved modules + tests_integration) + ~30 lines of `Cli`/`Commands` wiring + ~100 lines of shared type definitions + ~200 lines of explanatory comments documenting where each carve moved. AC1 closure: < 3,000 lines with `main.rs` containing only orchestration + shared types + inline docs.

**Out of scope (stays in `main.rs` or moves to its own task):**

- The `Cli` struct + `Commands` enum + `main()` + the top-level `match` dispatch — orchestration by definition.
- `StageArgs`, `Envelope`, `Task`, `TaskComment`, `TaskApproval`, `ActiveWorkflowHandoff`, `LobsterState`, `ProductSpecRef`, `Workstream`, `ArchiveDoneTaskSpecsSweepArgs`, `ReconcileBrainSpecApprovalsArgs`, `AnalyticsArgs`, `AnalyticsAction`, `ArchiveSpecPlan`, `ArchiveOutcome`, `ArchiveSkipReason`, `BrainSpecApprovalPlan`, `ChatApprovalMovePlan` — shared types consumed across multiple modules; moving them would fragment imports without saving lines. Several already became `pub(crate)` during the W37 carve; W38 keeps them in `main.rs` and does not move them further.
- The `WORKFLOW` / `CODE_TASK_WORKFLOW` / `STATE_TAG` / `STATUS_ORDER` consts — shared constants consumed across multiple modules.
- The `mod tests` block in `main.rs` post-Slice-4 — limited to the dispatch-level smoke (~50 lines) + the `#[cfg(test)] mod tests_integration;` declaration. The cross-cutting integration coverage moves to `tests_integration.rs`.
- `Default for LobsterState` impl — stays in `main.rs` because `LobsterState` stays in `main.rs`.

## Visibility rules (apply across all four slices)

- All extracted functions become `pub(crate)` so `main.rs` (and any future sibling consumer) can call them.
- All extracted types stay in their extracted module (don't re-export from `main.rs`).
- The `impl <Type> for <Trait>` blocks move with their type.
- The `#[cfg(test)] mod tests` block in each extracted module declares its tests using `crate::<module>::<item>` paths (no `use super::*;` for items not local to the test module) — same pattern W37 carve PRs established.

## Test placement (Slice 4 specifics)

The 144 `#[test]` functions in the inline `mod tests` block split along the same boundaries as the production code:

| Test cluster | Count (est.) | Target |
|---|---|---|
| `archive_task_spec_for_done_task_*` (8 tests) | 8 | `brain_spec_reconcile::tests` |
| `rewrite_spec_line_in_description_*` (1 test) | 1 | `brain_spec_reconcile::tests` |
| `percent_encode_assignee_*` (1 test) | 1 | `brain_spec_reconcile::tests` (or stay; it's a tiny pure-helper test) |
| `plan_task_spec_archive_*` / `resolve_archive_plan_*` / `reconciliation_spec_link_*` / `plan_brain_spec_approval_*` (3-5 tests, est.) | 4 | `brain_spec_reconcile::tests` |
| `format_*` (format_seconds, format_evidence, 2-3 tests) | 3 | `analytics_replay::tests` |
| `print_replay_*` (1-2 tests) | 2 | `analytics_replay::tests` |
| `load_dotenv_token_reads_matching_key_and_none_when_absent` (1 test) | 1 | `analytics_replay::tests` (single-test env-mutation fixture stays whole) |
| `pr_body_*` / `load_task_*` / `gh_command_*` (3-5 tests) | 4 | `cli_utils::tests` |
| `routing_*` (10 tests) | 10 | `tests_integration::tests` |
| `workflow_for_task_*` (4 tests) | 4 | `tests_integration::tests` |
| `parses_product_spec_link` / `detects_missing_product_spec` / `parses_only_bold_spec_line_from_description` (3 tests) | 3 | `tests_integration::tests` (cross-cutting spec parsing) |
| `task_with_waiver_comment` / `tech_design_waived_*` (6 tests) | 6 | `tests_integration::tests` |
| `spec_check_skips_legacy_mutation_*` / `spec_check_keeps_legacy_mutation_*` / `spec_gate_accepts_structured_approval_row` (3 tests) | 3 | `tests_integration::tests` (cross-stage spec gate) |
| `resolves_product_specs_relative_to_workspace_root` / `validates_existing_product_spec_under_workspace_root` / `computes_deterministic_compact_spec_checksum` (3 tests) | 3 | `tests_integration::tests` |
| `legacy_approval_marker_is_not_an_acceptance_criterion` / `spec_checksum_guard_*` (3 tests) | 3 | `tests_integration::tests` |
| `spec_approval_transition_stores_current_checksum` (1 test) | 1 | `tests_integration::tests` |
| `implementer_capacity_*` (8 tests) | 8 | `tests_integration::tests` (references lobster_state) |
| `parses_multiple_workstreams` / `parses_bold_workstreams_*` / `parses_generic_workstreams_*` / `spec_failures_do_not_hide_valid_bold_workstreams` (8 tests) | 8 | `tests_integration::tests` |
| `extracts_multiple_implementer_pr_urls` / `latest_implementer_pr_urls_*` / `active_implementer_pr_urls_*` (8 tests) | 8 | `tests_integration::tests` |
| `linked_approval_task` / `checked_open_task_spec_plans_structured_spec_grant` / cross-cutting task-with-spec tests (~20 tests) | 20 | `tests_integration::tests` |
| Dispatch-level smoke tests | 2-3 | `main.rs::tests` (stays) |
| **Total** | **~114** | (the remaining ~30 tests are small fixture helpers + `#[test]` functions that split across the boundaries above with one or two per module) |

`tests_integration.rs` will be a `#[cfg(test)]` module — it does NOT add a new binary target, only an in-binary test surface that `cargo test --bins` already covers.

## Data model / API contract changes

None. This is a pure file-move refactor: no public surface change, no CLI flag change, no output path change, no exit-code change.

## Workflow / cron / skill changes

None. No `.openclaw/` boundary touched.

## `.openclaw` boundary notes

None.

## Ownership boundary check

- **Natural source of truth:** the Rust module system. Each cluster becomes a sibling module under `agents/workflows/feature-task/src/`, with a `mod <name>;` declaration in `main.rs` and `pub(crate)` for items consumed cross-module.
- **No interim shim chosen:** the W37 design explicitly kept orchestration glue in `main.rs` (see the `pr_gates.rs` doc comment noting the orchestrating constructors "stay in `main.rs` per the W37 design"). W38 reverses that decision for `analytics_replay`, `cli_utils`, and `brain_spec_reconcile` — the orchestrating glue belongs with its cluster, not in `main.rs`. Reversing the W37 call does not invalidate the W37 call: the W37 carve PRs (#615, #621, #623, #624, #625, #626, #632, #636, #639, #640, #641) all landed and stayed green.
- **Why now and not later:** the audit's A3 line-count trajectory (8,658 → 7,796 → 8,090 → 5,686 → 4,592) shows the file has reached a stable plateau after the W37 carve. The next 1,592 lines are the explicit clusters the W37 tech design flagged as out-of-scope for the first tranche; this task's trajectory picks them up.
- **Slice 4 (test-block split) justification:** the inline `mod tests` block at 68% of the post-PR-J file is the dominant headwind. Splitting it across per-module test blocks (W37 carve precedent) + a new `tests_integration.rs` sibling preserves every test's assertion logic while removing ~3,000 lines from `main.rs`. The risk is low because every test relocation is mechanical (assertion body unchanged, only the owning module changes), but the surface is high because the diff touches ~144 test functions; per-PR review-surface minimization is the rationale for one-slice-per-PR.

## Implementation plan (per-slice)

### Slice 1 — `analytics_replay.rs`

1. Create `src/analytics_replay.rs` with the standard module header (`//!` doc comment listing the public surface, mirroring `ac_parsing.rs`'s style).
2. Move the six functions listed above into the new module, adjusting:
   - Visibility: `pub(crate)` on every extracted function.
   - Imports: `use crate::analytics::chrono_like_now_iso; use crate::api_client::handle_api_result; use crate::{Envelope, StageArgs, Task, LobsterState, AnalyticsArgs, Regex, anyhow, json, serde_json::Value};` (consolidate cross-module references).
3. Move the relevant `#[test]` bodies from `main.rs`'s `mod tests` into `analytics_replay.rs`'s own `#[cfg(test)] mod tests`.
4. Add `mod analytics_replay;` declaration at the top of `main.rs` (after the existing 15 `mod` lines; alphabetical order).
5. Update CLI dispatch in `main()`: `Commands::Analytics(args) => analytics_replay::analytics_replay(args)?` (was local `analytics_replay(args)?`).
6. Verify: `cargo test --manifest-path agents/workflows/feature-task/Cargo.toml` green; feature-task clippy CI job green; `feature-task analytics replay --task-id <uuid> --base-url <url>` byte-equivalent to pre-PR behavior.

### Slice 2 — `cli_utils.rs`

1. Create `src/cli_utils.rs` with the standard module header.
2. Move `pr_body`, `load_task`, `gh_command` into the new module, adjusting:
   - Visibility: `pub(crate)` on `pr_body` + `load_task`; `gh_command` stays module-private.
   - Imports: `use crate::{ac_parsing::*, brain_spec_lifecycle::*, pr_gates::*, task_approvals::*}; use crate::{api_client::*, product_spec_parsing::*};` (consolidate cross-module references).
3. Move the relevant `#[test]` bodies from `main.rs`'s `mod tests` into `cli_utils.rs`'s own `#[cfg(test)] mod tests`.
4. Add `mod cli_utils;` declaration at the top of `main.rs`.
5. Update CLI dispatch in `main()`: `Commands::LoadTask { base_url, task_id } => cli_utils::load_task(&base_url, &task_id)?`.
6. Verify: same gates as Slice 1; `feature-task load-task --base-url <url> --task-id <uuid>` byte-equivalent.

### Slice 3 — `brain_spec_reconcile.rs`

1. Create `src/brain_spec_reconcile.rs` with the standard module header.
2. Move the 19 items + 7 constants listed above into the new module, adjusting:
   - Visibility: `pub(crate)` on all extracted functions + enums + constants.
   - Imports: `use crate::{brain_spec_lifecycle::*, product_spec_parsing::*, api_client::*, task_approvals::*}; use crate::{Envelope, Task, LobsterState, StageArgs, ProductSpecRef, ...};`.
3. Move the relevant `#[test]` bodies from `main.rs`'s `mod tests` into `brain_spec_reconcile.rs`'s own `#[cfg(test)] mod tests`.
4. Add `mod brain_spec_reconcile;` declaration at the top of `main.rs`.
5. Update CLI dispatch in `main()`: `Commands::ReconcileBrainSpecApprovals(args) => brain_spec_reconcile::reconcile_brain_spec_approvals(args)?`.
6. Verify: same gates as Slice 1; `feature-task reconcile-brain-spec-approvals --base-url <url> --task-id <uuid>` byte-equivalent.

### Slice 4 — `tests_integration.rs` + `mod tests` split

1. Create `src/tests_integration.rs` with `#[cfg(test)] mod tests { ... }` hosting the cross-cutting tests listed in the test-placement table above.
2. Add `#[cfg(test)] mod tests_integration;` declaration at the top of `main.rs`.
3. Relocate ~114 `#[test]` bodies from `main.rs`'s `mod tests` into either `tests_integration::tests` or the per-module `tests` blocks (per Slice 1-3 + Slice 4 placement table).
4. Retain only the dispatch-level smoke tests (~2-3 `#[test]` bodies) in `main.rs::tests`.
5. Verify: `cargo test --manifest-path agents/workflows/feature-task/Cargo.toml` green; the relocated tests assert the same behavior; total `cargo test --bins` count is monotonically ≥ the pre-PR count (no tests deleted).

## Test plan

### Per-slice verification

- `cargo test --manifest-path agents/workflows/feature-task/Cargo.toml` — full test suite green; relocated tests pass in their new module location; total test count is monotonically ≥ pre-PR count.
- `cargo clippy --manifest-path agents/workflows/feature-task/Cargo.toml --all-targets -- -D warnings` — clippy clean (this is the canonical command the PR-gate requires PR bodies to cite).
- `cargo build --manifest-path agents/workflows/feature-task/Cargo.toml` — debug build green.
- `cargo fmt --check --manifest-path agents/workflows/feature-task/Cargo.toml` — fmt clean for the new module + the relocated tests.
- Manual smoke: run `agents/workflows/feature-task/target/debug/feature-task --help` and confirm the help output matches pre-PR byte-for-byte; run the per-slice CLI command (Slice 1: `analytics replay`; Slice 2: `load-task`; Slice 3: `reconcile-brain-spec-approvals`) and confirm byte-equivalent output to the pre-PR run.

### AC-by-AC verification matrix (across the full task trajectory)

| AC | First PR that satisfies it | Verification |
|---|---|---|
| **AC1**: `main.rs` < ~3,000 lines containing only orchestration | Slice 4 (final) | `wc -l agents/workflows/feature-task/src/main.rs`; file content review confirms only `Cli`/`Commands`/`main`/dispatch + shared types + dispatch smoke tests + explanatory comments remain |
| **AC2**: same CI gates green; lobster behavior unchanged | Slice 1 — demonstrates green; every subsequent slice re-confirms | `cargo test` + clippy CI job green per slice; CLI smoke run for each slice |
| **AC3**: `pub(crate)` re-exports consistent with the W37 first-tranche precedent; no public CLI/API surface change | Slice 1 — establishes the pattern; every subsequent slice follows it | Diff review of each new module's visibility markers; `feature-task --help` byte-comparison before/after the full task |
| **AC4**: audit ledger closure with `✅ [PR #<n>](...)` link | Slice 4 (final) | `git log origin/main -- docs/repo-audits/2026-W37.md` shows the ledger line edited in the same commit as the final slice PR |
| **AC5**: trajectory continuity (W37 first tranche + W38+ second tranche cited in each PR's description) | Slice 1 — establishes the pattern; every subsequent slice cites the cumulative trajectory | Per-PR review of the PR description body |

### User-visible / app-flow coverage

This task touches no user-visible surface. The lobster is a server-side Rust binary whose CLI output and exit codes are the only observable behavior. Per the convention in `WORKFLOW.md`, an E2E test is not applicable; the verification falls to:
- Per-slice `cargo test` runs covering all relocated tests in their new module location
- Manual CLI smoke run after each slice's PR lands

## Risks and open questions

- **Risk:** Slice 4 (test-block split) moves ~114 `#[test]` functions across module boundaries. The risk is low because every test relocation is mechanical (assertion body unchanged, only the owning module changes), but the diff surface is high. Per-PR review-surface minimization is the rationale for Slice 4 as its own PR.
- **Risk:** The `tests_integration::tests` block hosts cross-cutting tests that import from many modules. If any imported symbol changes visibility between slice PRs, the test fails to compile. Mitigation: declare `tests_integration` as a `#[cfg(test)]` module (not a separate binary target), so the build system catches the issue immediately; also: ship Slices 1-3 first (which promote the relevant items to `pub(crate)`) before Slice 4 (which depends on those visibility decisions being stable).
- **Open question:** Should `ArchiveSpecPlan`, `ArchiveOutcome`, `ArchiveSkipReason`, `ChatApprovalMovePlan` move with Slice 3 (`brain_spec_reconcile.rs`) or stay in `brain_spec_lifecycle.rs`? The split in this design is: `brain_spec_lifecycle.rs` owns post-decision archive outcomes + spec-resync mechanics (PR-E #626); `brain_spec_reconcile.rs` owns pre-decision planning enums + reconciliation + lifecycle move planning. The four enums are pre-decision planning data, so they move with Slice 3. If Quinn prefers the alternative split, Slice 3's scope can swap those enums for the corresponding `brain_spec_lifecycle::*` consumers, but the line count + visibility rules are unchanged.
- **Open question:** Should `lobster_state::tests` get a small subset of the cross-cutting tests that exercise `IMPLEMENTER_DOING_CAPACITY` and the `workflow_for_task` helpers (currently in the `mod tests` block)? Per the W37 carve precedent, the predicate-test pair (e.g. `is_actionable_for`) tests live in `lobster_state::tests`; the cross-cutting tests (e.g. `implementer_capacity_allows_*`) live in `tests_integration::tests` because they reference `lobster_state::*` + `product_spec_parsing::*` + `task_approvals::*`. This design follows the precedent. Open for review at Slice 4 PR-time.

## Future slices (planned; not in this task)

None. After Slice 4, AC1 (< 3,000 lines) closes; AC4 (audit-ledger closure) closes when the final Slice 4 PR's commit edits `docs/repo-audits/2026-W37.md` A3 line with `✅ [PR #<n>](...)`. The audit-ledger PR #642 already links the W37 A3 finding to this task; AC4 closure is the final PR's commit.

If the W39+ audit continues to flag the `main.rs` orchestration surface (e.g. because the `Cli`/`Commands` dispatch itself becomes too large as new subcommands are added), a third tranche would propose splitting the dispatch into per-subcommand modules. Out of scope for this task's trajectory.
