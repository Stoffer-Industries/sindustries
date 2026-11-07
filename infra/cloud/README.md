# Cloud Platform Artifacts

SIndustries cloud deployment artefacts. Owner: Rowan. Approved tech design: [`docs/specs/cloud-deployment-foundation-tech-design.md`](../../docs/specs/cloud-deployment-foundation-tech-design.md).

This subtree is the **single source of truth** for how to recreate the SIndustries staging cloud target. It is intentionally split from `services/<svc>/` so the application services stay runnable from the repo root without depending on cloud-platform concerns.

## Layout

```
infra/cloud/
├── README.md                   # this file
├── fly/                        # Fly.io app specs (one per Fly app)
│   ├── tasks-api.fly.toml
│   ├── budget-api.fly.toml
│   ├── auto-post-worker.fly.toml
│   └── platform.fly.toml       # consolidated staging app (task 219fb673)
├── docker/                     # Service Dockerfiles (referenced by the fly.toml files)
│   ├── tasks-api.Dockerfile
│   ├── budget-api.Dockerfile
│   ├── auto-post-worker.Dockerfile
│   └── platform.Dockerfile     # combined image for all four processes
├── platform/                   # Consolidated platform code (task 219fb673)
│   ├── platform-services.mjs   # service registry + env mapping (single source of truth)
│   ├── platform-supervisor.mjs # entrypoint: spawns the children + the router
│   ├── platform-migrate.mjs    # release_command: the three per-service migrations
│   ├── nginx.conf              # in-container Host router
│   └── tests/                  # supervisor unit tests
├── env/                        # Env-var contracts (no live values — owner-supplied)
│   ├── .env.example            # cross-service env contract + per-service reference index
│   ├── tasks-api.env.example
│   ├── budget-api.env.example
│   ├── auto-post-worker.env.example
│   └── platform.env.example    # consolidated app's PLATFORM_* secrets
├── bin/                        # Operator-facing deploy/status/rollback wrappers (task 2850c5ac)
│   ├── deploy                  # Pin-and-deploy a single service
│   ├── status                  # Check process types + machines across services
│   ├── rollback                # Roll a single service back to a prior release
│   └── tests/                  # Stub-flyctl tests for the bin/ scripts
└── scripts/                    # Owner-supplied operational scripts (Quinn runs locally)
    └── bootstrap-staging.sh
```

CI lives at `.github/workflows/deploy-staging-<service>.yml` (sibling to this subtree): `deploy-staging-tasks-api.yml`, `deploy-staging-budget-api.yml`, `deploy-staging-content-scheduler-api.yml`, `deploy-staging-auto-post-worker.yml`, `deploy-staging-platform.yml`.

Mission Control and the Tasks app are static Vite SPAs and deploy as separate
Vercel projects using their co-located `apps/<app>/vercel.json` files. They
deliberately do not use Fly app specs or frontend containers; Fly remains the
runtime for APIs and workers.

## Services (staging)

Staging is ONE Fly app after the consolidation (task 219fb673). The cutover
landed on 2026-11-07: the four per-service staging apps were destroyed and
the platform app now hosts every service.

| Fly app                       | Source                       | Notes                                                                                  |
| ----------------------------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| `sindustries-platform-staging`    | `services/tasks-api/` + `services/budget-api/` + `services/content-scheduler-api/` | **The staging app.** One Machine, one image, four processes: tasks-api (4001), budget-api (4002), content-scheduler-api (4003), auto-post-worker (no listener). An in-container nginx router maps the three hostnames to those ports, and the supervisor restarts a crashed child. No service code changes. |
| ~~`sindustries-tasks-api-staging`~~        | `services/tasks-api/`        | Retired 2026-11-07. Now a tasks-api child of the platform. Health at `/health`. Port 4001.       |
| ~~`sindustries-budget-api-staging`~~       | `services/budget-api/`       | Retired 2026-11-07. Now a budget-api child of the platform. Health at `/health`. Port 4002.                            |
| ~~`sindustries-content-scheduler-api-staging`~~ | `services/content-scheduler-api/` | Retired 2026-11-07. Now a content-scheduler-api child of the platform. Health at `/health`. Port 4003.                         |
| ~~`sindustries-auto-post-worker-staging`~~ | `services/content-scheduler-api/src/workers/autoPostWorkerMain.ts` | Retired 2026-11-07. The worker still runs — as a child of the platform, on the same BullMQ queue. **Not** HTTP-exposed. |

