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
│   ├── platform-environments.mjs # environment manifest (staging/production) + separation guards
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
│   ├── platform.env.example    # consolidated app's PLATFORM_* secrets (destination names)
│   ├── bootstrap-staging.env.example  # source names read by scripts/bootstrap-staging.sh
│   └── bootstrap-production.env.example  # source names read by scripts/bootstrap-production.sh
├── bin/                        # Operator-facing deploy/status/rollback wrappers (task 2850c5ac)
│   ├── deploy                  # Pin-and-deploy a single service
│   ├── status                  # Check process types + machines across services
│   ├── rollback                # Roll a single service back to a prior release
│   └── tests/                  # Stub-flyctl tests for the bin/ scripts
└── scripts/                    # Owner-supplied operational scripts (Quinn runs locally)
    ├── bootstrap-platform.sh   # the shared, environment-aware bootstrap (staging | production)
    ├── bootstrap-staging.sh    # thin wrapper -> bootstrap-platform.sh --environment staging
    └── bootstrap-production.sh  # thin wrapper -> bootstrap-platform.sh --environment production
```

CI's live staging deploy surfaces are `.github/workflows/deploy-staging-platform.yml` (the consolidated platform app) and `.github/workflows/deploy-staging-health-probe.yml` (the separate health-probe app); `.github/workflows/ci.yml` calls only these two. The four per-service reusable workflows — `deploy-staging-tasks-api.yml`, `deploy-staging-budget-api.yml`, `deploy-staging-content-scheduler-api.yml` and `deploy-staging-auto-post-worker.yml` — are retained but orphaned: they are `workflow_call`-only, and nothing calls them since their deploy jobs were removed from `ci.yml` on 2026-11-07, when the four underlying Fly apps were destroyed ahead of the cutover. They stay in the tree until the cutover cleanup in `docs/runbooks/platform-consolidation-rollback.md` §5 deletes them; `tests/cloud/scripts/check-deploy-workflow-stable-hostname.mjs` still requires three of them (tasks-api, budget-api, content-scheduler-api) to exist.

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

The auto-post-worker source lives in `services/content-scheduler-api/` after the 94d5e4fc content-scheduler extraction (task `94d5e4fc-1b31-4d04-a13b-4f69a7ec297a`) — the design predates that move but Quinn's APPROVED review on PR #508 stated "implementation PRs can stack on top", so the worker builds from content-scheduler-api's source tree inside the platform image.

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

# The provisioner is parameterised by environment (task fb1240c0). The
# default is staging, so the command above is unchanged. For production,
# pass the environment id: it selects the app name, the GitHub Environment
# source names, the schemas, the base URLs and the approval actors, and it
# turns on the fail-closed guards that refuse a value carrying a
# staging/dev hostname, a placeholder or a localhost address:
node infra/cloud/platform/platform-provision-secrets.mjs \
  --environment production --org personal

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

### Credential redaction on the operator surfaces

Two operator surfaces show text that `flyctl` produced: `bin/status`
(when `flyctl status` fails) and the platform provisioner
(`infra/cloud/platform/platform-provision-secrets.mjs`, which echoes the
flyctl child's stderr). BOTH redact through ONE module,
`infra/cloud/platform/redact-output.mjs`, so their rules cannot drift
apart again — they used to, and a `postgres://` DSN printed in the clear.

The module masks URL/DSN credentials, JSON credential fields, the
`Authorization: Bearer`/`Basic` and Fly `FlyV1` header forms,
`NAME=value` assignments, the credential keywords (`token`, `password`,
`secret`, `credential`, `api_key`) and Fly's own `fly_<token>` form.
Closing punctuation stays OUTSIDE the mask, so a diagnostic reads
`Error: failed (token=[redacted])` with its closing bracket intact
rather than losing a character the operator is reading.

The module's contract is `infra/cloud/platform/tests/redact-output.test.mjs`
(run by the `infra/cloud bootstrap + fly.toml + no-pnpm-pin tests` CI job);
the shell surface's own per-shape regression cases are in
`infra/cloud/bin/tests/status.test.sh`.

### Egress: flyctl runs with direct egress

`bin/status` calls `flyctl` with `HTTP_PROXY`, `HTTPS_PROXY`,
`http_proxy`, `https_proxy`, `SSL_CERT_FILE` and `SSL_CERT_DIR` UNSET —
the same proxy policy `agents/lib/github-cli.sh` keeps for `gh`, plus
the CA-bundle variables. An ambient TLS-intercepting proxy makes flyctl
fail with `x509: "api.fly.io" certificate is not trusted` while `curl`
and `openssl s_client` verify the same host cleanly: the cause is the
operator's shell, not the platform. The CA-bundle variables go with the
proxy ones because on this host the ambient `SSL_CERT_FILE` points at the
egress proxy's trust bundle, so a DIRECT connection would verify Fly's
certificate against the proxy's CA and fail the same way.

On a host whose ONLY egress is a proxy (or whose root CA lives only in
the ambient bundle), set `FLY_STATUS_USE_AMBIENT_PROXY=1` and the
operator's environment is passed through to the flyctl call untouched.


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

### Production (task fb1240c0)

Production is the SAME implementation, selected by the environment manifest
(`infra/cloud/platform/platform-environments.mjs`); no environment fact is
copied into a script. `bootstrap-staging.sh` and `bootstrap-production.sh`
are thin wrappers over `bootstrap-platform.sh --environment staging|production`.

