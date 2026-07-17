---
name: tech-design
description: "Create approved implementation tech designs for feature tasks."
---

# Tech Design

Use this skill when a feature task needs a design before Rowan starts implementation.

Read [`docs/CONVENTIONS.md`](../../../../docs/CONVENTIONS.md) for the full doc taxonomy and required frontmatter before writing.

Write the design to `docs/specs/<task-slug>-tech-design.md` **on the implementation branch** — no separate branch or PR is needed for the tech design.

Include:

- Product spec link
- Task ID, task title, branch, worktree, and repository names
- `.openclaw` boundary notes for work that must be handled outside this repo
- Implementation plan with file/module scope
- Data model or API contract changes
- Workflow, cron, and skill changes
- Test plan with an AC-by-AC verification matrix
  - Default: plan a Playwright E2E test for every user-visible/app-flow AC; note the planned test description so it becomes the `(testID: <id>)` evidence in the PR
  - If E2E is genuinely not possible or disproportionate, state why explicitly and name the fallback (unit, component, integration, or manual) — this becomes `(not tested: <reason>)` evidence; do not use `(file: ...)` as evidence in PR bodies
- Open questions and risks

**The AC verification matrix belongs inside this doc only.** Do not include the AC checklist (`- [x] AC1: ...`) in the PR body of the tech design or any other non-implementation PR — the lobster treats ACs appearing in a merged PR body as "covered by implementation", so listing them in a docs-only commit creates a false signal.

After committing the design to the branch, post the durable task comment pointing to the branch blob URL:

`[tech-design] https://github.com/Stoffer-Industries/sindustries/blob/<branch>/docs/specs/<slug>-tech-design.md`

Quinn approves tech designs as part of heartbeat. After reading the design at the linked path, post the durable task comment:

`[tech-design-approved] true`

Quinn should review the design for: completeness (all required sections present), alignment with the product spec, no unbounded scope, `.openclaw` boundary notes where relevant. If anything looks wrong or risky, flag to Tom instead of approving.
