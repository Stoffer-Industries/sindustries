---
status: draft
task_id: 2850c5ac-252e-404a-863b-b83755b2f618
product_spec: brain/tasks/specs/open/cloud-staging-environment.md
shipped_pr: null
shipped_date: null
---

# Deploy cloud staging environment and verify representative workflows

## Links and delivery metadata

- Product spec: `brain/tasks/specs/open/cloud-staging-environment.md`
- Parent migration index: `brain/tasks/specs/open/sindustries-cloud-migration.md` (workstream 4 of 7)
- Task: `2850c5ac-252e-404a-863b-b83755b2f618`
- Task title: `🔧 Deploy cloud staging environment and verify representative workflows`
- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-2850c5ac-252e-404a-863b-b83755b2f618-cloud-staging-environment`
- Worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/rowan-cloud-staging`
- Tech design: `docs/specs/cloud-staging-environment-tech-design.md`

## Product intent

The product spec requires a production-like, non-production environment where SIndustries can prove that its services boot, authenticated Tasks API, Budget API, and Content Scheduler workflows work, and an intentional failure is observable and recoverable. The deliverable is not merely a successful deploy: it is a repeatable staging deployment plus redacted evidence that separates production blockers from accepted limitations.

## Clarification and assumptions

No clarification is needed before design approval because the three prerequisite tasks own the choices this design must consume rather than duplicate: cloud provider/runtime (`b2f62c36-6367-435b-a329-9c55ad62c551`), runtime configuration (`206927ed-d851-47af-8864-0056487e0c4e`), and hosted observability (`4b3d6e9c-d1ba-462c-aa72-4371ce81d8c7`). Implementation must stop if any prerequisite is incomplete or its delivered interface differs from the assumptions below.

Assumptions:

1. The foundation task creates a provider-specific staging environment and a repo-owned deploy/status/rollback interface under `infra/cloud/`; this task extends that interface rather than introducing a second deployment path.
2. Staging uses isolated Postgres and Redis resources. It never connects to local development or production databases and never receives live production credentials or unmasked production data.
3. `tasks-api`, `budget-api`, the Content Scheduler worker, Tasks app, and Mission Control are the representative staging topology. Content Scheduler remains temporarily hosted by `tasks-api` until its already-designed service extraction ships.
4. Staging uses BullMQ (`CONTENT_SCHEDULER_JOB_ADAPTER=bullmq`) and a separate worker process. The in-process adapter is not production-like.
5. A synthetic staging identity and synthetic records are acceptable. The validation flow must not publish to X, call Akahu with live credentials, or create durable human-facing content.

## Scope

In scope:

- deploy the required services to the prerequisite cloud staging environment;
- wire production-like, staging-specific configuration and secret references;
- add a repeatable, authenticated smoke harness for Tasks API, Budget API, and Content Scheduler;
- close the Budget API `dev-login` staging exposure and provide a bounded synthetic-session fixture path;
- run a controlled Content Scheduler worker-failure drill;
- capture a machine-readable result and a redacted operator evidence record;
- update the cloud system reference and staging runbook.

Out of scope:

- production data or credentials;
- production traffic or DNS changes;
- provider selection and base resource provisioning;
- production database migration or cutover;
- Content Scheduler service extraction;
- publishing a real X post or performing a live Akahu sync.

## Architecture and ownership boundary

### Natural source of truth

This is an **infra/workflow boundary**. Provider manifests and environment topology belong under `infra/cloud/`; service runtime contracts remain owned by each service; operational validation belongs under `tests/cloud/` and `scripts/cloud/`; redacted evidence belongs under `docs/infra/`. No UI-local state or new catch-all API is introduced.

### Domain ownership

