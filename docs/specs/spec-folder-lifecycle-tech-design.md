---
status: approved
task_id: a5a4ed8f-e7c4-4b6c-8ac9-bb962211ac44
product_spec: brain/tasks/specs/spec-folder-lifecycle-2026-07-07.md
shipped_pr: null
shipped_date: null
---

# Spec folder lifecycle and lobster sync — Tech Design

## Product intent summary

Product spec: `brain/tasks/specs/spec-folder-lifecycle-2026-07-07.md`.
Task: `a5a4ed8f-e7c4-4b6c-8ac9-bb962211ac44` (`🔧 Spec folder lifecycle and lobster sync`).

The approved product intent is a forward-only lifecycle owned by lobsters, not humans:

> Chat-created specs in `brain/tasks/specs/` follow a forward-only lifecycle: created → `open/`, approved → `in-progress/`, task done → `done/`. The Tasks API is the system of record once a spec is in `in-progress/` — no reverse file moves.

> Bookmark specs in `brain/bookmarks/specs/` keep their existing approval pipeline and stay in place until a task is created from them. Only the approved-and-tasked bookmark specs move into `tasks/specs/in-progress/`.

> The feature-task lobster and bookmark lobster cooperate to keep file state in sync with task state. Quinn never moves a spec file manually.

The eight acceptance criteria are:

1. `brain/tasks/specs/open/`, `brain/tasks/specs/in-progress/`, and `brain/tasks/specs/done/` exist as the only subdirs under `tasks/specs/`; the feature-task lobster validates this layout on every run.
2. New chat specs land in `tasks/specs/open/<slug>-YYYY-MM-DD.md` with `- [ ] **Approved by Tom**`; `feature-task-create` and `tasks-create` write to this path.
3. New bookmark specs land in `bookmarks/specs/<slug>-<key>.md` with `- [ ] **Approved by Tom**`; `spec-author` and `lobster_generate_specs.py` use this path.
4. Feature-task lobster detects a checked Tom approval marker on chat specs in `open/` and moves them to `in-progress/`, idempotently and with no reverse moves.
5. Bookmark approval toggles the file checkbox but does not move the spec out of `bookmarks/specs/`.
6. Bookmark task creation moves an approved bookmark spec to `tasks/specs/in-progress/` and updates the new task's `**Spec:**` line.
7. Feature task completion moves specs from `tasks/specs/in-progress/` to `tasks/specs/done/` and patches the task `**Spec:**` line.
8. Feature-task `spec_check` reads the spec by the task `**Spec:**` path, regardless of folder; every move must patch that path atomically and idempotently.

## Repo / branch / worktree

- Repository: `codebases/sindustries` (`Stoffer-Industries/sindustries`)
- Branch: `task-a5a4ed8f-spec-folder-lifecycle`
- Worktree: `~/workspaces/rowan/sindustries-task-a5a4ed8f-spec-folder-lifecycle`
- Product spec: `/Users/quinnstoffer/.openclaw/workspace/brain/tasks/specs/spec-folder-lifecycle-2026-07-07.md`
- Tech design: `docs/specs/spec-folder-lifecycle-tech-design.md`

## `.openclaw` boundary notes

No `.openclaw` config, gateway, scheduler, node, or prompt changes are expected for this task. The implementation is contained to the SIndustries repo's brain-facing workflow code and skills.

The lobster runtime itself lives outside this repo/workspace boundary at execution time: the YAML definitions and scripts are in `codebases/sindustries`, but lobster orchestration is run by the OpenClaw runtime. This task should only change repo-owned workflow scripts, Rust code, skill docs, tests, and brain file paths; it should not mutate OpenClaw runtime configuration.

## Implementation plan with file/module scope

### Files and modules in scope

Feature-task workflow:

