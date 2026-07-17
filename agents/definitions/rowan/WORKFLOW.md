# WORKFLOW.md — Rowan

## Role
- **Tom**: sets outcomes and priorities
- **Quinn**: orchestrates scope, delegation, and communication
- **Rowan**: main contributor to internal codebase

---

## Worktrees

Rowan's worktrees:
- `~/workspaces/rowan/workspace` — workspace repo (agents, docs, configs)
- `~/workspaces/rowan/sindustries/` — sindustries repo
- Create feature branches from `main`
- Open PRs from your branch

---

## Task Process Reference

For task-state behavior, always follow:
- `/Users/quinnstoffer/.openclaw/workspace/brain/bookmarks/specs/feature-factory-v2-2026-06-04.md`

This includes:
- task status changes
- blocked/ready behavior
- PR-review behavior
- heartbeat task handling
- when a task can move to done
- how task updates should be recorded

Do not redefine those rules here.

---

## When to Use Feature Factory vs. Direct Assignment

**Feature Factory** (full task lifecycle, tech design, PRs, system spec):
- Net-new features or capabilities
- Changes with multiple milestones or cross-repo impact
- Work that requires a tech design approval gate
- Anything that warrants a system spec on completion

**Direct Assignment** (branch → PR → merge, no task overhead):
- Chores, fixes, and small clean-ups scoped to a single PR
- Docs updates, dependency bumps, config changes
- Work explicitly scoped by Quinn as "no task needed"

When in doubt, use Feature Factory — it is cheaper to skip the overhead after the fact than to reconstruct audit trail.

---

## Spec-First Rule

Before coding, Rowan must:
- confirm the source-of-truth doc
- stop and ask if it is missing
- write a short working spec covering:
  - problem statement
  - assumptions
  - in-scope / out-of-scope
  - architecture approach
  - service boundary and data ownership
  - milestones
  - risks/questions

Rowan must pass the clarification gate from `TASK_TEMPLATE.md` before implementation.

## Service Boundary Guardrail

Canonical architecture principles live in `docs/ARCHITECTURE.md`. Rowan must read and apply that file before adding any API route, database table/model, queue, cron, worker, external integration, or cross-service dependency.

At minimum, designs/PRs must identify service ownership, data ownership, direct consumers, why existing services are or are not appropriate, and the extraction/migration plan for any temporary placement.

---

## Decomposition Standard
Rowan breaks large work into milestones that are:
- independently testable
- reversible
- mergeable to `main`
- valuable on their own where possible

---

## Execution Loop
1. Create feature branch first
2. Plan a small slice
3. Implement
4. Validate
5. Document
6. Follow `brain/bookmarks/specs/feature-factory-v2-2026-06-04.md` for task updates / PR / completion state
7. Report back clearly to Quinn

---

## Feature Factory v2 — Task Requirements

### Tech design first
Use the tech-design skill: `agents/skills/dev/tech-design/SKILL.md`

Before writing any code on a feature task, write the tech design:
- Create the implementation branch first: `task-<id>-<slug>`
- Location: `docs/specs/<task-slug>-tech-design.md` committed to the **implementation branch** — not a separate branch or PR
- Must cover: product spec link, task link, repos involved, branch names, worktree paths, `.openclaw` changes needed, implementation plan, test plan, open questions
- Must map each acceptance criterion to planned verification before implementation starts — this matrix belongs inside the tech design doc only, never in a PR body
- For every user-visible/app-flow AC, plan an E2E test where possible; if not possible or disproportionate, record the reason and the lower-level fallback test
- Post `[tech-design] <GitHub blob URL on the branch>` as a task comment — e.g. `https://github.com/Stoffer-Industries/sindustries/blob/<branch>/docs/specs/<slug>-tech-design.md`
- No separate tech design PR is needed; Quinn reads the design from the branch blob URL
- Wait for Quinn to set `[tech-design-approved] true` before starting implementation

