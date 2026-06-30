---
status: draft
task_id: 6e70deb8-9266-4198-92b4-3839eecf292d
product_spec: brain/bookmarks/specs/add-e2e-to-feature-factory-2026-06-29.md
shipped_pr: null
shipped_date: null
---

# Add E2E Evidence to Feature Factory — Tech Design

## Links

- Product spec: `brain/bookmarks/specs/add-e2e-to-feature-factory-2026-06-29.md`
- Task: `6e70deb8-9266-4198-92b4-3839eecf292d` (`🔧 Add e2e to feature factory`)
- Task API detail: `http://localhost:4001/api/v1/tasks/6e70deb8-9266-4198-92b4-3839eecf292d`

## Scope

- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-6e70deb8-pr-ac-evidence`
- Worktree: `~/workspaces/rowan/sindustries`
- Primary code surfaces:
  - `agents/workflows/feature-task/src/main.rs` — lobster Rust worker (this is where validation lives)
  - `agents/workflows/feature-task/fixtures/` — new fixture bodies for tests
  - `agents/skills/dev/pr-open/SKILL.md` — Rowan PR template guidance (add AC evidence guidance to PR body section)
  - `agents/definitions/rowan/HEARTBEAT.md` — already references feature factory v2; no edit required for this task

No `.openclaw` runtime change is required. No schema or API surface changes — this is purely a PR-body validation gate added to the lobster and an enablement comment in the PR-open skill.

## Product Summary

The feature factory v2 spec already states that every AC in a feature-task PR needs at least one E2E test unless explicitly marked not possible with a reason. Until now this was a human convention rather than a machine check. This task makes the lobster enforce it at the `doing → acceptance` gate.

A PR is treated as compliant when each AC line in the PR body provides either:

- A test reference, formatted as either `(testID: <id>)` or `(file: <path>:<line>)`, appended to the AC line; or
- An explicit annotation `not tested: <reason>` justifying why no test exists.

If any AC is checked (`- [x]`) and lacks evidence, the lobster blocks acceptance and posts a task comment listing every AC that needs evidence along with the expected formats.

The PR template (in `agents/skills/dev/pr-open/SKILL.md`) prompts Rowan to attach the annotation when opening a feature-task PR so evidence is captured at write time rather than caught later.

## PR Body Evidence Format

Each `- [x] AC<N>: <description>` line may be suffixed with one of:

```markdown
- [x] AC1: Title reflects stored value. (testID: 1234)
- [x] AC2: Board view supports sort by priority. (file: apps/tasks/src/BoardView.jsx:42)
- [x] AC3: Archived tasks render with reduced opacity. (not tested: visual treatment is a manual review step; design system token supplies the color)
```

Recognition rules:

- A single space followed by `(testID: <value>)`, `(file: <path>:<line>)`, or `(not tested: <text up to closing paren>)` is treated as evidence.
- A bare `not tested` without a reason is treated as missing evidence — the lobster surfaces it.
- Multi-PR tasks (where a task is split into workstreams across PRs): each PR's body only needs evidence for the ACs it claims. Uncovered ACs simply don't appear on that PR's Acceptance Criteria list. The lobster validates per-PR, not per-task, so each PR independently needs evidence for what it advertises.

The lobster matches the same `- [ ] AC<N>` style that the product spec / task description uses. It does not currently and will not require evidence on `- [ ]` (unchecked) lines because those represent ACs not yet claimed in the current PR.

## Implementation Plan

### 1. Add evidence parsing helpers in `agents/workflows/feature-task/src/main.rs`

- New function `parse_pr_evidence(body: &str) -> Vec<AcEvidence>` returning one record per `- [x]` AC line:
  - `ac_label: String` — captured `AC<number>` token
  - `description: String` — the AC body without evidence
  - `evidence: Option<Evidence>` — `TestId(String)`, `FileRef { path, line }`, or `NotTested { reason }`
- New function `verify_pr_acs(body: &str) -> Vec<String>` returning a list of human-readable failure strings (empty on success). It scans only the `## Acceptance Criteria` (or `## ACs`) section header, parses each checked AC line, and emits one failure per AC missing evidence.
- Helper `extract_ac_section(body: &str) -> &str` returns just the AC section text or the entire body when no header is present (defensive default so PRs without a header still get validated).

### 2. Hook into `verify_delivery`

In the existing `verify_delivery` step:

