---
name: tech-design
description: "Create approved implementation tech designs for feature tasks."
---

# Tech Design

Use this skill when a feature task needs a design before Rowan starts implementation.

Read [`docs/CONVENTIONS.md`](../../../../docs/CONVENTIONS.md) for the full doc taxonomy and required frontmatter before writing.

Write the design to `docs/specs/<task-slug>-tech-design.md`.

Include:

- Product spec link
- Task ID, task title, branch, worktree, and repository names
- `.openclaw` boundary notes for work that must be handled outside this repo
- Implementation plan with file/module scope
- Data model or API contract changes
- Workflow, cron, and skill changes
- Test plan
- Open questions and risks

After writing the design, post the durable task comment:

`[tech-design] <repo URL or local path>`

Quinn approves tech designs as part of heartbeat. After reading the design at the linked path, post the durable task comment:

`[tech-design-approved] true`

Quinn should review the design for: completeness (all required sections present), alignment with the product spec, no unbounded scope, `.openclaw` boundary notes where relevant. If anything looks wrong or risky, flag to Tom instead of approving.
