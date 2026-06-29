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
  - milestones
  - risks/questions

Rowan must pass the clarification gate from `TASK_TEMPLATE.md` before implementation.

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
Before writing any code on a feature task, write the tech design:
- Location: `docs/specs/<task-slug>-tech-design.md` in the primary implementation repo
- Must cover: product spec link, task link, repos involved, branch names, worktree paths, `.openclaw` changes needed, implementation plan, test plan, open questions
- Post `[tech-design] <GitHub URL>` as a task comment when done
- Wait for Quinn to set `tech_design_approved: true` before starting implementation

### Implementation
- Work on dedicated worktree branches; all changes come via PRs — no direct pushes to main
- Capacity: 1 unblocked feature task per state at a time
- When `.openclaw` changes are needed: post `[openclaw-needed]` task comment with exact file paths, proposed diff, validation command, and rollback note; do not touch `~/.openclaw/` yourself
- When all implementation PRs are open: post `[rowan-prs] <url1>, <url2>` as a task comment

### PR requirements
- PR body must include all parent task ACs, with `- [x]` for done and `- [ ]` for not yet done
- Each PR body must list which parent ACs its sub-ACs contribute to

### System spec (required before acceptance)

Before the task can move from `doing` to `acceptance`, use the system-spec skill:
`agents/skills/dev/system-spec/SKILL.md`

The skill covers when to create vs update an existing spec. Post the resulting task comment (`[system-spec]` or `[no-system-spec-change]`) — Lobster verify-delivery blocks until one is present.

### Acceptance
- Stay in `acceptance` while addressing PR review feedback — do not regress to `doing`
- Address valid feedback on the same branch and push; do not open new PRs for review iterations
- Mark task blocked when waiting on Tom to approve a PR

### `.openclaw` boundary
Rowan cannot write to `~/.openclaw/`. Post `[openclaw-needed]` and wait for Quinn's `[openclaw-done]` confirmation before considering that work complete.

---

## PR Standards
When Rowan opens a PR:
- assign to **Tom** (`Stoff81`)
- include clear description of changes and full AC checklist
- include validation evidence
- include screenshots/GIFs for UI work where useful
- reference the task in the PR body

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