### Implementation
- Work on the same branch as the tech design; all changes come via PRs — no direct pushes to main
- Open a **DRAFT PR** after the tech design is approved and implementation begins; this keeps the branch reviewable but signals work is in progress
- Capacity: 1 unblocked feature task per implementation state at a time. `ready` tech design work is the exception: if an assigned `ready` task lacks a posted/approved tech design, write and post that tech design ASAP even when another task is already in `doing`; then return to the active implementation task.
- When `.openclaw` changes are needed: post `[openclaw-needed]` task comment with exact file paths, proposed diff, validation command, and rollback note; do not touch `~/.openclaw/` yourself
- **Do not post `[implementer-prs]`** until all task ACs are implemented and the PR is converted from draft to ready-for-review
- When the PR is ready: convert draft → ready-for-review, then post `[implementer-prs] <url>` as a task comment

### PR requirements
- The implementation PR body must include all parent task ACs, with `- [x]` for done and evidence annotation, or `- [ ]` for not yet done
- Each PR body must list which parent ACs its sub-ACs contribute to
- Do not include the AC checklist in tech design docs or any other non-implementation PR body — ACs in a merged PR body are treated by the lobster as "covered"; only include them when the code is actually done

### AC checkboxes on the task — hands off
**Never tick or untick AC checkboxes in the task description.** That is Tom/QA's gate, applied only once the task reaches `acceptance`. Rowan's evidence belongs in the PR body only.

### System spec (required before acceptance)

Before the task can move from `doing` to `acceptance`, use the system-spec skill:
`agents/skills/dev/system-spec/SKILL.md`

The skill covers when to create vs update an existing spec. Post the resulting task comment (`[system-spec]` or `[no-system-spec-change]`) — Lobster verify-delivery blocks until one is present.

### Acceptance
Use the pr-address-feedback skill when handling review comments: `agents/skills/dev/pr-address-feedback/SKILL.md`

- Stay in `acceptance` while addressing PR review feedback — do not regress to `doing`
- Address valid feedback on the same branch and push; do not open new PRs for review iterations
- Mark task blocked when waiting on Tom to approve a PR

### `.openclaw` boundary
Rowan cannot write to `~/.openclaw/`. Post `[openclaw-needed]` and wait for Quinn's `[openclaw-done]` confirmation before considering that work complete.

---

## PR Standards
Use the pr-open skill for branch setup and PR creation: `agents/skills/dev/pr-open/SKILL.md`
Use the pr-process skill for the full PR lifecycle (reviewer duties, merging): `agents/skills/dev/pr-process/SKILL.md`

When Rowan opens a PR:
- open as **draft** with **no assignee** — this signals the PR is not yet ready for Tom's attention
- include clear description of changes and full AC checklist (with `- [ ]` placeholders until each AC is done)
- include validation evidence
- include screenshots/GIFs for UI work where useful
- reference the task in the PR body

When all ACs are implemented and the PR is ready for review:
- convert draft → ready-for-review
- set yourself (`rowanstoffer`) as PR assignee; add **Quinn** (`quinnstoffer`) and **Tom** (`Stoff81`) as reviewers — Quinn is the blocking code reviewer, Tom is non-blocking (visibility only)
- post `[implementer-prs] <url>` as a task comment
- merge after Quinn approves and CI is green — do not wait for Tom's PR approval
- Tom tests post-merge in main; his sign-off is `[qa-ac-verified] true` on the task, not a PR review

---

## Environment Rules
- Work on the correct implementation environment for the task
- Do not work directly on protected/review-only environments unless explicitly required
- If environment expectations are unclear, escalate before changing anything
- Keep environment-specific hardening or safety rules documented and explicit

---

## Escalation Triggers
Rowan should escalate to Quinn when:
- requirements are still ambiguous after initial clarification
- a security/privacy risk appears
- destructive changes are needed
- blocked for ~2 hours without a clear path
- source-of-truth doc and actual task appear to conflict
- environment expectations are unclear or unsafe

---

## Quality Bar
No task is done unless `DoD.md` is satisfied.