- `agents/workflows/feature-task/feature-task.lobster.yaml` — stage wiring; no structural change expected unless a new stage is split out from `spec_check`.
- `agents/workflows/feature-task/run.py` — wrapper entry point; no expected logic change.
- `agents/workflows/feature-task/src/main.rs` — primary implementation surface for layout validation, chat approval move, done move widening, spec-line patching, and tests.
- `agents/workflows/feature-task/Cargo.toml` / `Cargo.lock` — only if tests need a new dev dependency; default plan is no new dependency.
- `agents/workflows/feature-task/fixtures/*` — add or adjust fixtures only if unit tests need realistic task descriptions.

Bookmark workflow:

- `agents/workflows/bookmarks/bookmarks.lobster.yaml` — confirms the current stage order: `generate_specs` → `request_spec_approval` → `create_tasks_from_proposals` → `resolve_spec_request`.
- `agents/workflows/bookmarks/run.py` — exposes `specsRoot: brain/bookmarks/specs`; no expected logic change.
- `agents/workflows/bookmarks/scripts/common.py` — `SPECS_ROOT`, `STATE_PATH`, and shared path helpers.
- `agents/workflows/bookmarks/scripts/lobster_generate_specs.py` — bookmark spec path derivation and revision writes.
- `agents/workflows/bookmarks/scripts/lobster_request_spec_approval.py` — approval package preparation; likely not the checkbox writer unless approval is resolved there in a future refactor.
- `agents/workflows/bookmarks/scripts/handle_approval_reply.py` — current approval resolution path; best place to toggle `- [x] **Approved by Tom**` when `approvalStatus` transitions to `approved`.
- `agents/workflows/bookmarks/scripts/lobster_create_tasks_from_proposals.py` — task creation and post-create move from `bookmarks/specs/` to `tasks/specs/in-progress/`.
- `agents/workflows/bookmarks/scripts/validate_spec_output.py` — ensure validated Quinn-authored bookmark specs still report `brain/bookmarks/specs/<slug>-<key>.md`.

Skill docs / task creation helpers:

- `agents/skills/product/feature-task-create/SKILL.md` — update chat-created feature spec location from `brain/tasks/specs/<slug>-YYYY-MM-DD.md` to `brain/tasks/specs/open/<slug>-YYYY-MM-DD.md`.
- `agents/skills/ops/tasks-create/SKILL.md` — same path update for feature tasks and the `**Spec:**` examples.
- `agents/skills/product/spec-author/SKILL.md` — confirm bookmark specs remain under `brain/bookmarks/specs/<slug>-<bookmark_key>.md`.
- `agents/skills/ops/tasks-api/tasks_api_client.py` — no schema change expected; use existing `--spec` composition and `patch --description` for path updates.

Top-level `agents/scripts/` note: there is no `agents/scripts/` directory in the current tree. The lobster entry points for this feature live under `agents/workflows/feature-task/` and `agents/workflows/bookmarks/scripts/`.

State JSON paths:

- `brain/state/bookmark-review-state.json` — bookmark item state, including `approvalStatus`, `specDocs`, and `taskIds`.
- `brain/state/bookmark-transitions.jsonl` — existing transition log used by bookmark scripts.
- Tasks API records — task description `**Spec:**` lines and feature-task lobster state/comments are API-owned, not local JSON files.

### AC1 — layout validation

Add feature-task Rust helpers in `agents/workflows/feature-task/src/main.rs`:

- `const TASK_SPECS_OPEN_DIR: &str = "brain/tasks/specs/open";`
- `const TASK_SPECS_IN_PROGRESS_DIR: &str = "brain/tasks/specs/in-progress";`
- keep/update `TASK_SPECS_DONE_DIR`.
- `bootstrap_task_spec_layout(workspace_root: &Path) -> Result<()>`:
  - `fs::create_dir_all` for `open`, `in-progress`, and `done`.
  - read the direct children of `brain/tasks/specs/`.
  - fail loudly if any direct child is a directory other than `open`, `in-progress`, or `done`.
  - allow files directly under `brain/tasks/specs/` during rollout only if Quinn explicitly chooses a migration grace period; default plan is to fail on unexpected subdirs, not files, because the AC only constrains subdirs.