- `services/tasks-api` continues to own task/workflow state. It also temporarily owns Content Scheduler persistence/routes as documented in `docs/systems/content-scheduler.md`; this task does not deepen that coupling.
- `services/budget-api` owns budget sessions and finance-domain data.
- Redis is derived execution state for Content Scheduler. PostgreSQL remains the source of truth; worker startup reconciliation rebuilds missing delayed jobs.
- `infra/cloud/environments/staging/` owns staging-only deployment inputs and references to provider secret names, never secret values.
- `tests/cloud/staging-workflows.mjs` owns the black-box validation contract. It consumes only public service endpoints and short-lived synthetic credentials.

The durable provider deployment boundary is approximately the same effort as ad-hoc console deployment, so this design requires the repo-owned deploy interface now. A one-off manual deployment would create avoidable drift before production cutover.

### Runtime topology

```text
staging edge/routes
  ├─ Tasks app / Mission Control
  ├─ tasks-api ───────┐
  ├─ budget-api ──────┼─ managed staging PostgreSQL
  └─ scheduler worker ┘
          │
          └──────────── managed staging Redis/BullMQ

all processes ── OTLP/logs/metrics ── hosted staging observability
```

The API and worker use the same staging PostgreSQL and Redis endpoints, but each service keeps its existing schema ownership. Security groups/network policy allow only workload identities and an operator-controlled migration/validation runner.

## Implementation plan and file scope

### 1. Consume the foundation deployment interface

Extend the provider-specific staging environment created by the foundation task:

- `infra/cloud/environments/staging/` — service definitions, resource references, replica counts, health checks, and staging route outputs.
- `infra/cloud/bin/deploy` — consume the prerequisite deploy command; pin an immutable image/commit, wait for rollout, and print non-secret deployment identifiers.
- `infra/cloud/bin/status` and `infra/cloud/bin/rollback` — verify all process types and allow rollback to the preceding image.

Required staging process types are `tasks-api`, `budget-api`, `content-scheduler-worker`, `tasks-app`, and `mission-control`. The worker is independently restartable. Deployment uses immutable commit/image identifiers; `latest` is forbidden.

### 2. Add staging-safe service configuration

- Set `NODE_ENV=production` for server processes even though the environment name is staging.
- Set explicit staging CORS origins, Postgres schemas, OTLP exporter, and BullMQ Redis URL.
- Reference provider secret-store keys delivered by the runtime-configuration task; do not commit values.
- Add a production-mode guard in `services/budget-api/src/routes/session.ts` so `POST /api/v1/session/dev-login` is unavailable outside local development.
- Add `services/budget-api/scripts/staging-smoke-session.ts`, a staging-only operator CLI that creates a random synthetic user/session, writes the bearer token only to an operator-specified mode-`0600` file, and revokes the session/user fixture during cleanup. It must require an explicit staging environment assertion and refuse production database identifiers. A `trap` in the wrapper runs cleanup after interruption; a reconciliation mode removes stale `staging-smoke+*@sindustries.invalid` fixtures.

The fixture CLI is not an alternate product login mechanism: it runs inside the service network, has no HTTP route, and exists only to test the existing authenticated middleware/API path until durable production identity is designed.

### 3. Add the representative workflow harness

Create `tests/cloud/staging-workflows.mjs` and fixtures under `tests/cloud/fixtures/`. The harness accepts endpoint URLs and secret-file paths, never credential values on command-line arguments, and performs:

1. **Tasks API:** authenticated create of a uniquely tagged synthetic task, read, comment, status patch, archive, then confirm it is absent from normal reads.
2. **Budget API:** use the synthetic session to call `/api/v1/me`, create/read/update one synthetic budget-domain record through an existing owned route where practical, and clean up the synthetic fixture through the operator CLI. No Akahu call is made.
3. **Content Scheduler:** authenticated create of a synthetic item scheduled sufficiently in the future, approve it, verify `GET /content-scheduler/auto-post/health` reports `adapter=bullmq`, Redis healthy, and a queued job, then unapprove/remove it before its publish time. `X_CLIENT=fake` is forbidden in production but acceptable in staging only if the prerequisite config contract explicitly allows a non-publishing staging adapter; otherwise the test never reaches publish time.

