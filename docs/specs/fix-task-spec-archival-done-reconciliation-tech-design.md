---
status: draft
task_id: b734b75e-858c-4bbf-9496-34bf4860bd85
product_spec: /Users/quinnstoffer/.openclaw/workspace/brain/tasks/specs/in-progress/fix-task-spec-archival-done-reconciliation-2026-08-09.md
shipped_pr: null
shipped_date: null
---

# Fix task-spec archival when tasks reach done — tech design

## Task and repository

- Task ID: `b734b75e-858c-4bbf-9496-34bf4860bd85`
- Task title: `💻 Fix task-spec archival when tasks reach done`
- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-b734b75e-fix-spec-archival-tech-design` (this design only — implementation lands on a fresh branch off `origin/main`)
- Workflow: `agents/workflows/feature-task` (Rust lobster)
- Product spec (brain): `brain/tasks/specs/in-progress/fix-task-spec-archival-done-reconciliation-2026-08-09.md`

## Problem statement

The feature-task lobster already has a spec-archival helper (`archive_done_task_spec` in `agents/workflows/feature-task/src/main.rs` ~line 1680) that moves a task's referenced spec from `brain/tasks/specs/in-progress/` to `brain/tasks/specs/done/` and rewrites the task's `**Spec:**` line. That helper is wired into exactly one trigger: the `post_merge` stage (called from `agents/workflows/feature-task/src/main.rs` ~line 1233). Two classes of failure follow:

1. **Single-trigger fragility.** Anything that prevents `post_merge` from running cleanly for a single feature-task PR (lobster crash, brain filesystem access error, scheduler miss) leaves the task at `done` with its spec still under `brain/tasks/specs/in-progress/` forever. The state-pair `(task.status=done, spec.path starts with brain/tasks/specs/in-progress/)` is the diagnostic shape and there is no code path that closes it.
2. **Silent skips.** A `**Spec:**` line written with an inline annotation (e.g. `**Spec:** brain/tasks/specs/in-progress/foo.md (legacy inline note)`) is not matched by the existing line-extraction regex used by `product_spec()`. The archive helper is therefore never called for that task, the spec stays in `in-progress/`, and nothing surfaces the misparse in either the lobster state or a task comment. This is the "silently unparseable" failure mode the task description calls out.

The recent iCloud/TCC `Operation not permitted` incident made case (1) acute: the filesystem rename failed inside `fs::rename`, the helper returned `Err(...)` propagated up through the stage, and the lobster retried until the entire run aborted without ever recording what went wrong or that the task's spec still needed archival. The "swallow error" temptation would hide this; the design below keeps it loud.

## Goals and non-goals

**Goals**

- Done is the trigger, not post_merge. Any code path that takes a feature task from `open`/`doing`/`acceptance` to `done` reconciles the spec archive in the same transaction window.
- A reconciliation sweep closes the gap for tasks that reached `done` historically with no successful archive (existing tasks stuck at `(done, in-progress)`).
- Filesystem failures (rename, readdir, write to done/) produce a visible, actionable, retryable diagnostic on the task. They never silently leave the task wedged.
- Specs outside the lifecycle (open, bookmark, docs, missing) stay no-ops and remain covered by tests.

**Non-goals**

- No changes to the spec lifecycle directories (`open/`, `in-progress/`, `done/`, `archived/`).
- No changes to the spec-drift / spec-resync flow (separate concern in `product_spec_approved_by_tom` / `resync`).
- No automatic retry from the lobster scheduler beyond the existing sweep cadence. The reconciliation pass itself is the retry mechanism.

## Current implementation map (anchor lines)

- `archive_done_task_spec` (`main.rs` ~1680): the existing helper. Returns `Ok(env)` for skip cases (AlreadyArchived, NotTaskSpec, MissingSpecRef, OpenSpecCannotArchive), returns `Err(...)` for filesystem failures, idempotent on pre-existing destination.
- `plan_task_spec_archive` (~1579): pure decision function returning `ArchiveSpecPlan::{Move, AlreadyArchived, OpenSpecCannotArchive, NotTaskSpec, MissingSpecRef}`. Already excludes bookmark/docs paths and guards path traversal.
- `rewrite_spec_line_in_description` (referenced at ~1734 and ~1752): replaces the `from_rel` token with `to_rel` inside the task description. This is the same function used for chat-spec approval moves; verify it tolerates inline annotations before relying on it here.
- `product_spec()` (`main.rs` ~1495 region): extracts the spec path from the task description. Currently uses a strict `**Spec:** <path>` regex; this is where inline-annotated Spec lines get silently skipped.
- Post-merge stage call site (~1233): `let env = archive_done_task_spec(&args, env)?;`. This is the only call to the helper today.
- Tests covering the existing helper (`main.rs` ~5067–5262): `plan_task_spec_archive_*`, `archive_done_task_spec_*`. These are decision-function tests, not end-to-end transition tests.

## Implementation plan

### 1. Extract a pure `archive_task_spec_for_done_task` decision function

Refactor the existing helper so the decision logic ("can we archive? what's the plan? what's the new description?") is a pure function that takes `(task, workspace_root)` and returns an `ArchiveOutcome`:

```rust
enum ArchiveOutcome {
    Moved { from_rel: String, to_rel: String },
    AlreadyArchived { to_rel: String },
    NotApplicable { reason: ArchiveSkipReason }, // NotTaskSpec, OpenSpecCannotArchive, MissingSpecRef
    Retryable { from_rel: String, to_rel: String, reason: String }, // filesystem/permission error
}
```

The existing `plan_task_spec_archive` is preserved as the planning step. The new wrapper layers (a) description-rewriting and (b) outcome classification on top.

### 2. Add a done-transition trigger in addition to post_merge

Add a new stage — or fold the call into the existing done-transition stage — that invokes the helper whenever a task's status changes to `done` in a sweep. The stage must:

- Detect a transition to `done` for any assignee this run touched.
- Call `archive_task_spec_for_done_task`.
- On `Moved` / `AlreadyArchived`: rewrite the description and update via `api_patch` (same path as today).
- On `NotApplicable`: log structured info, no task comment.
- On `Retryable`: post a structured task comment with `from_rel`, `to_rel`, `error reason`, and `retry hint`. Do **not** return `Err` from the stage — the task is `done`, leave it done.

The post_merge call site stays so that PR-merge-driven archival still works when the lobster runs the post_merge stage. Both call sites share the new helper.

### 3. Add a reconciliation sweep pass

Add a small reconciliation step at the top of every feature-task lobster run (or as a one-shot CLI subcommand plus a sweep-hook):

- Query the Tasks API for tasks with `status=done` and `assignee=<each known implementer>` (or all done feature tasks, behind a feature flag for blast radius).
- For each, parse `**Spec:**` and check whether the referenced path starts with `brain/tasks/specs/in-progress/`.
- For each match, run the archive helper with the same outcome handling as the done-transition trigger.
- This is the safety net that closes the historical backlog and any future case where a single lobster run skipped post_merge.

A new lobster-state comment tracks reconciliation runs (started, scanned, archived, skipped, retryable). This avoids re-commenting per-task every run.

### 4. Make Spec-line parsing tolerant of inline annotations

Update `product_spec()` (or a new helper that supersedes it for archival purposes) to capture the path component of `**Spec:**` even when followed by inline text in parens, brackets, or backticks:

- Primary form: `**Spec:** <path>` (already supported).
- Inline annotation form: `**Spec:** <path> (some legacy note)` — capture the path, preserve the annotation by re-attaching it after rewriting.
- Backtick-wrapped path: `**Spec:** \`<path>\`` — strip the backticks for parsing, keep them in the rewrite.
- Trailing-punctuation: `**Spec:** <path>,` — strip trailing punctuation that isn't part of the path.

