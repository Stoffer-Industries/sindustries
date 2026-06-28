# Task Dependencies

**Type:** System reference
**Last updated:** 2026-06-28
**Owner:** Rowan
**Repos:** `Stoffer-Industries/sindustries`
**Related task:** `456c92a8-835f-453e-a1ef-5ed5a31844f2` ("Add Blocked by reference")
**Related PR:** https://github.com/Stoffer-Industries/sindustries/pull/128

---

## Purpose

Task dependencies let one task explicitly depend on one or more other tasks through first-class data. This replaces description-only conventions such as "Blocked by:" when automation or UI needs to know whether a task is blocked by unfinished work.

Manual blocking and dependency blocking are separate signals:

- `blocked`: manually set by humans or workflow automation.
- `dependencyBlocked`: computed from dependency state and true when any referenced dependency task is not `done`.

A task is visibly blocked when either signal is true.

---

## Data Model

Dependencies are stored in `services/tasks-api` with the `TaskDependency` join model:

- `taskId`: the task that is blocked by another task.
- `dependsOnId`: the task that must finish first.
- `createdAt`: creation timestamp.

The table uses a composite primary key on `(taskId, dependsOnId)` and cascades deletes from either side. An index on `dependsOnId` supports reverse lookups.

`Task` has two Prisma relations:

- `dependencies`: tasks this task depends on.
- `dependedOnBy`: tasks that depend on this task.

---

## API Contract

Task list and detail responses include:

- `dependsOn`: array of dependency references with `id`, `title`, `status`, and `completedAt`.
- `dependsOnIds`: array of dependency task IDs derived from `dependsOn`.
- `dependencyBlocked`: boolean, true when any dependency reference has `status !== "done"`.

`PATCH /tasks/:id` accepts `dependsOnIds`:

- Array of UUID strings replaces the full dependency set.
- Empty array clears all dependencies.
- Omitted field leaves dependencies unchanged.

Validation rejects:

- Non-array or non-UUID payloads.
- Self-dependencies.
- Missing dependency task IDs.
- Archived dependency tasks.
- Direct circular dependencies where A depends on B and B depends on A.

Deep cycle detection is out of scope for the initial implementation.

---

## UI Behavior

The tasks app treats a task as blocked when:

```text
task.blocked || task.dependencyBlocked
```

The task card and detail surfaces can use `dependsOn` and `dependsOnIds` without re-querying dependency metadata. Dependency management UI is delivered separately by the task dependency UI workstream.

---

## Automation And CLI

`agents/skills/ops/tasks-api/tasks_api_client.py` exposes dependency operations for automation:

- `--depends-on <id>` may be repeated to set dependency IDs.
- `--clear-dependencies` clears dependency IDs.
- The two flags are mutually exclusive.

The client prints `dependsOn`, `dependsOnIds`, and `dependencyBlocked` from task list/get responses, so heartbeat and Lobster workflows can inspect dependency state without parsing task descriptions.

---

## Operational Notes

- Existing tasks without dependencies return empty `dependsOn` / `dependsOnIds` and `dependencyBlocked: false`.
- Dependency blocking does not mutate the stored `blocked` field.
- Human-readable task descriptions may still mention dependency context, but workflow decisions should use the API fields.
- If a dependency task is archived, new references to it are rejected. Existing references are removed by cascade if the task is deleted.
- When PR comments or task comments disagree about a task's active implementation PR, prefer the latest task comment plus the task workstream PR field. For task `456c92a8`, PR #120 was the original merged/reverted implementation; PR #128 is the active delivery PR.

---

## Common Failure Modes

- **Stale task comments mention an old PR.** Re-read the latest task comments before routing feedback. Lobster state may retain old `prUrls`; current task comments and workstream fields are the source of truth.
- **Dependency appears blocked but `blocked` is false.** Check `dependencyBlocked`; this is expected when an unfinished dependency exists.
- **PATCH rejects a dependency update.** Inspect the error code for self-reference, archived dependency, missing task ID, invalid UUID payload, or direct circular dependency.
- **UI does not show dependency blocking.** Confirm the API response includes `dependencyBlocked` and the UI uses `blocked || dependencyBlocked`.

