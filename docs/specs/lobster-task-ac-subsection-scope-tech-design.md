# Tech Design — Scope lobster `task_ac_vs_open_pr_failures` by `### Task <id>` subsection

**Task:** `0fdb4bfe-e7e7-48a8-b188-ba0135b736bc`
**Branch:** `fix/lobster-task-ac-subsection-scope` (from `origin/main` @ `c339203`)
**Authored:** 2026-07-06 NZST
**Reviewers:** Quinn

## Background

`task_ac_vs_open_pr_failures` runs at the `doing → acceptance` gate. It compares a task's ACs (parsed from the task description) against the AC section of the latest open PR body and reports any AC that is missing, has altered text, or lacks a valid evidence annotation.

The function builds a flat `HashMap<String, (String, Option<Evidence>)>` keyed by AC label (`AC1`, `AC2`, ...), not scoped by `### Task <id>` subsection.

`extract_ac_section` (PR #183) preserves `### Task …` subheadings inside the H2 AC section. So multi-task PR bodies — one `## Acceptance Criteria` containing several `### Task …` subsections — share a single key namespace. Two tasks' ACs collide on `AC1`/`AC2`/... in the HashMap; whichever subsection comes last in markdown wins; the earlier task's ACs are silently overwritten.

Quinn confirmed the regression against `target/release/feature-task` on PR #185 (tasks 513b3b02 Pulse shell + e2e647b1 Flow metrics dashboard). 513b3b02's ACs were overwritten by e2e647b1's, so the gate reported five "AC1 text altered — task: `<513b3b02 text>`, PR: `<e2e647b1 text>`" failures on 513b3b02.

## Goal

Scope the per-AC comparison to the matching `### Task <task_id>` subsection. Keep `verify_pr_acs_failures` unchanged (evidence format is checked per-line and does not collide on labels). Preserve today's behavior for single-task PR bodies.

## Design

### Signature change

`task_ac_vs_open_pr_failures` gains the current task's `id` as a new first parameter:

```rust
fn task_ac_vs_open_pr_failures(
    task_id: &str,
    task_acs: &[(String, String)],
    body: &str,
    pr_url: &str,
) -> Vec<String>
```

Caller in `verify_delivery` (line 331) becomes:

```rust
for ac_failure in task_ac_vs_open_pr_failures(&env.task.id, &task_acs, &body, url) {
    failures.push(format!("PR {url} — {ac_failure}"));
}
```

### Section walker

Replace the single `re.captures_iter(section)` with a line-by-line pass over `extract_ac_section(body)`:

1. Two regexes:
   - `subsection_re`: `r"(?m)^\s*#{3,}\s+Task\s+(\S+)"` — matches `### Task <id>`, `#### Task <id>`, etc. Capture group 1 is the bare task identifier (first whitespace-delimited token after `Task`).
   - `ac_re`: same regex as today — `r"(?m)^\s*-\s*\[([xX ])\]\s+(AC\d+):\s*(.+)$"`.
2. State: `current_sub_id: Option<String>`, `saw_any_subsection: bool`, `matching_section: bool`, `pr_ac_map: HashMap<String, (String, Option<Evidence>)>`.
3. Loop:
   - On a line matching `subsection_re`, set `current_sub_id = Some(cap[1])`. Update `matching_section = current_sub_id == task_id`. Set `saw_any_subsection = true`.
   - If `saw_any_subsection && !matching_section`, skip the line (it's an AC in a sibling task's subsection).
   - Otherwise, if the line matches `ac_re`, insert `(label, (text, evidence))` into `pr_ac_map`. Same `parse_evidence` + `strip_trailing_evidence` calls as today.
4. If `saw_any_subsection` is `false` (no `### Task <id>` headings anywhere), every AC line is in the implicit single-task section — same as today's behavior.

### Failure messages

Identical wording to today. If the matching subsection is empty (or missing), `pr_ac_map` is empty and the failure loop reports one `ACn missing from open PR <url>` per task AC. No new failure class is needed for the "subsection absent" case — the existing message is informative enough.

### `verify_pr_acs_failures` is unchanged

It operates on the whole section by design. Evidence format checking does not depend on which task an AC belongs to: every checked `- [x] ACn: ...` line in the PR body must carry one of the current evidence formats documented in `agents/skills/dev/pr-open/SKILL.md`. The function continues to scan the whole section.

Note: this tech design predates removal of `file:` evidence. Do not treat old examples in shipped tech designs as the current process contract; `pr-open/SKILL.md` is canonical.

## Edge cases

| Input | Expected |
|-------|----------|
| Single-task PR body, all ACs match | empty failures (regression) |
| Single-task PR body, AC text altered | one `AC1 text altered — task: ..., PR: ...` (regression) |
| Two-task PR body, each task's ACs match its own subsection | empty failures for both call sites |
| Two-task PR body, first task referenced again as second caller | first call still clear (its subsection's text matches); second call… |
| Two-task PR body, no `### Task <id>` heading | falls back to whole-section behavior (preserves today) |
| Two-task PR body, no matching subsection for current task | all task ACs reported missing from PR |
| Body with `### Task <id>` followed by subsection ACs | ACs collected only for matching `<id>` |
| Body with `#### Task <id>` (deep heading) | subsection regex `#{3,}` accepts; behavior same |

## Tests

Eight total cases (4 existing + 4 new). Test names follow the existing convention.

Existing tests (require adding `task_id` as first argument):

1. `task_ac_vs_open_pr_passes_when_all_acs_match_with_evidence` — single-task happy path. Pass `task_id = "alpha"` (single-task body has no `### Task` heading, so falls back to whole-section).
2. `task_ac_vs_open_pr_blocks_on_text_mismatch` — single-task text mismatch.
3. `task_ac_vs_open_pr_blocks_on_missing_ac` — single-task missing AC.
4. `task_ac_vs_open_pr_blocks_on_missing_evidence` — single-task missing evidence.

New tests:

5. `task_ac_vs_open_pr_handles_multi_task_body` — regression fixture: two `### Task <id>` subsections with overlapping `AC1`/`AC2`/... labels. Each task gets its own subsection's text. Two calls (one per task id), both pass.
6. `task_ac_vs_open_pr_falls_back_when_no_subsection_heading` — body with `## Acceptance Criteria` but no `### Task` subheadings. Pass `task_id = "anything"` — every AC line is consumed as if single-task.
7. `task_ac_vs_open_pr_reports_missing_when_no_matching_subsection` — body has `### Task other_id` headings, current `task_id` has none. Reports N missing-AC failures.
8. `task_ac_vs_open_pr_isolates_text_per_subsection` — body has two subsections with intentionally different `AC1` texts; calling with `task_id` of subsection A matches subsection A's text, not subsection B's.

## Out of scope

- Changing `extract_ac_section`. Its current behavior of preserving `### Task …` subheadings inside the H2 AC section is correct and is the foundation this fix builds on.
- Changing `verify_pr_acs_failures` or the existing `evidence_format` rules.
- Docstring / comment updates in `extract_ac_section` (its existing comment already documents the multi-task convention).
- Auto-creating tasks from PR body subsections or any cross-task derivation logic.

## Files

| Path | Change |
|------|--------|
| `agents/workflows/feature-task/src/main.rs` | `task_ac_vs_open_pr_failures` signature + body; update 1 production call site in `verify_delivery`; update 4 existing tests; add 4 new tests |
| `agents/skills/dev/pr-open/SKILL.md` | One paragraph in the "Acceptance Criteria" section: multi-task convention + minimal example |
| `docs/specs/lobster-task-ac-subsection-scope-tech-design.md` | This file |

## Validation

- `cargo test --manifest-path agents/workflows/feature-task/Cargo.toml` — all 4 new + 4 updated tests pass; total suite increases from 49 to ~57 (4 added).
- `cargo build --release --manifest-path agents/workflows/feature-task/Cargo.toml` — clean.
- After merge: Quinn re-runs the lobster on tasks 513b3b02 and e2e647b1 with the new binary; both should clear the gate.

## Linked work

- PR #185 — combined 513b3b02 + e2e647b1 delivery; blocked at gate until this PR lands.
- PR #183 — made `extract_ac_section` level-aware; the regression trigger that surfaced this issue.
- PR #149 (and before it the in-crate parser work) — same evidence-format hardening arc.