The per-service `fly/*.fly.toml` files are retained as templates for the
production migration; no operator surface deploys them any more, and
`infra/cloud/scripts/tests/retired-staging-apps.test.sh` fails the build if
one comes back — a resurrected worker app would be a SECOND consumer on the
same BullMQ queue, and every scheduled post would be processed twice,
silently.

The stable hostnames still do not resolve: the cutover's remaining leg is
the Cloudflare CNAME move, which is blocked on a `Zone:DNS:Edit` token that
only Tom holds (task `5cb4a8fe`). Until it lands, the services answer on the
platform's provider hostname via path-prefix routes
<!-- stable-fallback: provider URL pending the stable-hostname CNAME move (task 5cb4a8fe) -->
(`https://sindustries-platform-staging.fly.dev/tasks-api/health`). The
cutover and backout procedures are in
`docs/runbooks/platform-consolidation-rollback.md`; the shared-fate
consequences are in `docs/systems/cloud-platform.md` §"Shared-fate topology
(staging)".

The auto-post-worker source lives in `services/content-scheduler-api/` after the 94d5e4fc extraction — the design predates that move but Quinn's APPROVED review on PR #508 stated "implementation PRs can stack on top", so the worker Fly app builds from content-scheduler-api's source tree.

## Quinn-owned vs Rowan-implemented boundary

| Owner  | Asset                                                                                                                  |
| ------ | ---------------------------------------------------------------------------------------------------------------------- |
| Quinn  | Fly.io API token, Neon connection string + DIRECT_URL, Upstash credentials, DNS provider token (sindustries.dev).       |
| Quinn  | First-time execution of `bootstrap-staging.sh` (requires live secrets; never runs in CI).                              |
| Quinn  | DNS record creation (CNAMEs for `*.sindustries.dev`).                                                                   |
| Rowan  | All artefacts under `infra/cloud/` and `.github/workflows/deploy-staging-*.yml`.                                       |
| Rowan  | PR reviewable surface for the deploy topology itself.                                                                  |
| Shared | GitHub Actions repo secrets: `FLY_API_TOKEN` (Quinn registers once; Rowan references by name only).                    |

Workflow YAML references secret names only (`secrets.FLY_API_TOKEN`); no live values are committed.

## Deploying

Staging is one app, so there is one deploy:

```sh
# 1. Set up secrets once (Quinn; idempotent — re-running it is safe).
#    The platform app takes APP-LEVEL secrets (the PLATFORM_* names the
#    supervisor maps onto each child), and the platform provisioner owns
#    that mapping — use it rather than writing secrets by hand:
node infra/cloud/platform/platform-provision-secrets.mjs \
  --app sindustries-platform-staging --org personal

# 2. Deploy (CI does this on push to main; manual override via workflow_dispatch)
fly deploy --config infra/cloud/fly/platform.fly.toml --strategy canary
```

