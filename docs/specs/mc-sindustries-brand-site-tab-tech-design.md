---
status: draft
task_id: 77a28087-b05c-4a49-808c-84f9c4d2ea9c
product_spec: brain/tasks/specs/mc-sindustries-brand-tab-2026-07-07.md
shipped_pr: null
shipped_date: null
---

# SIndustries brand site tab in Mission Control — tech design

## Product spec link

- Product spec: `brain/tasks/specs/mc-sindustries-brand-tab-2026-07-07.md`
- Spec file was not present in this worktree; this design is derived from the task description and acceptance criteria.

## Product intent summary

Add `sindustries.co.nz` as a Mission Control tab for quick internal access, rendering in an iframe when allowed and showing a graceful fallback link when embedding is blocked.

## Task / branch / workstream

- Task ID: `77a28087-b05c-4a49-808c-84f9c4d2ea9c`
- Title: SIndustries brand site tab in Mission Control
- Branch: `task-77a28087-mc-sindustries-brand-tab`
- Worktree: `/Users/quinnstoffer/workspaces/rowan/sindustries`
- Repository: `sindustries`
- Workstream: Rowan owns AC1–AC3.

## `.openclaw` boundary notes

None expected. Do not change deployment headers or external site config in this task unless repo-owned config already controls them; iframe blocking must be handled as UI fallback.

## Implementation plan

1. Add `SIndustriesTab.jsx` under `apps/mission-control/src/tabs/`.
2. Register it in `pulseTabs.js` at `/sindustries` with a clear label/icon.
3. Render an iframe with `src="https://sindustries.co.nz"`, title, sandbox/referrer attributes only if they do not break basic display.
4. Add a load timeout/error heuristic: if iframe does not load or is likely blocked, show a fallback card with an external link opening in a new tab.
5. Keep styling token-based for light/dark Mission Control shell.
6. Update `apps/mission-control/SPEC.md` on ship.

## Data model / API contract changes

No backend/API changes.

## Workflow, cron, and skill changes

No workflow/cron/skill changes. This task uses existing Mission Control tab registry only.

## Test plan

- Component test renders iframe with correct title/src and fallback link.
- Test fallback path by simulating load timeout/error state.
- App route test that `/sindustries` selects the tab.
- Run Mission Control tests/build.

## Open questions / risks

- Some sites block iframe embedding via `X-Frame-Options` or CSP. The AC explicitly allows a fallback link, so do not attempt to bypass headers.