Every created resource uses a run ID and is cleaned up idempotently. The harness emits JSON conforming to `tests/cloud/staging-validation.schema.json`; fields include commit, environment ID, service versions, check names, start/end time, pass/fail, observability correlation IDs, cleanup result, blockers, and accepted limitations. Tokens, emails other than the synthetic domain, payload bodies, and row data are redacted.

### 4. Verify failure, alerting, and recovery

Add `tests/cloud/staging-failure-drill.sh` using the foundation's process-control interface:

1. prove the worker and auto-post health are green;
2. schedule a future synthetic item;
3. intentionally stop/kill exactly one Content Scheduler worker instance (not Postgres and not Redis);
4. confirm the hosted availability/process alert fires within its documented window and logs identify the terminated process and environment;
5. restore the worker with the normal deploy/restart command;
6. verify startup reconciliation reports the item as scheduled/active or re-enqueued and the alert resolves;
7. unapprove/remove the fixture.

The drill has an explicit cleanup trap and maximum duration. It refuses to run unless the provider environment label equals `staging`. A database or Redis destructive fault is reserved for the dedicated migration/restore task.

### 5. Workflow and evidence

- Add `.github/workflows/cloud-staging-validate.yml` as `workflow_dispatch` only, protected by the GitHub `staging` environment and concurrency group `cloud-staging`. It deploys an immutable commit, runs health/smoke checks, optionally runs the failure drill, and uploads the raw redacted JSON artifact.
- Add `docs/runbooks/cloud-staging.md` with prerequisites, deploy, rollback, validation, fixture cleanup, failure-drill, and escalation steps.
- Add the execution record at `docs/infra/cloud-staging-validation-<YYYY-MM-DD>.md`. It links the workflow run/artifact and records only redacted summaries, blockers, accepted limitations, operator, and timestamps.
- Update the cloud-runtime system doc created by the foundation task (expected `docs/systems/cloud-runtime.md`) with shipped staging topology and runbook links. If the prerequisite chooses another consolidated cloud system doc, update that doc instead of creating a duplicate.

This is one mergeable implementation cut because meaningful acceptance requires the deployed environment and its evidence together. The smoke harness and safety guard can be reviewed before execution in the same draft PR; no separate interim local shim is needed.

## Data model and API contract

### Application data

No durable product-domain model is added. Existing staging schemas are used with synthetic fixtures.

The Budget API fixture path may create ordinary existing `User` and `Session` rows and then delete them. If implementation discovers that safe cleanup cannot be guaranteed with the existing schema, stop and revise this design rather than adding an unreviewed auth schema migration.

### HTTP behavior change

`POST /api/v1/session/dev-login` becomes local-development-only. In staging/production it returns `404` (preferred to avoid advertising the route) and creates no rows. Add route tests for development success and production-mode refusal.

### Validation result contract

`tests/cloud/staging-validation.schema.json` is the durable machine contract. A run is successful only when:

- every required service version equals the intended commit/image;
- all health and workflow checks pass;
- fixture cleanup passes;
- the selected failure alert fires and resolves;
- `productionBlockers` is empty.

`acceptedLimitations` may be non-empty, but each entry requires owner, rationale, and follow-up task/reference.

## Workflow, cron, and skill changes

- One manual GitHub Actions workflow is added; no scheduled cron is added. Staging changes should not deploy or inject faults unattended.
- No agent skill changes are required.
- No Lobster workflow changes are required.
- The existing Content Scheduler worker command remains `npm run content-scheduler:worker`; staging selects BullMQ through configuration.

## `.openclaw` boundary

OpenClaw remains local and is not deployed by this task. Staging validation uses explicit staging URLs supplied to the workflow and must not rewrite `~/.openclaw` endpoint configuration.

If a representative agent workflow must be exercised from OpenClaw, Rowan will post `[openclaw-needed]` during implementation with the exact Quinn-owned config path, staging-only temporary diff, validation command, and rollback. Rowan must not edit `~/.openclaw/`. No such change is assumed for this design, and AC2 can be met through authenticated HTTP workflows without it.