| | staging | production |
|---|---|---|
| Entry point | `infra/cloud/scripts/bootstrap-staging.sh` | `infra/cloud/scripts/bootstrap-production.sh` |
| Local env file (gitignored) | `infra/cloud/.env.local` | `infra/cloud/.env.production.local` |
| Source contract (placeholders only) | `infra/cloud/env/bootstrap-staging.env.example` | `infra/cloud/env/bootstrap-production.env.example` |
| Operator contract | this file | `docs/cloud/production-source-contract.md` |
| Platform app | `sindustries-platform-staging` | `sindustries-platform-production` |
| Health-probe app | `sindustries-health-probe-staging` | `sindustries-health-probe-production` |
| Deploy gate | `STAGING_PLATFORM_DEPLOY_ENABLED=true` | `PRODUCTION_PLATFORM_DEPLOY_ENABLED=true` |
| Provision gate (CI) | — | `PRODUCTION_PLATFORM_PROVISION_ENABLED=true` |
| Migrations gate | `STAGING_PLATFORM_MIGRATIONS_ENABLED=true` | `PRODUCTION_PLATFORM_MIGRATIONS_ENABLED=true` |
| Fly config | the shared `infra/cloud/fly/platform.fly.toml` | the shared config + `platform.production.overlay.toml`, rendered to `platform.production.fly.toml` (gitignored) |

Production-specific properties, all enforced before anything is written:

- The app name is NOT overridable: the environment is one app, and the
  per-service apps are never created.
- The local env file is PARSED with an allow-list, never sourced into the
  script's shell. It contributes the source keys and the Fly org; the
  environment, the app, the gates and the facts are the manifest's and
  are `readonly` in the script, so a copy of the staging env file cannot
  point the production bootstrap at staging.
- A value that still carries a staging/dev hostname, a placeholder or a
  localhost address is REFUSED by the provisioner before any Fly mutation
  (the bootstrap runs the provisioner in `--dry-run` mode first).
- The deploy is gated twice: `--deploy` AND the environment's deploy gate
  variable. The migrations carry their own gate, because they change the
  database.
- The effective Fly config is the shared topology plus a small overlay
  (app name, CORS origins, probe cadence). An overlay may set `app` and
  the five environment-owned `[env]` keys and nothing else, so it cannot
  fork the platform topology; and the overlay's app name must be one of
  the environment's own apps, so a stale overlay cannot deploy
  production to staging.

Production live provisioning (create the Neon branch, create the app, set
the spend limit, publish DNS) is the operator sequence in
`docs/specs/production-environment-provisioning-tech-design.md` Slice D.


## PR strategy

WS1 shipped as five stacked PRs, all merged in August 2026:

1. **PR #1 ✅:** tasks-api proof-of-concept. Demonstrates the layout, the Fly spec shape, the Dockerfile pattern, and the CI workflow pattern. [PR #514, merged 2026-08-23]
2. **PR #2 ✅:** budget-api slice (mirrors PR #1). [PR #527, merged 2026-08-24]
3. **PR #3 ✅:** auto-post-worker Fly app (separate process; builds from content-scheduler-api source; **no HTTP exposure**). Added `infra/cloud/fly/auto-post-worker.fly.toml` + `infra/cloud/docker/auto-post-worker.Dockerfile` + `.github/workflows/deploy-staging-auto-post-worker.yml`. No Prisma `release_command` (worker does reconciliation in code, not as part of canary deploy) and no `http_service` block. [PR #528, merged 2026-08-24]
4. **PR #4 ✅:** `bootstrap-staging.sh` + `env/.env.example` + per-service `.env.example` files. [PR #529, merged 2026-08-25]
5. **PR #5 ✅:** `docs/systems/cloud-platform.md` (durable AC4 doc) + `docs/runbooks/cloud-deployment-rollback.md` (that runbook was retired in PR #583 along with all `docs/runbooks/` artefacts — the rollback command + verify sequence is preserved in `docs/specs/cloud-deployment-foundation-tech-design.md`). [PR #530, merged 2026-08-25]

**Those slices describe the retired per-service staging topology.** The four per-service Fly apps they deployed were destroyed on 2026-11-07 and replaced by the single consolidated `sindustries-platform-staging` app — one Machine, four supervisor children (`infra/cloud/fly/platform.fly.toml`, `docs/systems/cloud-platform.md`). The per-service `fly.toml` / Dockerfile / deploy-workflow files named above stay in the tree only until the cutover cleanup in `docs/runbooks/platform-consolidation-rollback.md` §5 deletes them; that runbook also holds the rollback procedure for the current topology.

Stacking rationale: each slice is reviewable in isolation (~150 LoC); Quinn can steer on PR #1 before Rowan replicates the pattern to budget-api and the worker.

### Note on the auto-post-worker source path

The worker builds from `services/content-scheduler-api/src/workers/autoPostWorkerMain.ts` — Quinn's APPROVED review on PR #508 explicitly approved "implementation PRs can stack on top" of the content-scheduler extraction, which landed as `services/content-scheduler-api`. There is no standalone `services/auto-post-worker/` workspace, so there is nothing to retarget: the platform image copies the `services/content-scheduler-api` tree (`infra/cloud/docker/platform.Dockerfile`) and the supervisor starts the worker as a queue-bound child with no HTTP listener (`npm run content-scheduler:worker --workspace services/content-scheduler-api`, wired in `infra/cloud/platform/platform-services.mjs`). The per-service worker Dockerfile and Fly spec still in the tree are retired artefacts awaiting the §5 cleanup, not the build path.
