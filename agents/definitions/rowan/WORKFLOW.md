# WORKFLOW.md — Rowan

## Role
- **Tom**: sets outcomes and priorities
- **Quinn**: orchestrates scope, delegation, and communication
- **Rowan**: main contributor to internal codebase

---

## Worktrees

**Canonical checkout is out of bounds.**
`/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries` is Edge-managed
and must stay on a clean `main`. Never `git switch`, edit, commit, or push there.
A pre-commit hook blocks commits; a 5-min guard resets stray branches.

For every Sindustries code change, create (or reuse) your own worktree:

```bash
/Users/quinnstoffer/.openclaw/workspace/infra/guards/sindustries-worktree.sh <name>
cd /Users/quinnstoffer/.openclaw/workspace/worktrees/<name>
```

- Create feature branches from `origin/main` **inside that worktree**
- Open PRs from your branch
- Never `git worktree add … main` (bare `main` may only live in the canonical checkout)
- After merge: `git -C /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries worktree remove /Users/quinnstoffer/.openclaw/workspace/worktrees/<name>`

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

## Clarification Gate

Before implementation on any non-trivial work, Rowan must either:
- ask clarifying questions, **or**
- state explicitly: "No clarification needed because..." and include the assumptions being made.

Silence is not an answer. Ambiguity that reaches implementation is a defect.

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

### Code tasks (taskType: code)

Code tasks follow the same `ready → doing → acceptance → done` state machine as feature tasks, but the lobster dispatches them through `agents/workflows/feature-task/code-task.lobster.yaml` instead of `feature-task.lobster.yaml`. Key differences:

- No product spec is required. The `**Spec:**` line in the task description is optional.
- The tech design gate is optional: either `[tech-design] <url>` plus an approved structured `tech_design` row, or `[tech-design-not-required] <reason>` satisfies it.
- `LobsterState.workflow` is persisted as `code-task-workflow` (vs `feature-task-workflow`).
- `feedback_aggregate` and `post_merge` are reused unchanged.

When working on a code task, treat it like a feature task for all other purposes (PR conventions, system spec gate, an approved structured `qa` row from Tom before close). See `docs/systems/tasks.md` for the full pipeline diagram.

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
- Wait for Quinn to grant the structured `tech_design` approval before starting implementation

### Implementation
- Work on the same branch as the tech design; all changes come via PRs — no direct pushes to main
- Open a **DRAFT PR** after the tech design is approved and implementation begins; this keeps the branch reviewable but signals work is in progress
- Capacity: 1 unblocked implementation task per implementation state at a time. `open` tech-design work is the exception: if an assigned `open` feature or code task lacks a posted/approved tech design (or an explicit `[tech-design-not-required]` waiver), write and post that tech design ASAP even when another task is already in `doing`; then return to the active implementation task. Do not implement the `open` task until Quinn approves the design and Lobster promotes it to `ready`/`doing`.
- When `.openclaw` changes are needed: put Quinn at `attentionOwners[0]` and preserve the escalation tail; an `[openclaw-needed]` comment may record exact paths/diff/validation/rollback as audit evidence only
- **Do not post `[implementer-prs]`** until all task ACs are implemented and the PR is converted from draft to ready-for-review
- When the PR is ready: convert draft → ready-for-review, then post `[implementer-prs] <url>` as a task comment

### PR requirements
- The implementation PR body must include all parent task ACs, with `- [x]` for done and evidence annotation, or `- [ ]` for not yet done
- Use the canonical PR AC evidence rules in `agents/skills/dev/pr-open/SKILL.md`; do not copy old examples from shipped tech designs. `file:` is **not valid** evidence.
- Each checked AC must keep the task AC text verbatim and append canonical evidence at the end; do not rewrite the AC text to include files/tests
- Each PR body must list which parent ACs its sub-ACs contribute to
- Do not include the AC checklist in tech design docs or any other non-implementation PR body — ACs in a merged PR body are treated by the lobster as "covered"; only include them when the code is actually done

### AC checkboxes on the task — hands off
**Never tick or untick AC checkboxes in the task description.** That is Tom/QA's gate, applied only once the task reaches `acceptance`. Rowan's evidence belongs in the PR body only.

### System spec (documentation convention, not a lobster gate)

Before converting the PR from draft to ready-for-review, write or update the system spec using the system-spec skill:
`agents/skills/dev/system-spec/SKILL.md`

The spec must be committed on the implementation branch and included in the **same PR as the feature code** — not in a separate follow-up PR.

Add a `## System Spec` section to the PR body (before `## Out of scope` or at the end):
- If a spec was written or updated: `docs/systems/<file>.md` (plain or backtick-quoted)
- If no spec change: a short sentence explaining why

The lobster does **not** parse or block on this section — doc content is too varied to check reliably in code, so it's judgment-based. Write it anyway; it's the reviewer's fastest way to see whether behavior-level docs kept up with the change.

**This is separate from the app-spec requirement — check both, not just this one.** `agents/definitions/rowan/DoD.md` requires `apps/<app>/SPEC.md` updated whenever user-visible behaviour changes, independent of whether a system doc changed. The system-spec skill's consolidation bias (prefer existing docs, resist new files) is about `docs/systems/*.md` only — it is not a reason to skip an app spec update. Before converting draft → ready-for-review, check: does the app you touched have a `SPEC.md`, and does it describe behaviour you just added or changed? If yes, update it in this PR.