The CI workflow runs `--strategy canary` for every deploy. The post-deploy
smoke check curls the three path-prefix health routes on the platform's
provider hostname and greps `fly logs` for the auto-post worker's structured
startup line `[content-scheduler-worker] starting (adapter=bullmq)`. Failed
http_checks automatically remove the machine from the load balancer; rollback
uses `fly releases rollback <v>` (see
`docs/specs/cloud-deployment-foundation-tech-design.md` "Rollback" section —
the prior `docs/runbooks/cloud-deployment-rollback.md` was retired in PR #583).


## Operator wrappers (task 2850c5ac)

The CI workflow above is the canonical deploy path. The `bin/` wrappers are
for ad-hoc canaries, rehearsal, and incident-time hotfixes — they target
the same Fly apps via the local `flyctl` CLI, not via GitHub Actions.

Staging is one Fly app now, so every service name in these wrappers is an
ALIAS for the consolidated platform app. `bin/deploy tasks-api` deploys the
platform (the only app that can serve tasks-api), and `bin/status tasks-api`
reports the platform app plus the state of the tasks-api CHILD inside it,
read from the supervisor's `/__status` payload. A rollback is shared-fate:
it rolls every service back together.

```sh
# Deploy the platform, pinning an immutable image tag (no :latest).
# Without --image the deploy builds from local source (no registry push).
STAGING_PLATFORM_DEPLOY_ENABLED=true infra/cloud/bin/deploy tasks-api --image registry/repo:abc123

# Inspect the running state (the platform app + every child's state).
infra/cloud/bin/status
infra/cloud/bin/status tasks-api --json

# Roll the platform back to the previous release (or to a specific version).
# Non-interactive callers must pass --yes; dry-run prints the command and
# exits without invoking flyctl.
infra/cloud/bin/rollback tasks-api --dry-run
infra/cloud/bin/rollback budget-api --yes
infra/cloud/bin/rollback content-scheduler-api --yes
infra/cloud/bin/rollback auto-post-worker --yes --to-version 41
```

Each wrapper requires `FLY_API_TOKEN` in the environment (Quinn-owned).
Run `infra/cloud/bin/{deploy,status,rollback} --help` for the full flag
list. The tests under `infra/cloud/bin/tests/` stub `flyctl` and `curl`
to assert each wrapper's contract (image pinning, smoke checks,
degraded detection, rollback argv shape).


## First-time environment creation

Quinn runs `infra/cloud/scripts/bootstrap-staging.sh` once. The script:

- Verifies the `fly` CLI is installed and authenticated.
- Creates the platform Fly app if it is missing (`fly apps create ...`).
- Registers the app-level `PLATFORM_*` secrets through the platform
  provisioner (`infra/cloud/platform/platform-provision-secrets.mjs`), which
  is the single implementation of the source-to-secret mapping and fails
  closed when a source is missing. The values come from a local
  `infra/cloud/.env.local` file (Quinn never commits this).
- Runs the platform's Prisma migration chain (`--migrate`).
- Performs a smoke deploy of the platform (`--deploy`).
- Surfaces a final report with the app URL and the service routes.

The retired per-service names are refused by the script: bootstrapping one
would recreate an app that must stay destroyed.

The script is idempotent — re-running it does not destroy existing apps.


## PR strategy

WS1 ships as stacked PRs:

1. **PR #1 ✅:** tasks-api proof-of-concept. Demonstrates the layout, the Fly spec shape, the Dockerfile pattern, and the CI workflow pattern. [PR #514, merged 2026-08-23]
2. **PR #2 ✅:** budget-api slice (mirrors PR #1). [PR #527, merged 2026-08-24]
3. **PR #3 (this slice):** auto-post-worker Fly app (separate process; builds from content-scheduler-api source; **no HTTP exposure**). Adds `infra/cloud/fly/auto-post-worker.fly.toml` + `infra/cloud/docker/auto-post-worker.Dockerfile` + `.github/workflows/deploy-staging-auto-post-worker.yml`. No Prisma `release_command` (worker does reconciliation in code, not as part of canary deploy) and no `http_service` block.
4. PR #4: `bootstrap-staging.sh` + `env/.env.example` + per-service `.env.example` files.
5. PR #5: `docs/systems/cloud-platform.md` (durable AC4 doc) + `docs/runbooks/cloud-deployment-rollback.md` (note: the rollback runbook was retired in PR #583 along with all `docs/runbooks/` artefacts — the rollback command + verify sequence is preserved in `docs/specs/cloud-deployment-foundation-tech-design.md`).

Stacking rationale: each slice is reviewable in isolation (~150 LoC); Quinn can steer on PR #1 before Rowan replicates the pattern to budget-api and the worker.

### Note on the auto-post-worker source path

PR #3 builds the worker from `services/content-scheduler-api/src/workers/autoPostWorkerMain.ts` — Quinn's APPROVED review on PR #508 explicitly approved "implementation PRs can stack on top" of the 94d5e4fc content scheduler extraction. If/when 94d5e4fc lands a standalone `services/auto-post-worker/`, the Dockerfile's `COPY services/...` paths and the workflow's path filter need to be retargeted. Until then, the worker Fly app builds from the content-scheduler-api source tree; nothing in this PR depends on the extraction landing first.