```rust
for url in &pr_urls {
    // existing review + AC checkbox checks
    if let Ok(body) = pr_body(url) {
        if !body_has_checked_acceptance(&body) {
            failures.push(format!("PR {url} does not show checked acceptance criteria in its body."));
        }
        failures.extend(verify_pr_acs_failures(&body, url));
    }
}
```

Failure messages follow the existing pattern (`"PR {url} — AC{label} ({head}): missing evidence..."`) so the lobster comment list stays consistent.

### 3. Update the PR template

In `agents/skills/dev/pr-open/SKILL.md`, expand the body template section to include a reminder that each AC line must end with `(testID: <id>)`, `(file: <path>:<line>)`, or `(not tested: <reason>)`. The template already lists ACs; the change is a one-line note explaining the evidence requirement.

### 4. Tests

New tests in `agents/workflows/feature-task/src/main.rs` `mod tests`:

- `parse_pr_evidence_recognises_test_id` — `- [x] AC1: Foo (testID: 1234)` parses to `Some(TestId("1234"))`.
- `parse_pr_evidence_recognises_file_ref` — `(file: apps/tasks/src/X.jsx:42)` parses to `FileRef` with both fields.
- `parse_pr_evidence_recognises_not_tested_reason` — `(not tested: requires manual click flow)` parses to a reason.
- `parse_pr_evidence_rejects_bare_not_tested` — bare `not tested` without parens or reason is `None`.
- `verify_pr_acs_passes_when_all_have_evidence` — full body with annotations returns empty failures.
- `verify_pr_acs_blocks_one_missing_evidence` — body with one AC lacking evidence returns one failure naming that AC.
- `verify_pr_acs_ignores_unchecked_lines` — `- [ ] AC2` lines do not require evidence.
- `verify_pr_acs_skips_other_sections` — `- [x]` lines in Test plan / Summary headings don't get re-parsed as ACs.
- `verify_pr_acs_handles_unheaded_bodies` — defensive default still parses top-level `- [x] AC` lines.

Fixtures go under `agents/workflows/feature-task/fixtures/pr-bodies/` with one file per scenario to keep the test inputs readable.

### 5. Documentation

- Optional: short addendum paragraph in `brain/bookmarks/specs/feature-factory-v2-2026-06-04.md` worked in via a separate Quinn-side AC5 commit; out of scope here.

## Test Plan

- `cd agents/workflows/feature-task && cargo test`
  - all existing tests still pass (no surface change to `verify_delivery` other than additive `failures.extend`)
  - new evidence tests listed above all pass
- `cargo build --manifest-path agents/workflows/feature-task/Cargo.toml` compiles cleanly
- Manual smoke:
  - open a feature-task PR with one AC missing evidence
  - inspect `verify-delivery` output (via `feature-task.lobster.yaml` step on the task) — should report one failure
  - amend the PR body to include `(file: ...)` or `(not tested: ...)` for the missing AC
  - re-run `verify-delivery` — empty failures

Coverage summary:

- AC1 (lobster parses and verifies evidence) — covered by `parse_pr_evidence_*` and `verify_pr_acs_*` tests
- AC2 (blocked-from-acceptance with clear comment) — covered by `verify_delivery` integration plus a fixture-driven test
- AC3 (PR template prompts for evidence) — covered by manual review of the updated `agents/skills/dev/pr-open/SKILL.md`
- AC4 (Rust unit tests cover parse + validation scenarios) — covered by the tests above
- AC5 (factory v2 spec amendment) — Quinn owner; out of this task's scope

## Open Questions and Risks

- **Multi-PR workstreams:** a parent task with three PRs (workstream A/B/C) will have each PR advertising only the ACs that workstream claims. The validation is per-PR, which matches the existing `body_has_checked_acceptance` per-PR behaviour. If product decides the lobster should additionally verify the union of ACs across all PRs covers every AC in the task description, that becomes a follow-up — out of scope here, flagged for later.
- **Test ID vs file ref choice:** the spec lets `testID` and `file:line` coexist. The lobster does not need to validate that the file exists on disk — that responsibility stays with Tom/Quinn at review time. Risk is moderate but bounded.
- **PR body header drift:** the lobster matches `## Acceptance Criteria` and `## ACs` (case-insensitive). If a PR uses a different heading (e.g. `## ✅ Acceptance Criteria`), the defensive `extract_ac_section` falls back to scanning the whole body, which still works because AC lines are uniquely tagged with `AC<N>`.
- **No system spec change.** The lobster binary is internal agent tooling, not a user-facing system. No `docs/systems/` update. The PR-side skill change is documentation, not system behaviour. The `no-system-spec-change` rationale will be posted on the PR.
