---
status: draft
task_id: afe39f3d-b6c8-4d40-a264-e88dbcf66d6c
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Fail feature-task clippy-evidence gate closed on gh errors

## Links

- Product spec: n/a — merge-gate correctness fix
- Tech design: `docs/specs/feature-task-clippy-fail-closed-tech-design.md`
- Task: `afe39f3d-b6c8-4d40-a264-e88dbcf66d6c` (W36 audit finding A2)
- Audit source: `docs/repo-audits/2026-W36.md` (PR #546, merged 2026-08-31)
- Tasks API record: `http://localhost:4001/api/v1/tasks/afe39f3d-b6c8-4d40-a264-e88dbcf66d6c`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `feat/afe39f3d-clippy-fail-closed`
- Worktree: `~/.openclaw/workspace/worktrees/afe39f3d-clippy-fail-open`
- Expected `.openclaw` follow-up: none — repo-local Rust change only.

## Scope

`clippy_evidence_failures` (`agents/workflows/feature-task/src/main.rs:4521-4538`) is supposed to be a non-bypassable merge gate: when `CLIPPY_ENFORCE=true` and a PR touches the Rust feature-task workflow (`agents/workflows/feature-task/**`), the gate must record a failure unless the PR body contains the canonical `cargo clippy` command. Today the gate fails **open** on transient `gh` errors because `pr_changed_files` (`:4449-4468`) swallows every non-success into an empty `Vec`:

```rust
fn pr_changed_files(url: &str) -> Vec<String> {
    let output = Command::new("gh").args([...]).output();
    let output = match output {
        Ok(out) if out.status.success() => out,
        _ => return Vec::new(),          // <-- swallows gh errors as "no files"
    };
    ...
}
```

That empty Vec is then used two more places downstream:

1. The same function's caller in `verify_delivery` (`:872-894`) computes `is_rust_pr: touches_rust_feature_workflow(&pr_files)` — an empty list means `false`, so a transient `gh` blip turns a Rust PR into "not a Rust PR" for the `DispatchingTestRunner` disambiguator and bare Rust test citations get misrouted to the wrong runner.
2. The empty list is then passed to `ac_parsing::mechanical_evidence_failures(..., &pr_files, ...)` (`:885-893`) which uses it for the "file path in PR diff" check; every file-path-shaped `TestId` citation will fail to match an empty diff and surface as a `[feature-task-progress-checklist]` failure. That's actually the *right* failure mode — but it's silent: the failure message says "missing evidence for AC1", not "couldn't fetch PR files", so reviewers can't tell whether the AC is unsatisfied or whether `gh` is broken.

The inconsistency inside `clippy_evidence_failures` itself is stark: the `pr_body` branch (`:4602-4604`) treats an `Err` as a recorded gate failure (`"Could not read PR body for clippy evidence check ({url}): {err}."`) while the `pr_changed_files` branch above it treats the equivalent error as a silent pass.

**Target state.** `pr_changed_files` returns `Result<Vec<String>, String>`. Every caller distinguishes "no files" from "couldn't fetch" and treats the latter as a merge-gate failure (matching the `pr_body` discipline). The dispatch site defaults `is_rust_pr` to **assume Rust** when the file list is unknown, so a `gh` blip can't under-check Rust test citations. A new unit test simulates a `gh` failure and asserts the gate **fails** (not passes) for a Rust-touching PR.

## Why not code-garden

`tracked-code-task` per the audit. The change alters merge-gate behavior; code-garden is reserved for behavior-preserving drive-by cleanup.

## Implementation plan

File/module scope:

- **`agents/workflows/feature-task/src/main.rs`** — primary change.
  1. **Signature change.** Replace
     ```rust
     fn pr_changed_files(url: &str) -> Vec<String>
     ```
     with
     ```rust
     fn pr_changed_files(url: &str) -> Result<Vec<String>, String>
     ```
     Body: on non-zero status, return `Err(format!("gh pr view {url} --json files exited {code}: {stderr}"))`; on `Ok` with empty stdout (a legitimately empty diff) return `Ok(vec![])`. Do **not** swallow `serde_json` decode errors as empty — they indicate a schema drift and should surface too. (`gh` 2.87.x has been known to emit both empty stdout and JSON errors on transient API issues; we want to be able to tell those apart in the failure message.)
  2. **Update `clippy_evidence_failures` (`:4521-4538`).** Match on the `Result`:
     ```rust
     let files = match pr_changed_files(url) {
         Ok(f) => f,
         Err(e) => {
             return vec![format!(
                 "Could not list changed files for clippy evidence check ({url}): {e}"
             )];
         }
     };
     if files.is_empty() {
         // Genuinely empty diff — treat as "doesn't touch Rust workflow" (preserves
         // current behaviour for PRs with no files, e.g. label-only edits).
         return Vec::new();
     }
     if !touches_rust_feature_workflow(&files) {
         return Vec::new();
     }
     // ...existing pr_body check unchanged...
     ```
     Note: a zero-file PR has historically been treated as "not Rust" and that contract should be preserved — the audit specifically calls out the **error** path failing open, not the empty-diff path. The `Err(e)` branch is the fix.
  3. **Update the `verify_delivery` dispatch site (`:872-894`).** Today:
     ```rust
     let pr_files = pr_changed_files(url);
     let body = pr_body(url).unwrap_or_default();
     let test_runner: Box<dyn ac_parsing::TestRunner> = Box::new(DispatchingTestRunner {
         is_rust_pr: touches_rust_feature_workflow(&pr_files),
     });
     let mechanical_failures = ac_parsing::mechanical_evidence_failures(
         &env.task.id, &task_acs, &body, &pr_files, test_runner.as_ref(),
     );
     ```
     Change to:
     ```rust
     let pr_files = match pr_changed_files(url) {
         Ok(f) => f,
         Err(e) => {
             failures.push(format!(
                 "Could not list changed files for mechanical evidence check ({url}): {e}"
             ));
             // Bail out before constructing test_runner — every downstream decision
             // depends on the file list. Mark gate failed, return early.
             mechanical_gate_failed = true;
             // ...continue to transition_or_block below with the new failure...
         }
     };
     ```
     **However**, the audit's "Implementation sketch — top 3" proposes a softer variant for the dispatch site: treat unknown file lists as "assume Rust" (`is_rust_pr: true`) so citations are **over-checked** during a `gh` blip rather than misrouted. That's the safer default — false positives (a shell citation routed to cargo, which would no-op) are less harmful than false negatives (a Rust citation silently routed to pnpm, which would no-op differently). Adopt the audit's variant:
     ```rust
     let pr_files_result = pr_changed_files(url);
     let is_rust_pr = match &pr_files_result {
         Ok(files) => touches_rust_feature_workflow(files),
         Err(_)    => true, // audit's recommendation: assume Rust on unknown
     };
     let pr_files = pr_files_result.unwrap_or_default(); // for mechanical_evidence_failures
     if let Err(e) = &pr_files_result {
         failures.push(format!(
             "Could not list changed files for mechanical evidence check ({url}): {e}; \
              defaulting to Rust citation runner"
         ));
     }
     let body = pr_body(url).unwrap_or_default();
     let test_runner: Box<dyn ac_parsing::TestRunner> = Box::new(DispatchingTestRunner { is_rust_pr });
     let mechanical_failures = ac_parsing::mechanical_evidence_failures(
         &env.task.id, &task_acs, &body, &pr_files, test_runner.as_ref(),
     );
     ```
     This surfaces the failure to the gate **and** keeps citations safe. The empty-`pr_files` slice passed to `mechanical_evidence_failures` means file-path-shaped `TestId` citations will still fail their "path in diff" check; that surfaces as a separate `[feature-task-progress-checklist]` failure which is informative.
  4. **Helper for the failure message.** Reuse the pattern from the `pr_body` Err branch (`:4602-4604`) — keep the formatting centralised. No new helper needed beyond inlining `format!`s at the two new Err sites.
  5. **Tests (this module).** Add to the existing `#[cfg(test)] mod tests` block (alongside `clippy_evidence_matches_canonical_command` at `:8081` and `touches_rust_feature_workflow_*` at `:8107+`):
     - `pr_changed_files_gh_failure_returns_err` — drives `pr_changed_files` against a URL where `gh` exits non-zero. Cleanest approach: introduce a tiny test seam `fn run_pr_changed_files<F: FnOnce(&mut Command)>(url: &str, configure: F) -> Result<Vec<String>, String>` that wraps the `Command::new("gh")` construction and lets the test inject a no-op executable. Alternatively (lower-risk): keep `Command::new("gh")` but set `PATH` in the test to a directory containing a shim script that exits 1 with stderr `simulated gh failure` — the existing `clippy_enforce_enabled_respects_env_flag` (`:8138`) shows the pattern. Pick whichever is less invasive; the shim is simpler and doesn't touch the production signature. **If neither is acceptable**, factor out the `gh` invocation into a free function `fn run_gh_pr_view(url: &str) -> Result<Vec<String>, String>` and unit-test that directly.
     - `clippy_evidence_failures_gh_failure_blocks_rust_pr` — drives `clippy_evidence_failures` with `CLIPPY_ENFORCE=true` and a `gh` shim that fails; assert the returned Vec is non-empty and contains a substring `"Could not list changed files"`.
     - `clippy_evidence_failures_gh_failure_ignored_when_enforce_disabled` — same as above but with `CLIPPY_ENFORCE` unset; assert empty Vec (preserves today's short-circuit).
     - `dispatching_test_runner_assumes_rust_on_unknown_files` — construct `DispatchingTestRunner { is_rust_pr: true }` (the dispatch-site default for `Err`); feed it a bare-Rust test citation and a bare-shell citation via a stub `TestRunner`; assert the Rust citation routes to cargo, the shell citation to shell (or no-op, depending on shape). This pins the "assume Rust" behaviour the audit sketch mandates.

- **`agents/workflows/feature-task/src/ac_parsing.rs`** — no signature change required. `mechanical_evidence_failures` already takes `pr_files: &[String]`; the `verify_delivery` caller just passes the now-possibly-empty slice. The empty-slice behaviour (every file-path `TestId` fails "path in diff") is the **correct** failure mode — it surfaces the `gh` problem as an actionable `[feature-task-progress-checklist]` comment, not a silent pass.

- **No changes** to `services/content-scheduler-api/**`, no CI workflow changes, no `.openclaw` cron changes.

## Data model / API contract

- None — internal Rust API only.

## Workflow / cron / skill changes

- None. The lobster's external surface (failure fingerprint strings, comment tag `[feature-task-progress-checklist]`) is preserved. New failure strings (`"Could not list changed files for ... check ({url}): {e}"`) reuse the existing tag and follow the audit's QW1 sketch.

## Risk analysis

- **Behavior change on `gh` failure.** Today: silent pass on `gh` blip. After: a recorded gate failure. This is the desired change, but a single `gh` outage could in principle block every Rust feature-task PR in flight. That's acceptable — it's exactly the audit's intent (a merge gate that can't fetch its evidence should block), and matches the `pr_body` discipline already in place.
- **Empty-diff PRs.** A PR with no file changes (e.g. label-only edits) currently bypasses the clippy gate; that contract is preserved by treating `Ok(vec![])` as "doesn't touch Rust workflow". Only `Err(_)` is the new failure path.
- **Dispatch-site default to Rust on `Err`.** Means a `gh` blip will over-check shell citations (sending them through the cargo runner, which will likely no-op or error clearly). That's strictly safer than the current under-check behaviour.
- **Test seam.** The shim-via-`PATH` approach is brittle (other tests in the file may rely on `PATH`); the cleaner refactor is `run_gh_pr_view` free function. Either is acceptable; prefer the free function for testability.
- **Backwards compatibility.** `pr_changed_files` is `fn`-private (`agents/workflows/feature-task/src/main.rs:4449` — no `pub`), so the signature change has no external blast radius.

## Acceptance Criteria alignment

| Task AC | Where covered |
|---|---|
| AC1 — `pr_changed_files` returns `Result<Vec<String>, String>` | Implementation step 1 |
| AC2 — `clippy_evidence_failures` records a failure on `gh` error (fail-closed, matching `pr_body`) | Implementation step 2 + test `clippy_evidence_failures_gh_failure_blocks_rust_pr` |
| AC3 — `is_rust_pr` dispatch site treats unknown as "assume Rust" | Implementation step 3 + test `dispatching_test_runner_assumes_rust_on_unknown_files` |
| AC4 — Unit test simulates `gh` failure, asserts clippy gate fails (not passes) for a Rust-touching PR | Implementation step 5 (`clippy_evidence_failures_gh_failure_blocks_rust_pr`) |
| AC5 — Existing green tests stay green; successful-read behaviour unchanged | The `Ok(files)` branch is byte-for-byte identical to today's logic (the empty-diff short-circuit and `touches_rust_feature_workflow` check are preserved). New tests cover the `Err` path. |

## Out of scope

- A2 depends on this task landing before A3+A4 (`d578e547`) begins the `main.rs` module split, per the audit's "Depends on the A2 clippy-gate fix landing first." A2's PR should merge before A3+A4's worktree is opened.
- `cargo_test_leaf_outcome` ambiguity fix (A4) — separate workstream; will fold into A3+A4's PR.
- Branch-protection changes to make the clippy-evidence gate required (separate concern; current implementation is gated by `CLIPPY_ENFORCE=true` env var per task `55c98158`).