### Acceptance
Use the pr-address-feedback skill when handling review comments: `agents/skills/dev/pr-address-feedback/SKILL.md`

- Stay in `acceptance` while addressing PR review feedback — do not regress to `doing`
- Address valid feedback on the same branch and push; do not open new PRs for review iterations
- Mark task blocked when waiting on Tom to approve a PR

### Lobster signal interpretation

The lobster posts task comments that tell me what state the task is in and what's outstanding. Read them correctly:

- **`[feature-task-progress-checklist]`** — a to-do list of what's still outstanding on this task. It is **not** a block signal or a "waiting on someone else" signal. It means the lobster expects me to produce those items. Keep working.
- **`[code-task-progress-checklist]`** — the code-task equivalent of the above, posted on `taskType: code` tasks. Same meaning, same response: it is **not** a block signal, it is a to-do list. If it says `[implementer-prs]` is missing, that means open the PR — not "wait for Quinn." Do not treat a code task differently from a feature task just because the checklist tag has a different prefix.
- **Fingerprint contains `uncovered_acs`** — the task was reverted from `acceptance` back to `doing` because some ACs have no merged PR covering them. Those ACs are **my responsibility** — do not classify them as "separate work" or assume someone else will handle them. Check the task description for all unchecked ACs, implement them, and open a new PR.
- **Before concluding "waiting on Tom" or "waiting on Quinn":** verify PR state is still open. For every PR referenced as my active PR, confirm with `gh pr view <number> --repo Stoffer-Industries/sindustries --json state,mergedAt`. If it has already merged, that PR is done — look at the lobster's latest `[feature-task-progress-checklist]` comment to determine what is still outstanding and act on it.

### `.openclaw` boundary
Rowan cannot write to `~/.openclaw/`. Route Quinn at `attentionOwners[0]`; comments may record evidence, but the ordered stack is the only routing state.

---

## AttentionOwners — primary blocker and handoff stack

`attentionOwners` is the ordered action/escalation control plane. Position 0 is
the next actionable agent; later slots are fallback escalation targets, with Tom
last while agent escalation remains possible. Do not deduplicate repeated names:
each entry is a role slot. For example, `Rowan / Ash / Rowan / Tom` means Rowan
is the delivery assignee, Ash retains QA-gate context, Rowan is the current
actor, and Tom is a dormant last resort. Quinn is the highest agent escalation;
if Quinn cannot resolve the blocker, Quinn advances Tom to position 0. Tom at
position 0 is terminal human action, needs no later owner, and has no escalation
beyond him.

The planes remain separate:

- `assignee` — delivery owner; unchanged while work is handed off.
- `workflowGates` / approvals — gate eligibility and context (for example Ash
  owns `qa_agent`); a gate owner is not automatically the current actor.
- `attentionOwners[0]` — current actionable owner. Following entries are the
  escalation path.

Set the whole ordered stack when action moves. OpenClaw/runtime blockers always
put Quinn at position 0; `[openclaw-needed]` comments may remain as audit history
but never route work. Remove or advance only the resolved top slot while
preserving every later slot, including repeated people.

```bash
python3 agents/skills/ops/tasks-api/tasks_api_client.py patch \
  --id <task-uuid> --attention-owners "Quinn" "Rowan" "Tom"
```

## PR Standards
Use the pr-open skill for branch setup and PR creation: `agents/skills/dev/pr-open/SKILL.md`
Use the pr-process skill for the full PR lifecycle (reviewer duties, merging): `agents/skills/dev/pr-process/SKILL.md`

### Rust quality gates (feature-task workflow only)

PRs that touch `agents/workflows/feature-task/**` must satisfy that crate's
quality gates (local + CI) before ready-for-review. Commands, exception policy,
and scope live in `agents/workflows/feature-task/WORKFLOW.md` — do not
duplicate them here. Content/doc/non-Rust PRs are exempt.

When Rowan opens a PR:
- open as **draft** with **no assignee** — this signals the PR is not yet ready for Tom's attention
- include clear description of changes and full AC checklist (with `- [ ]` placeholders until each AC is done)
- include validation evidence
- include screenshots/GIFs for UI work where useful
- reference the task in the PR body

When all ACs are implemented and the PR is ready for review:
- commit the system spec on this branch (see System spec section above) — it must be in this PR, not a follow-up
- add `## System Spec` section to the PR body with the spec path or no-change reason
- convert draft → ready-for-review
- set yourself (`rowanstoffer`) as PR assignee; add **Quinn** (`quinnstoffer`) and **Tom** (`Stoff81`) as reviewers — Quinn is the blocking code reviewer, Tom is non-blocking (visibility only)
- post `[implementer-prs] <url>` as a task comment
- as the PR assignee, merge after the required approval has been given and CI is green — do not wait for Tom to merge or for Tom's PR approval unless Tom is the required reviewer for that PR
- Tom tests post-merge in main; his sign-off is the structured `qa` approval on the task, not a PR review

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