If the line is genuinely unparseable (e.g. multi-line Spec value, completely malformed), the helper returns an explicit `NotApplicable::UnparseableSpecLine` variant, which the orchestrator surfaces as a task comment with the original line content and a `[action-needed]` marker — never a silent skip.

### 5. Post task comments on retryable failure, not silent errors

When the archive helper hits a filesystem/permission error (`fs::rename` failure, `to_abs` parent not creatable, etc.):

- Post a structured task comment with author `Lobster`:
  ```
  [spec-archive-retryable]
  from: brain/tasks/specs/in-progress/<slug>.md
  to:   brain/tasks/specs/done/<slug>.md
  reason: <error chain>
  retry: the next reconciliation sweep will retry automatically; resolve the underlying filesystem access issue to clear.
  ```
- Set the lobster-state comment's `failureFingerprint` to a stable hash of `(task_id, from_rel, error_kind)` so the dedup behavior doesn't suppress the diagnostic forever.
- Mark the task with attention-owner "Quinn" (or a more specific owner) via the existing attention-owner API so the failure is visible in the task's row.
- Do **not** revert `task.status` from `done`. The task stays done; the spec stays in `in-progress/` until the next reconciliation sweep can succeed.

### 6. Idempotency: pre-existing destination with same content

Today, the helper checks `to_abs.exists()` and short-circuits to "already present". Extend this so the rewrite step also runs in that case — currently it does, but make it explicit in tests. If `to_abs` exists with **different** content from `from_abs`, post a task comment with `[spec-archive-conflict]` and leave both files in place (do not overwrite). The reconciliation sweep will not re-attempt this case until a human resolves the conflict.

