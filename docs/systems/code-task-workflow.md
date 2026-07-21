# Code Task Workflow

**Type:** System reference
**Last updated:** 2026-07-22
**Owner:** Rowan
**Repos:** `Stoffer-Industries/sindustries`

---

## Purpose

Code tasks track implementation work that changes existing code without adding a new product capability. They cover bug fixes, security hardening, maintenance, refactors, migrations, dependency work, and architecture/service-boundary corrections.

They are lighter than feature tasks: no product spec is required. They still need enough design and review to keep risky code changes visible.

---

## Pipeline

Code tasks flow through a simplified lobster pipeline that skips the product spec machinery entirely:

```
open ──────→ ready ──────→ doing ──────→ acceptance ──────→ done
  ↓             ↓             ↓              ↓
blocked      blocked      in-flight      blocked (PR review)
  ↓             ↓             ↓              ↓
code-task-   code-task-   code-task-     code-task-
ready-       ready-       verify-        verify-
checks       checks       delivery       delivery
```

The lobster dispatches `taskType: code` tasks through `agents/workflows/feature-task/code-task.lobster.yaml`. The same Rust binary that runs the feature-task pipeline is reused; the YAML selects a smaller set of subcommands.

### Stage mapping

| Code-task stage | Feature-task stage | Difference |
|---|---|---|
| `code-task-ready-checks` | `ready_checks` + `spec_check` | Spec machinery removed; tech design gate is optional (`[tech-design]` + `[tech-design-approved] true` **or** `[tech-design-not-required] <reason>`) |
| `code-task-verify-delivery` | `verify_delivery` | Spec drift check removed; no `specChecksum` writes |
| `feedback_aggregate` | `feedback_aggregate` | Reused unchanged |
| `post_merge` | `post_merge` | Reused unchanged; `archive_done_task_spec()` no-ops when no `**Spec:**` is present |

### `LobsterState.workflow`

Code-task state comments persist `workflow: "code-task-workflow"` in the `[lobster-state]` block (versus `"feature-task-workflow"` for feature tasks). `agents/workflows/feature-task/src/main.rs::workflow_for_task` picks the right value from `task.taskType` on every read so the two pipelines stay distinguishable on re-runs.

Progress-checklist comments use `[code-task-progress-checklist]` and `[code-task-blocked]` tags (versus `[feature-task-progress-checklist]` and `[feature-task-blocked]`).

---

## When to use a code task

Use `taskType: code` when the work:

- produces a PR that should be tracked;
- fixes or changes existing code with no new product capability;
- is too large/risky for direct assignment or code-garden;
- comes from a repo audit finding that is important but not code-garden-safe.

Examples:

- security hardening in an existing service;
- extracting misplaced backend code into the right service;
- database migration/backfill refactors;
- dependency upgrades with behavior or security implications;
- correctness fixes that change observable behavior but do not add a new capability.

Do not use a code task for:

- net-new user/product capability — use `feature`;
- investigation with no implementation PR yet — use `research`;
- tiny one-turn chores that do not need tracking;
- behavior-preserving cleanup that fits code-garden.

---

## Required task shape

A code task must include:

- short problem statement;
- source link if created from an audit finding;
- why it is not code-garden-safe, when applicable;
- observable acceptance criteria;
- assignee and relevant tags.

A product spec is not required.

---

## Tech design requirement

A tech design is required for a code task when the work touches any of these:

- service boundaries or ownership;
- data ownership, migrations, backfills, or deletion risk;
- security posture, auth/authz, secrets, credentials, or external integrations;
- cross-service API contracts;
- substantial internal architecture/refactor decisions;
- runtime/language choices.

The tech design lives at `docs/specs/<slug>-tech-design.md` and is linked from the task via `[tech-design] <path-or-url>`.

Tech designs for code tasks do not require Tom product sign-off by default. Escalate for Tom/Quinn sign-off when the design involves security risk, data-loss risk, user-visible behavior changes, new external credentials, or architecture decisions that need human judgement.

---

## Audit follow-up ledger

Repo audit findings should remain traceable in the audit document.

When an audit finding is important but not code-garden-safe:

1. Create the correct task type (`code`, `feature`, or `research`).
2. Link the task from the audit finding line.
3. Add a tech design if required.
4. When the implementation PR lands, update the same audit line with the PR link.

Ledger format:

```md
### [High] Example finding title ➡️ Tracked by task `abcd1234` (`abcd1234-...`)
```

After implementation:

```md
### [High] Example finding title ➡️ Tracked by task `abcd1234` (`abcd1234-...`) ✅ [PR #234](https://github.com/Stoffer-Industries/sindustries/pull/234)
```

If the task is created during the weekly audit, include the task link in the audit PR. If the task is created later, open a tiny docs-only audit-ledger PR to add the task link.

---

## Relationship to code garden

Code garden is intentionally narrow: functionally equivalent cleanup only. Do not relax code-garden to pick up security, behavior, migration, data ownership, or architecture work.

Use a code task when a finding is valuable but not garden-safe.

---

## Completion

A code task implementation PR should:

- reference the task ID;
- list the task ACs and evidence;
- include validation results;
- update relevant `docs/systems/` docs, or include `[no-system-spec-change] <reason>`;
- update the source audit ledger line if the task came from an audit.

## Tasks using this workflow

- [`f77b7a60-225c-445c-b3d9-042e38a86cde`](https://github.com/Stoffer-Industries/sindustries/pull/276) — initial implementation of the code-task lobster extension (this doc was authored as part of that task's deliverable).
