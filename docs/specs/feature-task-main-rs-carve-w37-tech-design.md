---
status: draft
task_id: 9b10c65a-0eb3-4ff2-92ca-d262e12c2e10
product_spec: n/a (refactor task from repo-audit-2026-W37, finding A3)
shipped_pr: null
shipped_date: null
---

# Feature-task `main.rs` — continue carving into focused modules (W37 A3)

## Links

- Product spec: n/a — task is from the weekly repo audit (`docs/repo-audits/2026-W37.md` finding A3). Goal: continue the W36 extraction trajectory (`ac_parsing.rs`, `analytics.rs`, `pr_gates.rs`, `test_resolution.rs`, `test_runners.rs`) and bring `agents/workflows/feature-task/src/main.rs` below ~3,000 lines.
- Tech design: `docs/specs/feature-task-main-rs-carve-w37-tech-design.md` (this file)
- Task: `9b10c65a-0eb3-4ff2-92ca-d262e12c2e10` — replaces the dead `d578e547` ledger pointer (TASK_NOT_FOUND as of 2026-09-09)
- Tasks API record: `http://localhost:4001/api/v1/tasks/9b10c65a-0eb3-4ff2-92ca-d262e12c2e10`
- Audit finding: `docs/repo-audits/2026-W37.md` finding **A3** (PR #585, merged 2026-09-09)
- Predecessor tech design: `docs/specs/feature-task-main-rs-split-tech-design.md` (W36 A3+A4, task `d578e547`, PRs #546 / #550 / #565). Three carve PRs (PR-A `pr_gates`, PR-B `test_resolution`, PR-C `test_runners`) plus the A4 `cargo_test_leaf_outcome` hardening already shipped.
- Sibling pattern in this crate: every extracted module uses `pub(crate)` for items consumed only inside the crate, owns its inline `#[cfg(test)]` block, declares `mod <name>;` at the top of `main.rs`, and ships a `//!` doc comment listing its public surface. `ac_parsing.rs`, `analytics.rs`, `pr_gates.rs`, `test_resolution.rs`, and `test_runners.rs` are the reference shapes.

## Problem statement

After the W36 carve, `agents/workflows/feature-task/src/main.rs` is **8,090 lines** with **160 top-level items** (down from 8,602 / 205). Five sibling modules exist. The W37 audit A3 keeps this on the medium-severity list because the file is still large enough to be a review/merge bottleneck and a single-PR diff budget hazard.

Per the W36 design's "Out of scope" section, the following clusters were deliberately left in `main.rs` and are the natural next tranche:

- PR-gate orchestrating constructors (`verify_delivery_review_failure`, `post_merge_pr_failure`, `feedback_review_failure`, `is_latest_pr_url`, `pr_number`) — kept in `main.rs` by W36 because they "carry workflow-state orchestration logic that does not belong in a leaf helpers module," but their consumers (`verify_delivery`, `feedback_aggregate`, `post_merge`) are themselves stage handlers with clean module boundaries, so the orchestration argument has been overtaken by the line-count budget
- Brain/spec reconciliation + lifecycle (`BRAIN_DIR` block, `BrainSpecApprovalPlan`, `reconciliation_spec_link`, `plan_brain_spec_approval`, `feature_policy_requires_spec`, `grant_reconciled_spec_approval`, `reconcile_brain_spec_approvals`, the `Archive*`/`ChatApprovalMove*` cluster, `archive_done_task_spec`, `archive_done_task_specs_sweep`, `apply_archive_outcome`, `move_approved_chat_spec_if_needed`, `block_on_spec_drift_fluid`, `publish_spec_approval_handoff`)
- Product spec + AC parsing + checksum (`product_spec`, `parse_product_spec_ref`, `extract_spec_path_from_line`, `strip_trailing_annotation`, `brain_spec_approved_by_tom`, `spec_resync_signal_present`, `ResyncRecord` + impl, `parse_resync_record`, `latest_resync_record`, `latest_resync_record_matches_drift`, `drift_episode_fingerprint`, `task_is_open`, `resolve_product_spec_path`, `workspace_root`, `acceptance_criteria_*`, `canonical_json_*`, `spec_checksum_failures`, `workstreams` + parsers, `tagged_values`, `tech_design_url`, `tech_design_approved_structured`, `tech_design_waived`, `implementer_pr_urls`, `latest_implementer_pr_urls`, `implementer_active_pr_urls_with`, `inspect_pr`)
- API client (`api_get`, `api_get_task`, `authenticated_api_patch_request`, `api_patch`, `api_delete`, `lobster_service_token`, `add_comment`, `handle_api_result`, `api_status_error`, `spec_checksum_mismatch_message`, `output`, `read_envelope`, `write_state`, the `ApiStatusError` struct + `Display` + `Error` impls)
- Lobster state + capacity (`parse_lobster_state`, `workflow_for_task`, `status_rank`, `is_past`, `list_all_active_tasks`, `task_implementer`, `IMPLEMENTER_DOING_CAPACITY`, `is_actionable_for`, `implementer_doing_capacity_failures`, `comment_text`, `spec_failures`, `missing_spec_checksum_failures`, `spec_is_approved`)
- Git worktree helpers (`parse_git_worktree_porcelain`, `task_id_prefix`, `select_matching_task_worktrees`, `remove_worktrees_best_effort`, `cleanup_task_worktree_for_task`, `format_worktree_cleanup_summary`, `WorktreeEntry` + `WorktreeCleanupOutcome` + `WorktreeCleanupResult`)
- `verify_delivery`, `feedback_aggregate`, `post_merge` stage handlers and their direct helpers (currently split between the orchestrating constructors and `task_approval_granted` + the structured-approval predicates)
- `spec_check`, `ready_checks`, `code_task_*` stage handlers + their helpers (`block_with_manual_block`, `manual_block_failures`, `structured_spec_reapproval_after_auto_revoke`)

Each cluster is a self-contained Rust module with one or two clearly-defined consumers; every helper has a single testable purpose; none has a network or filesystem boundary the rest of the crate does not already share. The W36 design left them in `main.rs` to keep PR review diffs small. The W37 design picks that trade-off back up: each carve ships as its own PR (one stage at a time, per the audit's `Implementation note`), and the trajectory reaches AC1 (<3,000 lines) inside this task's lifetime.

## Scope

**In scope (this task's multi-PR trajectory — ordered by cleanest stage/domain boundary first):**

1. **PR-A — `verify_delivery.rs`** (this PR's slice; ~290 lines moved out). Extract the `verify_delivery` stage handler, the `code_task_verify_delivery` code-task variant, and the verify-delivery-specific helpers (`verify_delivery_review_failure`, `pr_number`, `is_latest_pr_url`, `qa_agent_verified_failures`). The cross-stage helpers (`feedback_review_failure`, `post_merge_pr_failure`, `task_approval_granted`, `accepted_structured*`, `qa_agent_verified`, `spec_check_should_skip_legacy_mutation`) stay in `main.rs` for this slice — they will move with their respective stage or with the `task_approvals` carve.
2. **PR-B — `feedback_aggregate.rs`** (~110 lines). Stage handler + `feedback_review_failure`. Calls into `crate::verify_delivery` for the URL helpers that already moved in PR-A.
3. **PR-C — `post_merge.rs`** (~250 lines). Stage handler + `run_post_merge_worktree_cleanup` + `post_merge_pr_failure` + the attention-owner reconciliation cluster (`workflow_attention_owner`, `ash_was_last_commenter`, `managed_owner_reason_satisfied`, `reconciled_attention_owners`, `reconcile_workflow_attention`, `workflow_handoff`, `transition_or_block`).
4. **PR-D — `task_approvals.rs`** (~110 lines). Cross-stage structured-approval helpers (`task_approval_granted`, `accepted_structured`, `accepted_structured_failures`, `qa_agent_verified`, `qa_agent_verified_failures`, `spec_check_should_skip_legacy_mutation`). After this lands, `verify_delivery.rs` and `feedback_aggregate.rs` and `post_merge.rs` import from `crate::task_approvals::*` instead of `crate::main::*`.
5. **PR-E — `brain_spec_lifecycle.rs`** (~820 lines). Brain-spec reconciliation + the archive/chat-approval lifecycle + `block_on_spec_drift_fluid` + `publish_spec_approval_handoff` + `block_with_manual_block` + `manual_block_failures` + `structured_spec_reapproval_after_auto_revoke`. The biggest single slice; carries its own `#[cfg(test)]` block.
6. **PR-F — `product_spec_parsing.rs`** (~620 lines). `product_spec` + parsers + `ResyncRecord` + `acceptance_criteria_*` + `canonical_json_*` + `workstreams` + parsers + `tagged_values` + `tech_design_url/_approved_structured/_waived` + `implementer_pr_urls` family + `inspect_pr`. The `pr_gates::ReviewState` import moves here (used by `inspect_pr`).
7. **PR-G — `api_client.rs`** (~210 lines). `ApiStatusError` + `output` + `read_envelope` + the `api_get` / `api_get_task` / `api_patch` / `api_delete` / `authenticated_api_patch_request` / `lobster_service_token` / `add_comment` / `handle_api_result` / `spec_checksum_mismatch_message` cluster.
8. **PR-H — `git_worktree.rs`** (~190 lines). `WorktreeEntry` + `WorktreeCleanupOutcome` + `WorktreeCleanupResult` + `parse_git_worktree_porcelain` + `task_id_prefix` + `select_matching_task_worktrees` + `remove_worktrees_best_effort` + `cleanup_task_worktree_for_task` + `format_worktree_cleanup_summary`.
9. **PR-I — `lobster_state.rs`** (~145 lines). `parse_lobster_state` + `workflow_for_task` + `status_rank` + `is_past` + `list_all_active_tasks` + `task_implementer` + `IMPLEMENTER_DOING_CAPACITY` + `is_actionable_for` + `implementer_doing_capacity_failures` + `comment_text` + `spec_failures` + `missing_spec_checksum_failures` + `spec_is_approved`. Plus `write_state` (moves here from PR-G scope if the cleaner split places `write_state` with state parsing rather than with the HTTP client — TBD at PR-G time).
10. **PR-J — `spec_check_ready.rs`** (~280 lines). `spec_check` + `ready_checks` + `code_task_tech_design_check` + `code_task_ready_checks` stage handlers, each with their direct helpers. Tightly cross-references `task_approvals` (PR-D), `brain_spec_lifecycle` (PR-E), and `product_spec_parsing` (PR-F), so this lands after all three.

After PR-J, `main.rs` lands at ~5,100 lines. AC1's <3,000-line target requires a second-pass tranche (a `code_task_*` consolidation + `pr_body` consolidation + a `load_task`/`format_*`/`print_*` formatting cluster). That second tranche is out of scope for this task's trajectory and will be proposed in W38+ if the audit continues to flag it.

**Out of scope (stays in `main.rs` even after PR-J; or moves to its own task):**

- `Cli` struct + `Commands` enum + `main()` + the top-level `match` dispatch — orchestration by definition
- `StageArgs` + `Envelope` + `Task` + `TaskComment` + `TaskApproval` + `ActiveWorkflowHandoff` + `LobsterState` + `ProductSpecRef` + `Workstream` + the `WORKFLOW` / `CODE_TASK_WORKFLOW` / `STATE_TAG` / `STATUS_ORDER` consts — shared types consumed across multiple modules; moving them would fragment imports without saving lines
- `pr_body` (line 486) — 13-line helper, called from `load_task` and `verify_delivery`; not worth its own module
- The `mod tests { ... }` block at line 4264 — `#[cfg(test)] mod tests` stays at the bottom of `main.rs` and references extracted modules via `crate::<module>::*` paths (same pattern W36 carve PRs established)

## PR-A scope (this PR — first slice)

### Module declaration

Add at the top of `main.rs` alongside the existing sibling declarations:

```rust
mod verify_delivery;
```

### What moves

From `src/main.rs` to `src/verify_delivery.rs`:

- `fn verify_delivery(args: StageArgs) -> Result<Envelope>` (current line 790)
- `fn code_task_verify_delivery(args: StageArgs) -> Result<Envelope>` (current line 783)
- `fn verify_delivery_review_failure(url: &str, review: pr_gates::ReviewState) -> Option<String>` (current line 1098)
- `fn pr_number(url: &str) -> u64` (current line 1125)
- `fn is_latest_pr_url(candidate: &str, latest_pr_urls: &[String]) -> bool` (current line 1142)
- `fn qa_agent_verified_failures(task: &Task) -> Vec<String>` (current line 1198)

Estimated extracted size: ~290 lines including the inline `#[cfg(test)]` block currently at lines 5478–5530 (the `verify_delivery_review_failure`, `post_merge_pr_failure`, `pr_number`, `is_latest_pr_url` unit tests) — the post-merge-pr-failure tests stay in `main.rs` because the function stays; only the verify_delivery-cluster tests move.

### What stays in `main.rs` and why

- `feedback_review_failure` (line 1146) — only called from `feedback_aggregate` (line 1064); moves with PR-B
- `post_merge_pr_failure` (line 1112) — only called from `post_merge` (line 1513); moves with PR-C. It calls `pr_number` and `is_latest_pr_url` from its own body, which after PR-A is `crate::verify_delivery::pr_number` / `crate::verify_delivery::is_latest_pr_url` — this is the only cross-module dependency PR-A introduces into a still-`main.rs` function
- `task_approval_granted` (line 1156) — called from `accepted_structured`, `qa_agent_verified`, `spec_check_should_skip_legacy_mutation`, `spec_is_approved` (line 3750), and `tech_design_approved_structured` (line 4170); moves with PR-D
- `accepted_structured`, `accepted_structured_failures`, `qa_agent_verified`, `spec_check_should_skip_legacy_mutation` — cross-stage structured-approval predicates; move with PR-D

### Visibility rules

- All extracted functions become `pub(crate)` so `main.rs` (and any future sibling consumer) can call them
- All extracted types stay private (none currently exist in this slice — they're all free functions)
- The `pr_gates::ReviewState` import moves with `verify_delivery_review_failure`

### Test placement

The `#[cfg(test)]` block currently at lines 5478–5530 splits along the same boundary:

- **Moves to `src/verify_delivery.rs`:** the `verify_delivery_review_failure`, `pr_number`, `is_latest_pr_url` unit tests (lines 5478–5486 + the URL-parser tests at ~5518–5530). They become `crate::verify_delivery::verify_delivery_review_failure(...)` etc.
- **Stays in `src/main.rs`:** the `post_merge_pr_failure` tests at lines 5500–5505 and 5521–5529 (function stays in `main.rs` until PR-C).

The `mod tests { ... }` opening at line 4264 and everything after it stays in `main.rs`; only the relevant `#[test]` bodies move.

## Data model / API contract changes

None. This is a pure file-move refactor: no public surface change, no CLI flag change, no output path change, no exit-code change.

## Workflow / cron / skill changes

None. No `.openclaw/` boundary touched.

## `.openclaw` boundary notes

None.

## Ownership boundary check

- **Natural source of truth:** the Rust module system. Each cluster becomes a sibling module under `agents/workflows/feature-task/src/`, with a `mod <name>;` declaration in `main.rs` and `pub(crate)` for items consumed cross-module.
- **No interim shim chosen:** the W36 design explicitly considered keeping orchestration glue in `main.rs` (see the `pr_gates.rs` doc comment noting `verify_delivery_review_failure` etc. "stay in `main.rs` per the W36 design"). W37 reverses that decision — the W36 trade-off was review-surface minimization; W37's trade-off is line-count reduction with the same per-PR review-surface minimization (each carve ships as its own PR, so per-PR diff size is bounded). Reversing W36's call does not invalidate W36's call: W36's three carve PRs (#546, #550, #565) all landed and stayed green.
- **Why now and not later:** the audit's A3 line-count trajectory (8,658 → 7,796 → still 8,090 after the carve commits) shows the file is at a stable plateau and needs another tranche. PR-A is the smallest clean unit (one stage + its tightly-coupled helpers) and demonstrates the pattern for the remaining slices.

## Implementation plan (PR-A only)

1. Create `src/verify_delivery.rs` with the standard module header (`//!` doc comment listing the public surface, mirroring `ac_parsing.rs`'s style)
2. Move the six functions listed above into the new module, adjusting:
   - Visibility: `pub(crate)` on every extracted function
   - Imports: `use crate::pr_gates;` for `verify_delivery_review_failure`'s `ReviewState` parameter
   - Call sites in `main.rs`:
     - `verify_delivery` and `code_task_verify_delivery` are still called from `main.rs`'s top-level dispatch (line 790ish); update those callers to `crate::verify_delivery::verify_delivery(...)`
     - `post_merge_pr_failure` (stays in `main.rs` until PR-C) gains `crate::verify_delivery::pr_number(...)` and `crate::verify_delivery::is_latest_pr_url(...)` calls at its existing call sites
3. Move the relevant `#[test]` bodies from `main.rs`'s `mod tests` into `verify_delivery.rs`'s own `#[cfg(test)] mod tests`
4. Add `mod verify_delivery;` declaration at the top of `main.rs` (after the existing five `mod` lines)
5. Verify: `cargo test --manifest-path agents/workflows/feature-task/Cargo.toml` green; feature-task clippy CI job green; no behavior change observable from the CLI

## Test plan

### PR-A verification

- `cargo test --manifest-path agents/workflows/feature-task/Cargo.toml` — full test suite green
- `cargo clippy --manifest-path agents/workflows/feature-task/Cargo.toml --all-targets -- -D warnings` — clippy clean (this is the canonical command the PR-gate requires PR bodies to cite)
- `cargo build --manifest-path agents/workflows/feature-task/Cargo.toml` — debug build green
- Manual smoke: build the binary, run `agents/workflows/feature-task/target/debug/feature-task --help` and confirm the help output matches pre-PR-A byte-for-byte

### AC-by-AC verification matrix (across the full task trajectory)

| AC | First PR that satisfies it | Verification |
|---|---|---|
| **AC1**: `main.rs` < ~3,000 lines containing only orchestration | PR-J + a W38 second-tranche proposal | `wc -l agents/workflows/feature-task/src/main.rs`; file content review confirms only `Cli`/`Commands`/`main`/dispatch + shared types remain |
| **AC2**: same CI gates green; lobster behavior unchanged | PR-A (this PR) — demonstrates green; every subsequent PR re-confirms | `cargo test` + clippy CI job green per PR; CLI smoke run for first and last PR |
| **AC3**: `pub(crate)` re-exports consistent with `ac_parsing.rs` / `analytics.rs` precedent; no public CLI/API change | PR-A (this PR) — establishes the pattern; every subsequent PR follows it | Diff review of each new module's visibility markers; `feature-task --help` byte-comparison before/after the full task |
| **AC4**: audit ledger closure with `✅ [PR #<n>]` link | Last carve PR (whichever PR closes AC1) | `git log origin/main -- docs/repo-audits/2026-W37.md` shows the ledger line edited in the same commit as the final carve PR |

### User-visible / app-flow coverage

This task touches no user-visible surface. The lobster is a server-side Rust binary whose CLI output and exit codes are the only observable behavior. Per the convention in `WORKFLOW.md`, an E2E test is not applicable; the verification falls to:
- Unit tests moved with each carve (extracted `#[cfg(test)]` blocks)
- Integration coverage: the existing in-binary `mod tests` end-to-end fixtures (the test suite as a whole)
- Manual: CLI smoke run after first and last carve PRs

## Risks and open questions

- **Risk:** `post_merge_pr_failure` (stays in `main.rs` until PR-C) calls `pr_number` and `is_latest_pr_url` which move to `crate::verify_delivery::*` in PR-A. The cross-module call adds one `use crate::verify_delivery;` line to `main.rs` (PR-A) and disappears in PR-C when `post_merge_pr_failure` moves with its callers. Low risk — mechanical and self-evident.
- **Risk:** The W36 design's `pr_gates.rs` doc comment notes `verify_delivery_review_failure` etc. "stay in `main.rs` per the W36 design" with the rationale "carry workflow-state orchestration logic." PR-A reverses that for `verify_delivery_review_failure` (the function moves) but `feedback_review_failure` and `post_merge_pr_failure` keep the W36 rationale until PR-B / PR-C move them with their respective stages. The W36 rationale is honored at the stage boundary — the orchestrating glue belongs with its stage, not in `pr_gates.rs`.
- **Open question:** Should the `task_approvals.rs` carve (PR-D) land before or after the `brain_spec_lifecycle.rs` carve (PR-E)? PR-D is small (~110 lines) and unblocks cleaner PR-C; PR-E is large (~820 lines) and benefits from PR-D landing first. Default ordering: D → E → F → G → H → I → J. Could swap D and C if PR-C's diff gets large.
- **Open question:** After PR-J, `main.rs` is ~5,100 lines, still above the AC1 <3,000 target. The remaining ~2,100 lines are mostly the `Cli`/`Commands`/`main` dispatch + the shared-type block + `pr_body` + the `mod tests` block. A second tranche (proposed for a separate task) is needed to close AC1. Out of scope for this task's trajectory.

## Future slices (planned; not in this PR)

PR-B: `feedback_aggregate.rs` — small, follows the same pattern. Will land after Quinn approves this tech design and PR-A is merged.

PR-C through PR-J: see the ordered list in the **Scope** section above. Each one is its own branch, its own PR, its own review.