Call this helper at the start of the feature-task `spec_check` stage, before approval or checksum work. This makes every lobster run reconcile missing dirs and block broken layouts early.

### AC2 — chat spec creation path

Current docs point new feature specs at `brain/tasks/specs/<slug>-YYYY-MM-DD.md`:

- `agents/skills/product/feature-task-create/SKILL.md`
- `agents/skills/ops/tasks-create/SKILL.md`

Update those examples/checklists to `brain/tasks/specs/open/<slug>-YYYY-MM-DD.md`. The actual writers are human/agent skill executions that create markdown files before calling `tasks_api_client.py create --spec`; there is not a central code writer for chat specs today. The task description's `**Spec:**` line must therefore also use `brain/tasks/specs/open/<slug>-YYYY-MM-DD.md` at creation.

### AC3 — bookmark spec path

Bookmark specs remain at `brain/bookmarks/specs/<slug>-<key>.md`.

Current derivation:

- `agents/workflows/bookmarks/scripts/common.py` sets `SPECS_ROOT = WORKSPACE / "brain" / "bookmarks" / "specs"`.
- `agents/workflows/bookmarks/scripts/lobster_generate_specs.py::spec_doc_path(specs_root, topic, spec_title, bookmark_key, index)` returns `specs_root / f"{slugify(spec_title)}-{bookmark_key}{suffix}.md"`.
- `suffix` is empty for the first spec and `-part-<n>` for additional specs.
- `slugify(spec_title)` provides the slug; `bookmark_key` is the stable key appended after the slug.
- `agents/skills/product/spec-author/SKILL.md` documents the same durable path: `brain/bookmarks/specs/<slug>-<bookmark_key>.md`.

No move to `tasks/specs/open/` happens for bookmark specs.

### AC4 — approval move for chat specs

Implement a new `plan_chat_spec_approval_move(spec_path, spec_text)` pure helper in `src/main.rs`:

- Only considers specs currently under `brain/tasks/specs/open/*.md`.
- Requires `product_spec_approved_by_tom(spec_text)` to be true.
- Destination is `brain/tasks/specs/in-progress/<same-file-name>.md`.
- If source is already under `in-progress/`, returns an idempotent no-op.
- If source is under `done/`, returns no-op.
- If approval is unchecked while in `in-progress/`, returns no-op. This enforces no reverse moves.

In `spec_check`, after loading the spec from the current `**Spec:**` line and before checksum finalization, run the plan. On move:

1. Ensure destination parent exists.
2. If destination already exists and source is absent, only patch the task description to the destination path.
3. Otherwise `fs::rename`/`mv` source → destination.
4. Patch the task description's `**Spec:**` line from old path to new path using the existing `rewrite_spec_line_in_description` pattern.
5. Re-fetch task state before continuing checksum/status logic.

Do not use `git mv` inside the runtime lobster; the brain tree is workspace state, not a repo checkout. Use `fs::rename`/`mv`. If an implementation run is inside a git worktree and both paths are tracked, Git will still detect the rename.

### AC5 — bookmark approval toggle without move

Current approval resolution is in `agents/workflows/bookmarks/scripts/handle_approval_reply.py`, where `approvalStatus` is set to `approved` or `declined`. `lobster_request_spec_approval.py` prepares the package but does not resolve the transition.

Add a shared helper, either in `handle_approval_reply.py` or `common.py`:

- `set_spec_approval_checkbox(spec_doc: str, approved: bool) -> bool`
- Valid only for paths under `brain/bookmarks/specs/` at this stage.
- Replaces an existing `- [ ] **Approved by Tom**` with `- [x] **Approved by Tom**` on approval.
- If already checked, no-op.
- If the marker is missing, append or fail visibly; recommendation: fail visibly so malformed specs do not silently pass approval.
- Atomic write: write to a temp file in the same directory and `os.replace`.

When `approvalStatus` transitions to `approved`, toggle every `specDoc` for that bookmark. Do not move the file. The file stays in `brain/bookmarks/specs/` until AC6.

### AC6 — bookmark task creation move

