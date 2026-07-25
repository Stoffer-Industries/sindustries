---
name: system-spec
description: "Create or update durable system specifications for shipped feature work."
---

# System Spec

Use this skill when a feature changes durable system behavior, data contracts, workflow orchestration, cron behavior, or operational ownership.

Read [`docs/CONVENTIONS.md`](../../../../docs/CONVENTIONS.md) for the full doc taxonomy before writing or updating.

**Default: update an existing spec.** Check `docs/systems/` first. If this task's changes belong to an existing system, update that file. Only create a new `docs/systems/<name>.md` when the work introduces a genuinely new system or subsystem with no natural home in an existing doc. Prefer fewer, broader specs over per-feature proliferation.

**Consolidation bias — read before creating a new file.** System docs are intentionally high-level and cross-cutting. They are NOT per-feature or per-workflow documents. If a candidate new doc would overlap with one or more existing `docs/systems/*.md` files in subject matter, it belongs as a section in the existing doc, not a new file.

**Self-check before creating a new file.** Answer ALL of these with "yes" — if any answer is "no", update an existing doc instead:

1. Does the new doc cover subject matter that no existing `docs/systems/*.md` covers?
2. Will the new doc remain authoritative for ≥ 2 future changes (not just this one)?
3. Does the new doc describe a system boundary or operational surface (not a per-feature workflow detail)?

Per-workflow, per-feature, per-channel, per-component, or per-subsystem detail belongs inside the matching system doc, not in a new file. Examples that have been rejected as new system docs:

- `content-scheduler-auto-post.md` — merged into `docs/systems/content-scheduler.md` because it was a subsystem of the Content Scheduler, not a separate system.
- `feature-task-workflow.md`, `code-task-workflow.md`, `task-tracking.md`, `tasks-api.md` — merged into `docs/systems/tasks.md` because they were all views of the same data plane + workflow surface.

If you genuinely need to create a new doc and the self-check passes, also do a structural review: does the doc have the canonical required sections? See below.

Create or update `docs/systems/<system>.md`.

Record:

- Architecture and ownership
- Runtime behavior and operational flow
- Data contracts, task comments, tags, and API fields
- Runbook notes and common failure modes
- Related specs, tasks, and PRs

Post the task comment:

`[system-spec] docs/systems/<system>.md`

For code-only changes that do not alter system behavior, post a specific bypass reason:

`[no-system-spec-change] <reason>`