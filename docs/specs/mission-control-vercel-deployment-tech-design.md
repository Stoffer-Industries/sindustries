---
status: approved
task_id: 9a53b122-6c0b-4f59-b191-2247b3657ae3
product_spec: brain/tasks/specs/in-progress/mission-control-cloud-deployment.md
shipped_pr: null
shipped_date: null
---

# Mission Control Vercel deployment tech design

## Delivery context

- **Task:** `9a53b122-6c0b-4f59-b191-2247b3657ae3` — Mission Control Cloud Deployment
- **Branch:** `mission-control-vercel`
- **Worktree:** `workspace/worktrees/mission-control-vercel`
- **Repository:** `Stoffer-Industries/sindustries`
- **Supersedes:** the Fly frontend placement introduced by PR #565

## Product intent

Mission Control and its independently deployed Tasks iframe must be reachable at stable HTTPS staging URLs without depending on the Mac mini. Mission Control must point at the cloud-hosted staging Tasks API, expose a meaningful static-host health signal, and retain independent rollback for the shell and Tasks app.

## Ownership and platform boundary

Mission Control and Tasks are static Vite SPAs, so Vercel is their natural runtime owner. They remain separate Vercel projects because the iframe boundary is also the independent deployment and rollback boundary. Fly remains the owner of request-serving APIs and long-running workers; the staging Tasks API URL is therefore a build-time input, not a frontend-owned runtime.

The repository owns reproducible Vercel build configuration next to each app at `apps/<app>/vercel.json`. Each Vercel project sets its Root Directory to the matching app directory, while Vercel's monorepo checkout retains access to the root lockfile and shared workspace packages. Vercel owns releases, stable project URLs, preview deployments, and rollback. The two SPA bundles own only public build-time URLs; no private credential is embedded in either bundle.

## `.openclaw` boundary

Project creation, Vercel authentication, optional custom-domain assignment, and protected provider credentials live outside this repository. The deployment operator performs those actions through the authenticated Vercel CLI or provider UI. No Vercel credential, Tasks API credential, or other secret is committed or passed as a Vite build variable.

## Implementation plan

1. Add one Vercel config next to each frontend. Project Root Directories are `apps/mission-control` and `apps/tasks`; Vercel's monorepo install keeps npm workspace dependencies and the root lockfile authoritative.
2. Preserve the two-project iframe architecture:
   - `sindustries-mission-control-staging`
   - `sindustries-tasks-app-staging`
3. Bake the stable public URL contract into each deployment:
   - Mission Control: `VITE_TASKS_API_BASE_URL`, `VITE_TASKS_APP_URL`
   - Tasks app: `VITE_TASKS_API_BASE_URL`, `VITE_SHELL_ORIGIN`
4. Replace the obsolete Fly-specific frontend Dockerfiles, Fly app specs, nginx config, and env examples. Fly assets for APIs and workers remain unchanged.
5. Remove `apps/tasks/pnpm-lock.yaml`. The repository is npm-managed, and Vercel otherwise gives the nearer stale pnpm lockfile precedence over the active npm lockfile, producing a different dependency graph and a failed shared-package CSS import.
6. Update the Mission Control system document and add a structural CI test that rejects reintroduction of the retired Fly frontend artefacts or the stale Tasks pnpm lockfile.
7. Create and deploy both Vercel projects. Record the stable URLs and live checks in the task; do not claim the staging API integration is complete until that API has a live release.

## Contracts

There is no data-model or API-schema change. The public build-time contract is:

- `VITE_TASKS_API_BASE_URL`: staging Tasks API base ending in `/api/v1`.
- `VITE_TASKS_APP_URL`: stable Tasks-app Vercel URL used as the Mission Control iframe source.
- `VITE_SHELL_ORIGIN`: stable Mission Control Vercel origin accepted by the Tasks app for `postMessage` events.

SPA routing uses a catch-all rewrite to `/index.html`. A successful `GET /` plus retrieval of the built JavaScript bundle is the frontend health check. Rollback uses Vercel deployment promotion/rollback independently per project.

## Workflow and operational changes

Vercel deployments are operator-triggered for the first rollout. Git integration can be enabled after the projects exist; it must preserve one project per app and use the repository root as the build context. Fly deployment workflows remain scoped to APIs and workers only.

## Verification matrix

| Acceptance criterion | Verification |
| --- | --- |
| AC1 — stable cloud-hosted staging URLs | Deploy both Vercel projects; verify their stable production aliases return `200` while the Mac mini is not involved. |
| AC2 — deployed shell connects to staging Tasks API | Inspect the built shell/Tasks configuration and complete authenticated Tasks, Flow Metrics, bookmark, and Content Scheduler smoke flows after the staging APIs are live. A frontend-only deploy is not sufficient evidence. |
| AC3 — health check and rollback | Verify `/` and a built asset return `200`; deploy a second harmless revision and promote the previous Vercel deployment to prove per-project rollback. |

Automated fallback coverage is `infra/cloud/scripts/tests/mission-control-deploy-fixtures.test.sh`, which validates both Vercel configs, app-local build commands, SPA rewrites, and absence of the retired Fly frontend assets. Live URL and rollback checks remain manual because they exercise provider state.

## Risks and open questions

- The staging Tasks API currently has no live Fly release. AC2 stays open until that dependency is deployed and authenticated flows succeed.
- Mission Control's bookmark-state Vite plugin is development-only. Production bookmark data needs `VITE_BOOKMARK_STATE_BASE_URL` backed by a hosted source before that tab can show live data.
- The Content Scheduler needs a hosted API URL before its Mission Control tab can complete an end-to-end staging smoke test.
- Custom domains are optional for staging; the stable `*.vercel.app` project aliases satisfy the initial URL contract and can later receive DNS aliases without rebuilding the apps.
- Vercel's GitHub integration cannot currently access the private repository. The first deployment is CLI-driven; automatic preview/production deployments remain blocked until that provider integration is granted repository access.

## First deployment evidence — 2026-09-08

- Tasks app: `https://sindustries-tasks-app-staging.vercel.app`
- Mission Control: `https://sindustries-mission-control-staging.vercel.app`
- Both stable aliases, SPA routes, and hashed JavaScript assets returned HTTP 200.
- Mission Control's production bundle contains the stable Tasks-app alias and both bundles contain the intended staging Tasks API base URL.
- A second Mission Control release was deployed and the project was successfully rolled back to deployment `dpl_4zNHCs4PURZAxYqHPYFkRN1Dx5ji`; the stable alias remained healthy.
- The staging Tasks API hostname did not resolve, so AC2's end-to-end authenticated workflow verification remains open.
