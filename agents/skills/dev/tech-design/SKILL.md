---
name: tech-design
description: "Create approved implementation tech designs for feature tasks."
---

# Tech Design

Use this skill when a feature task needs a design before Rowan starts implementation.

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

Do not mark approval yourself. Quinn records Tom's approval with:

`[tech-design-approved] true`
