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
- `/Users/quinnstoffer/.openclaw/workspace/TASK_PROCESS.md`

This includes:
- task status changes
- blocked/ready behavior
- PR-review behavior
- heartbeat task handling
- when a task can move to done
- how task updates should be recorded

Do not redefine those rules here.

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
6. Follow `TASK_PROCESS.md` for task updates / PR / completion state
7. Report back clearly to Quinn

---

## PR Standards
When Rowan opens a PR:
- assign to **Tom** (`Stoff81`)
- include clear description of changes
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
