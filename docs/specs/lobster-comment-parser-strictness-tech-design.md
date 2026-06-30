---
status: draft
task_id: 44f5ed65-5a45-4df8-95d7-8c874feeed12
product_spec: brain/bookmarks/specs/feature-factory-v2-2026-06-04.md
shipped_pr: null
shipped_date: null
---

# Lobster Comment Parser Strictness — Tech Design

## Links

- Task: `44f5ed65-5a45-4df8-95d7-8c874feeed12` (`🔧 🐛 Relax lobster comment-parser strictness for tagged values`)
- Product spec: `brain/bookmarks/specs/feature-factory-v2-2026-06-04.md` (the feature-factory v2 spec is the parent contract; the lobster's tag parsing behaviour is its implementation detail)
- Task API detail: `http://localhost:4001/api/v1/tasks/44f5ed65-5a45-4df8-95d7-8c874feeed12`

## Scope

- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-44f5ed65-parser-strictness`
- Worktree: `~/workspaces/rowan/sindustries`
- Primary code surface: `agents/workflows/feature-task/src/main.rs` (single function + tests)

No `.openclaw` runtime change. No API/data/UI surface change. Pure parser relaxation in the lobster's `tech_design_approved` check.

## Product Summary

`tech_design_approved` currently does an exact `eq_ignore_ascii_case("true")` comparison against the trimmed value of every `[tech-design-approved]` comment. That rejects any comment with trailing text — e.g. `[tech-design-approved] true — Approved by Tom 2026-06-30` — even though the leading `true` is unambiguous. We've hit this twice (tasks `5dbf2967`, `6e70deb8`); each time the workaround was a clean re-post from the approver.

The fix relaxes the check to `starts_with_ignore_ascii_case("true")` so leading-token equality is enough. Reject cases (missing value, explicit `false`, unrelated tokens) stay rejected.

## Implementation Plan

### 1. Update `tech_design_approved` in `agents/workflows/feature-task/src/main.rs`

```rust
fn tech_design_approved(task: &Task) -> bool {
    tagged_values(task, "[tech-design-approved]")
        .into_iter()
        .any(|v| {
            // Match a leading "true" token, case-insensitive, ignoring leading whitespace.
            // Rationale text after the token is allowed and ignored.
            let trimmed = v.trim_start();
            let token = trimmed.split_whitespace().next().unwrap_or("");
            token.eq_ignore_ascii_case("true")
        })
}
```

This is equivalent to `starts_with_ignore_ascii_case("true")` but uses whitespace splitting so trailing punctuation/em-dash attached directly to the token doesn't break it. The implementation matches what humans naturally write after `[tech-design-approved] true`.

The function is the only `tagged_values`-based site that required exact-equality semantics, so this change is localised.

### 2. Tests

Add the following tests in the existing `mod tests`:

- `tech_design_approved_accepts_rationale_after_true`
- `tech_design_approved_accepts_uppercase_true`
- `tech_design_approved_accepts_leading_whitespace`
- `tech_design_approved_rejects_false`
- `tech_design_approved_rejects_missing_value`
- `tech_design_approved_rejects_unrelated_token`

Each test builds a `Task` with a single relevant comment and calls `tech_design_approved` directly.

### 3. Documentation

No spec amendment needed — factory v2 already documents `[tech-design-approved]` as a marker, the relaxation is implementation-level. The PR template / workflow docs don't need updates because the comment format was never strictly defined as `[tech-design-approved] true` with nothing else; humans were already writing `[tech-design-approved] true — ...` and only the parser rejected it.

## Test Plan

- `cargo test --manifest-path agents/workflows/feature-task/Cargo.toml`
  - all existing 42 tests still pass (relaxation is a superset of strictness)
  - 6 new tests pass
- Run the lobster on task `44f5ed65` after the PR is merged to confirm the workflow can close out using a single `[tech-design-approved] true — rationale` comment.

## Open Questions and Risks

- None blocking. The relaxation is local and the test coverage is symmetric (accept + reject). If reviewers prefer `starts_with("true")` to the `split_whitespace().next()` form, either is acceptable; the latter is more permissive about punctuation.
- Behaviour change is technically a parser relaxation, but it's a no-op for the existing test suite (which doesn't depend on the strictness) so risk is bounded.

## Task description note

This task description was created without `**Spec:**` and `**Workstreams**` fields. Rowan patched the description to add those fields so the lobster's `spec_check` stage can validate the workflow. The bug itself is not a feature; the spec reference points to `feature-factory-v2-2026-06-04.md` as the parent contract because the lobster's tag semantics are governed there.