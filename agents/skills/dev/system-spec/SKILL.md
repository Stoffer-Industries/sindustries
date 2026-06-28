---
name: system-spec
description: "Create or update durable system specifications for shipped feature work."
---

# System Spec

Use this skill when a feature changes durable system behavior, data contracts, workflow orchestration, cron behavior, or operational ownership.

**Default: update an existing spec.** Check `docs/systems/` first. If this task's changes belong to an existing system, update that file. Only create a new `docs/systems/<name>.md` when the work introduces a genuinely new system or subsystem with no natural home in an existing doc. Prefer fewer, broader specs over per-feature proliferation.

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