Modify `agents/workflows/bookmarks/scripts/lobster_create_tasks_from_proposals.py`:

- Keep the existing approval gate: only create/reuse tasks for items whose `approvalStatus` is `approved`.
- Before creating a new task, compute the task spec destination: `brain/tasks/specs/in-progress/<basename(spec_doc)>`.
- Build the task description with the destination path in the `**Spec:**` line, not the source bookmark path.
- After successful task creation, move `brain/bookmarks/specs/<slug>-<key>.md` to `brain/tasks/specs/in-progress/<slug>-<key>.md`.
- If the destination already exists, treat as idempotent success and do not overwrite unless content matches exactly. If source is missing and destination exists, continue and ensure the task description points at destination.
- Patch or create the task description so `**Spec:**` points at the destination. For reused existing tasks, patch if the old path still points at `brain/bookmarks/specs/`.
- Update any state `specDocs` entries for the item to the new path after the move, so later pipeline displays and dedupe tags are not stale. This is a state value update, not a schema addition.

Use `os.rename`/`Path.rename` for the move. Both source and destination live under the same OpenClaw workspace on the same machine, so `mv`/rename is fine; do not shell out to `git mv`.

### AC7 — task done move

`agents/workflows/feature-task/src/main.rs` already has task `c40ae956` archive helpers that move direct `brain/tasks/specs/<slug>.md` specs to `brain/tasks/specs/done/<slug>.md` on post-merge/done.

Update that helper set:

- Replace the old live root assumption (`brain/tasks/specs/<file>.md`) with `brain/tasks/specs/in-progress/<file>.md`.
- Already in `done/` remains idempotent no-op.
- `open/` should not move directly to `done/`; if a task reaches done with an open spec, block with a visible checklist because the approval lifecycle is broken.
- Apply uniformly to chat specs and bookmark-origin specs once they have crossed into `tasks/specs/in-progress/`.
- Patch the task `**Spec:**` line from `in-progress/` to `done/` using the same atomic/idempotent description update path.

### AC8 — folder-agnostic lookup

Keep the feature-task lobster's current parsing model: `product_spec(task)` reads the exact `**Spec:**` line from the task description, and `safe_brain_spec_path` allows relative paths under `brain/`.

The key contract is that every move patches the task description in the same logical operation:

- `open/` → `in-progress/` patches the feature task immediately.
- `bookmarks/specs/` → `tasks/specs/in-progress/` creates or patches the bookmark-created task with the destination path.
- `in-progress/` → `done/` patches the feature task immediately.

If a move succeeds but a task patch fails, the next lobster run must detect the destination and finish the patch idempotently. That means each move helper should handle the “source absent, destination present, old `**Spec:**` line remains” case.

## Data model / state contract changes

- `brain/state/bookmark-review-state.json` already stores `approvalStatus` per bookmark item. No schema change is required for AC5.
- Existing `specDocs` values may change from `brain/bookmarks/specs/<file>.md` to `brain/tasks/specs/in-progress/<file>.md` after AC6. This is an existing field update, not a new field.
- Existing `taskIds` values remain unchanged.
- No new Tasks API fields are required.
- No new local state files are required.
- The task description `**Spec:**` line becomes the authoritative pointer for the feature-task lobster after every move.

## Workflow, cron, and skill changes

- No cron changes.
- No OpenClaw runtime config changes.
- Update `feature-task-create` and `tasks-create` skills so future chat-created feature specs are written under `brain/tasks/specs/open/`.
- Keep `spec-author` documentation on `brain/bookmarks/specs/`.
- The bookmark lobster remains the only mover from `bookmarks/specs/` into `tasks/specs/in-progress/`.
- The feature-task lobster remains the only mover from `tasks/specs/open/` to `in-progress/` and from `in-progress/` to `done/`.

## Test plan

Primary unit coverage should live with the code that owns the lifecycle:

