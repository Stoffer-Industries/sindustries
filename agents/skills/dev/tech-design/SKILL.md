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
- Ownership boundary check:
  - Identify the natural source of truth for the feature: UI-local state, API-owned resource, database-backed domain data, shared package/cross-app contract, or workflow/cron/skill/OpenClaw boundary.
  - Keep Rowan's incremental delivery posture: prefer small, mergeable cuts when they reduce risk, uncertainty, review size, or delivery time.
  - If the durable API/db/shared-package/workflow solution is about as easy as an interim shim, design the durable boundary now instead of creating avoidable migration work.
  - If choosing an interim local/client shim, explain the specific risk, time, or scope reduction that justifies it and name the follow-up boundary if known.
- Data model or API contract changes
- Workflow, cron, and skill changes
- Test plan with an AC-by-AC verification matrix
  - User-visible/app-flow ACs should plan E2E coverage where possible
  - If E2E is not possible or is disproportionate, record why and name the fallback test layer (`file`, unit, component, integration, or manual)
- Open questions and risks

**The AC verification matrix belongs inside this doc only.** Do not include the AC checklist (`- [x] AC1: ...`) in the PR body of the tech design or any other non-implementation PR — the lobster treats ACs appearing in a merged PR body as "covered by implementation", so listing them in a docs-only commit creates a false signal.

After committing the design to the branch, post the durable task comment pointing to the branch blob URL:

`[tech-design] https://github.com/Stoffer-Industries/sindustries/blob/<branch>/docs/specs/<slug>-tech-design.md`

Quinn approves tech designs as part of heartbeat. After reading the design at the linked path, grant the structured approval with Quinn's scoped service credential:

`TASKS_API_APPROVAL_TOKEN="$QUINN_TASKS_API_APPROVAL_TOKEN" TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 agents/skills/ops/tasks-api/tasks_api_client.py approve --id <task-id> --type tech_design`

The API derives Quinn's identity and creates the ordinary audit comment atomically. Never post `[tech-design-approved] true`; approval comments are retired and cannot satisfy the gate.

Quinn should review the design for: completeness (all required sections present), alignment with the product spec, no unbounded scope, `.openclaw` boundary notes where relevant. If anything looks wrong or risky, flag to Tom instead of approving.