## Test plan and acceptance-criterion verification matrix

| AC | Planned verification | Layer / evidence |
|---|---|---|
| AC1 — staging starts with production-like configuration and passes service health checks | Deploy an immutable commit; assert all five process types are ready, `NODE_ENV=production`, the config validator passes, Tasks API and Budget API `/health` return 200, Content Scheduler health reports BullMQ + Redis healthy, and hosted DB/service signals are green. Roll back one prior image in a rehearsal and redeploy the candidate. | Operational E2E via `cloud-staging-validate.yml`; provider status output + redacted `docs/infra/cloud-staging-validation-<date>.md`. Unit tests cover the Budget dev-login guard. |
| AC2 — authenticated Tasks API, Budget API, and Content Scheduler workflows complete | Run `tests/cloud/staging-workflows.mjs` against the deployed endpoints with synthetic principals. Verify create/read/update/cleanup for Tasks, authenticated `/me` plus one owned Budget flow, and scheduler create/approve/BullMQ-health/unapprove/remove. | Black-box environment E2E. Real external X/Akahu calls are disproportionate and unsafe because the spec forbids production credentials/data; the fallback is integration against real staging DB/Redis with synthetic adapters and existing service integration tests for vendor clients. |
| AC3 — intentional failure has useful logging, alerting, and recovery | Kill one staging worker, observe the configured alert and correlated logs, restore the worker, verify startup reconciliation and alert resolution, then confirm the synthetic item remains safe and removable. | Manual-triggered operational E2E plus hosted observability evidence. Process termination remains manual/provider-adapter-assisted because CI unit tests cannot prove external alert delivery. |
| AC4 — evidence and blockers are clear | Validate the JSON result against its schema; publish a redacted evidence document with separate `Production blockers` and `Accepted limitations` sections, owners, timestamps, commit/image IDs, workflow link, cleanup status, and verdict. Require `productionBlockers=[]` for a pass. | Schema test + direct document inspection in the implementation PR. |

Additional gates:

- existing Tasks API, Budget API, Mission Control, and Content Scheduler tests pass;
- deployment manifest validation/plan passes without applying to production;
- secret scanning passes and the evidence artifact contains no known secret values;
- cleanup mode succeeds when run twice.

## Risks and mitigations

- **Budget API has only a dev-login minting path today.** Exposing it in staging would make staging unlike production and unsafe. Disable it outside development and use an internal, bounded fixture CLI; revise the design if cleanup cannot be made reliable.
- **A green `/health` is currently liveness-only.** The black-box authenticated workflows and hosted database metrics supply readiness evidence. Do not silently redefine liveness as dependency readiness without updating API contracts and tests.
- **Accidental external publishing.** Schedule well in the future, use a synthetic adapter/no-op credential, unapprove/remove in a cleanup trap, and fail closed if a real X target is detected.
- **Worker failure drill runs against the wrong environment.** Require provider account/project and `environment=staging` assertions in two independent checks; refuse production identifiers.
- **Provider interface drift from prerequisite tasks.** Update this design before approval/implementation if the foundation paths or capabilities differ; do not add parallel ad-hoc scripts.
- **Evidence leaks data or credentials.** Store only aggregate results, correlation IDs, synthetic IDs, and secret-name references. Run gitleaks and a known-secret redaction check before commit.

## Open questions

1. What provider-specific path and command names will the foundation task expose? The expected interface is `deploy`, `status`, `rollback`, and process restart/scale; implementation must bind this design to the delivered names.
2. Which existing Budget API write is safest for the synthetic workflow without calling Akahu? Default: a budget/alert configuration owned by the synthetic card fixture; if creating the prerequisite card requires direct DB fixture setup, document that boundary explicitly.
3. What alert delivery window does the observability task establish? Use that documented SLO in the drill rather than inventing a second threshold.
4. Does the runtime-config task permit a staging no-op X adapter while requiring real adapters in production? If not, keep the item sufficiently future-dated and guarantee unapprove/remove cleanup without invoking publish.
