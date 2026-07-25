---
status: draft
task_id: 94d5e4fc-1b31-4d04-a13b-4f69a7ec297a
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Content Scheduler service extraction — tech design

## Context

PR #213 shipped the Content Scheduler tab with backend routes, Prisma model, migration, and X publishing integration under `services/tasks-api`. That placement was expedient but weakens the intended Sindustries micro-service architecture: Mission Control should be a multi-service client, and `tasks-api` should not become the default backend for unrelated product domains.

This design defines the follow-up code task to move Content Scheduler backend ownership out of `tasks-api` into a dedicated service boundary.

## Service boundary and data ownership

- **New owner:** `services/content-scheduler-api` owns content scheduling queue state, approval metadata, publishing guard rules, X publishing integration, and scheduler-specific migrations.
- **Existing owner retained:** `services/tasks-api` continues to own tasks, task comments, tags, task dependencies, task lifecycle state, and workflow metadata only.
- **Consumer:** `apps/mission-control` calls Content Scheduler API directly for `/content-scheduler` tab behavior, while continuing to call Tasks API directly for task/workflow screens.
- **No aggregate Mission Control backend:** Mission Control should not get a monolithic backend service just because multiple tabs exist. Each domain service exposes its own API.
- **Temporary state:** Content Scheduler tables/routes currently live in `tasks-api` because PR #213 has already merged. This task removes that temporary coupling.

## Scope

In scope:
- Create `services/content-scheduler-api` using the repo's existing Express/TypeScript/Prisma conventions.
- Move Content Scheduler routes, publish guard/client logic, tests, Prisma schema model/enums, and migration ownership out of `services/tasks-api`.
- Update Mission Control's content scheduler API client/config to target the new service directly.
- Remove Content Scheduler route mounting and scheduler-specific tests/docs from `services/tasks-api`.
- Preserve existing data where possible via migration/backfill plan for prodlike/dev databases.
- Update docs/system references so the Tasks API boundary is explicit and Content Scheduler has its own system reference.

Out of scope:
- Changing Content Scheduler product behavior or UI flows.
- Adding cron-driven auto-publishing.
- Adding multi-account X support, media attachments, or thread composition.
- Reworking the task workflow itself.

## Proposed implementation

### 1. Service scaffold

- Add `services/content-scheduler-api/package.json`, `tsconfig.json`, source entrypoint, tests, and Prisma config matching existing service conventions.
- Expose health endpoint and Content Scheduler routes under `/api/v1/content-scheduler`.
- Assign a separate local/prodlike port in infra/dev config rather than reusing `tasks-api` ports.

### 2. API and publish logic move

Move from `services/tasks-api`:
- `src/routes/contentScheduler.ts`
- `src/routes/contentSchedulerPublish.ts`
- related route tests

Keep the public route contract stable so Mission Control only changes base URL, not behavior.

### 3. Database ownership

- Move `ContentSchedulerItem` and scheduler enums to the new service Prisma schema.
- Create migrations owned by `services/content-scheduler-api`.
- Decide the production-safe migration path before implementation:
  - if the same Postgres database is shared by services, transfer migration ownership carefully without dropping data;
  - if a new database/schema is introduced, backfill existing rows and verify counts before removing old tables.
- Do not drop existing scheduler data until the new service is verified.

### 4. Mission Control integration

- Update `apps/mission-control/src/contentSchedulerApi.js` to use a dedicated Content Scheduler base URL/env var.
- Keep Tasks API client usage separate for task-related screens.
- Document Mission Control as a multi-service client in `apps/mission-control/README.md` or `SPEC.md`.

### 5. Tasks API cleanup

- Remove Content Scheduler route registration from `services/tasks-api/src/app.ts`.
- Remove scheduler-specific env docs from `services/tasks-api/README.md`.
- Ensure `tasks-api` tests prove no scheduler routes are mounted there.

### 6. Documentation

- Create `docs/systems/content-scheduler.md` with architecture, API contract, runtime behavior, X credential boundary, runbook notes, and related PRs/tasks.
- Update `docs/systems/tasks.md` to state that Tasks API does not own Content Scheduler.
- Mark this tech design shipped when the extraction PR merges.

## Acceptance criteria for the code task

- AC1: Content Scheduler backend routes run from a dedicated `services/content-scheduler-api` service, not `services/tasks-api`.
- AC2: Mission Control calls the new Content Scheduler service directly while continuing to call Tasks API only for task/workflow data.
- AC3: Existing scheduler behavior is preserved: create, edit, reorder, approve/unapprove, publish guard, soft remove, today status, and published metadata.
- AC4: Migration/backfill path preserves existing Content Scheduler rows; no scheduler data is dropped without verification.
- AC5: Tasks API has no Content Scheduler route mount, model ownership, tests, or service docs beyond boundary references.
- AC6: System docs describe Content Scheduler as its own service and Tasks API as task/workflow-only.

## Test plan

- `npm --workspace @sindustries/content-scheduler-api test`
- `npm --workspace @sindustries/tasks-api test`
- `npm --workspace @sindustries/mission-control test`
- Prisma validate/migrate dry-run for both affected services.
- Manual smoke: run local stack, open Mission Control `/content-scheduler`, add/approve/publish with fake X client, verify daily cap and published URL behavior.
- Data migration verification: compare source/destination scheduler row counts and sample IDs before cutover.

## Risks and open questions

- **Migration ownership:** need to inspect current deployment DB layout before deciding whether the new service shares the existing Postgres database or gets a separate database/schema.
- **Local dev infra:** adding a service means assigning ports and updating Tilt/make/dev env. Keep changes minimal and documented.
- **Cutover safety:** avoid deleting old tables/routes in the same step that first introduces the new service unless rollback is clear.
- **X credentials:** credentials remain outside the repo. The new service should use env vars and return clear 503 errors when missing, matching current behavior.