- `agents/workflows/feature-task/src/main.rs` Rust unit tests, or a split module such as `agents/workflows/feature-task/src/spec_lifecycle.rs` with colocated tests. If the crate is later split into integration tests, use `agents/workflows/feature-task/tests/test_spec_lifecycle.rs`.
- Bookmark Python tests can be added under `agents/workflows/bookmarks/tests/test_spec_lifecycle.py` or, if no test package exists yet, a small pytest file next to existing bookmark workflow tests.

Required coverage:

1. **Layout bootstrap (AC1)**
   - Missing `open`, `in-progress`, and `done` directories are created.
   - Unexpected direct subdir under `brain/tasks/specs/` causes a loud error.
   - Re-running bootstrap is a no-op.
2. **Idempotent forward moves (AC4, AC6, AC7)**
   - Checked chat spec in `open/` moves to `in-progress/` and rewrites `**Spec:**`.
   - Approved bookmark spec moves to `tasks/specs/in-progress/` during task creation and rewrites/creates `**Spec:**`.
   - Done task moves `in-progress/` to `done/` and rewrites `**Spec:**`.
   - Re-running each move after destination exists is a no-op and still repairs stale `**Spec:**` lines.
3. **No reverse move (AC4)**
   - Unchecked marker on a spec already in `in-progress/` does not move it back to `open/`.
   - Reopened/done tasks do not move files out of `done/`.
4. **Folder-agnostic lookup (AC8)**
   - `spec_check` reads by the task `**Spec:**` path for `open/`, `in-progress/`, `done/`, and `bookmarks/specs/` paths.
   - After a move and patch, the next run resolves the new path without fallback scanning.
5. **Bookmark approval toggle (AC5)**
   - `approvalStatus: approved` toggles `- [ ] **Approved by Tom**` to `- [x] **Approved by Tom**` in `brain/bookmarks/specs/`.
   - Already checked is idempotent.
   - Toggle does not move the file.
   - Declined approval does not check the marker.

Suggested commands for implementation PR verification:

```bash
cargo test --manifest-path agents/workflows/feature-task/Cargo.toml spec_lifecycle
python3 -m pytest agents/workflows/bookmarks/tests/test_spec_lifecycle.py
```

If bookmark workflow tests do not yet use pytest, add a small stdlib `unittest` file and run it directly with `python3` instead of introducing a new dependency.

## Related work

- This spec supersedes `spec-archive-on-done` (task `c40ae956`, currently in `acceptance`). Its move-on-done behavior is preserved as AC7, but the eligible source folder becomes `brain/tasks/specs/in-progress/` rather than direct children of `brain/tasks/specs/`.
- Existing bookmark specs are not migrated. The product spec says the 78 existing bookmark specs remain in `brain/bookmarks/specs/` until each naturally crosses the approval-and-tasked gate.

## Open questions and risks

1. **Task Spec line patching concurrency.** If a lobster and a human both edit the task description, last write can win. Recommendation: patch by re-fetching the latest task, replacing only the exact old `**Spec:**` line, and retrying once on conflict. For file writes, use same-directory temp files plus `os.replace`/atomic rename.
2. **`os.rename` vs `git mv`.** Runtime lobsters should use `os.rename`/`Path.rename`/`fs::rename`; both source and destination live on the same machine/workspace, and the brain tree is not necessarily a git checkout. `git mv` is only useful in an implementation worktree, not as runtime workflow behavior.
3. **Bookmark specs that never cross the gate.** They stay indefinitely in `brain/bookmarks/specs/`. This is deliberate and keeps `brain/tasks/specs/open/` from filling with long-tail pipeline output.
4. **Existing direct files under `brain/tasks/specs/`.** AC1 only says the three lifecycle dirs are the only subdirs. If old direct files remain, the implementation should either leave them alone during rollout or have Quinn approve a one-time migration. Do not silently move them without task context.
5. **Move succeeded, API patch failed.** Each move helper must be repairable on the next run by recognizing “destination exists, source absent, `**Spec:**` still old path” and patching the task line.
6. **Multiple bookmark specs for one bookmark.** The current path derivation can produce `-part-<n>` files. AC6 should move each tasked spec independently and update state/task descriptions accordingly.
