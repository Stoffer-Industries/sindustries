---
status: draft
task_id: ba116063-382a-446c-ab91-c01b60d9a7c3
product_spec: brain/tasks/specs/lobster-worktree-cleanup-on-merge-2026-07-07.md
shipped_pr: null
shipped_date: null
---

# Lobster worktree cleanup after merge — tech design

## Product spec link

- Product spec: `brain/tasks/specs/lobster-worktree-cleanup-on-merge-2026-07-07.md`
- Spec file was not present in this worktree; this design is derived from the task description and acceptance criteria.

## Product intent summary

Automatically remove Rowan feature worktrees after a task branch merges so stale worktrees do not accumulate. Cleanup must be idempotent and must not block the lobster from advancing the task to `done`.

## Task / branch / workstream

- Task ID: `ba116063-382a-446c-ab91-c01b60d9a7c3`
- Title: Lobster worktree cleanup after merge
- Branch: `task-ba116063-lobster-worktree-cleanup`
- Worktree: `/Users/quinnstoffer/workspaces/rowan/sindustries`
- Repository: `sindustries`
- Workstream: Rowan owns AC1–AC4.

## `.openclaw` boundary notes

Do not delete or mutate `~/.openclaw`. The feature may remove git worktrees under `~/workspaces/rowan/` only. If there are OpenClaw registry files outside the repo that also need pruning, that should be captured as a follow-up `[openclaw-needed]` request rather than handled in this PR.

## Implementation plan

1. Inspect the feature-task lobster post-merge path, likely `agents/workflows/feature-task/feature-task.lobster.yaml` and its referenced scripts.
2. Add a small cleanup helper in `agents/workflows/feature-task/scripts/` (or the existing post-merge script if one exists) that:
   - obtains the task id and branch name from the lobster context/task comments,
   - enumerates `git worktree list --porcelain`,
   - selects registered worktrees whose path is under `/Users/quinnstoffer/workspaces/rowan/` or `~/workspaces/rowan/` and whose branch/path matches `task-<task-id>*`,
   - runs `git worktree remove --force <path>` for each match.
3. Treat missing directories or absent matching worktrees as success.
4. Catch cleanup failures, emit a warning with task id/path/branch, and allow the post-merge transition to continue.
5. Keep cleanup after PR merge confirmation and before/around the existing task `done` transition.
6. Update `docs/systems/feature-task-workflow.md` or create a system note on ship if no durable workflow doc exists.

## Data model / API contract changes

No Tasks API schema changes. No task comments are required beyond existing lobster state/progress comments. The cleanup derives state from existing task id/branch/worktree naming conventions and local git worktree metadata.

## Workflow, cron, and skill changes

- Feature-task lobster post-merge stage gains best-effort worktree cleanup.
- No cron changes.
- No AgentSkill changes expected unless a feature-task workflow skill/doc already documents cleanup responsibilities.

## Test plan

- Unit-test the selection helper against sample `git worktree list --porcelain` output.
- Unit-test idempotency: no matching worktree and missing path both return success.
- Unit-test failure handling: simulated `git worktree remove --force` error logs a warning and returns non-fatal result.
- Run existing feature-task workflow tests if present.
- Manual dry-run with a temporary worktree matching `task-<id>*`; verify it is removed and unrelated worktrees remain.

## Open questions / risks

- Risk: matching by path/branch too broadly could remove an active worktree. Mitigation: require both Rowan workspace root and task-id pattern.
- Risk: worktree registry can contain stale entries where path is already gone. Mitigation: handle as non-fatal and consider `git worktree prune` only as a separate explicit follow-up.