### 7. Tests (AC6)

New tests, organised by AC:

- **Successful transition archival.** End-to-end: create a task with `spec=in-progress/foo.md`, transition to `done`, assert file moved and description rewritten.
- **Retry / idempotency.** Run the archive helper twice on the same task with `to_abs` pre-existing; assert no duplicate moves and description is correctly rewritten both times.
- **Pre-existing destination, same content.** Asserts `AlreadyArchived` outcome, description rewrite happens once.
- **Pre-existing destination, different content.** Asserts `[spec-archive-conflict]` comment posted, both files intact.
- **Inline-annotated Spec reference.** Task description with `**Spec:** brain/.../foo.md (legacy note)` archives correctly and preserves the inline note.
- **Filesystem failure reporting.** Simulate `fs::rename` failure (use a read-only tempdir or mock the rename). Assert task comment contains `from`/`to`/`reason`/`retry`, lobster state has non-suppressed fingerprint, task remains `done`.
- **Task description preservation.** Snapshot task description before archive; assert the rewritten description differs only in the Spec line and that the inline annotation is preserved.
- **No-op cases (AC5).** Already in done/ → AlreadyArchived; open spec → OpenSpecCannotArchive; bookmark spec → NotTaskSpec; missing Spec line → MissingSpecRef; docs/specs → NotTaskSpec. These map to existing plan tests but assert the *outcome enum*, not just the plan enum.
- **Reconciliation sweep.** Test the sweep end-to-end with a fixture of 3 tasks (one already done/in-progress, one open, one done/done). Assert exactly one archive fires and the others are no-ops.

### 8. Documentation (AC7)

Update `docs/systems/tasks.md` (or add a new `docs/systems/spec-archival.md` if the volume warrants) with:

- Reconciliation trigger: any code path taking a task to `done`, plus the periodic reconciliation sweep.
- Retry behavior: filesystem failure → task comment + attention owner + next sweep retries. No automatic infinite retry without operator signal.
- Filesystem vs workflow failures: filesystem access errors (rename, permission, disk full) are retryable and surfaced as task comments; workflow logic errors (malformed Spec line, plan conflict) are surfaced as `[action-needed]` and require human resolution.

### 9. Migration / operational rollout

Because the reconciliation sweep will close existing gaps, no separate backfill script is needed. The first sweep run after deploy may post many `[spec-archive-retryable]` or `[spec-archive-conflict]` comments for already-broken tasks; that's intentional and gives Quinn a single audit list. If the iCloud/TCC incident is still active, those comments will accumulate and surface the underlying problem cleanly.

## Open questions and risks

1. **Brain filesystem reliability.** This design assumes the reconciliation sweep is itself reliable. If the sweep itself fails on filesystem access, the operator needs an alert path. Consider surfacing sweep-level failures via a separate cron-driven dry-run that emails on failure.
2. **Description-rewrite collisions.** `rewrite_spec_line_in_description` does a string replace on `from_rel`. If two tasks share a spec path (which shouldn't happen but is worth checking), one rewrite could affect the other's description. The design does not change the rewrite function; flag for review during implementation.
3. **Inline annotation parsing breadth.** Parsing `**Spec:**` lines tolerantly is a slippery slope. Limit the supported inline forms to: `(...)`, `[...]`, trailing punctuation, and backtick-wrapped paths. Anything more exotic returns `UnparseableSpecLine` and surfaces for human review.
4. **Sweep blast radius.** Scanning all done feature tasks every run is cheap today but may not always be. The design uses `assignee=<known implementer>` to bound the query; verify that index covers the common cases.

## AC verification matrix

| AC | Verification approach | Planned evidence |
| --- | --- | --- |
| AC1 | Integration test: transition to `done` moves the spec and rewrites the Spec line; idempotency test confirms retries are safe. | New transition-archive integration test + idempotency test. |
| AC2 | Done-trigger + reconciliation-sweep tests; explicit filesystem-failure comment test asserts retryable state persists across runs. | New done-trigger test + sweep test + filesystem-failure test. |
| AC3 | Inline-annotation test; explicit unparseable-Spec-line test asserts `[action-needed]` comment, not silent skip. | New inline-annotation test + unparseable-line test. |
| AC4 | Filesystem-failure test asserts comment structure (`from`/`to`/`reason`/`retry`); assert task stays `done`. | Filesystem-failure test + manual review of one comment. |
| AC5 | No-op test for each non-applicable path; existing plan tests assert `ArchiveOutcome::NotApplicable` mapping. | New no-op outcome tests. |
| AC6 | All seven new test groups above. | Test run with `cargo test -p feature-task`. |
| AC7 | Doc review against `docs/systems/tasks.md`; markdown CI lint passes. | PR diff on docs file. |
