# Cloud Platform Artifacts

SIndustries cloud deployment artefacts. Owner: Rowan. Approved tech design: [`docs/specs/cloud-deployment-foundation-tech-design.md`](../../docs/specs/cloud-deployment-foundation-tech-design.md).

This subtree is the **single source of truth** for how to recreate the SIndustries staging cloud target. It is intentionally split from `services/<svc>/` so the application services stay runnable from the repo root without depending on cloud-platform concerns.

## Layout

```
infra/cloud/
├── README.md                   # this file
├── fly/                        # Fly.io app specs (one per Fly app)
│   └── tasks-api.fly.toml
├── docker/                     # Service Dockerfiles (referenced by the fly.toml files)
│   └── tasks-api.Dockerfile
├── env/                        # Env-var contracts (no live values — owner-supplied)
│   ├── .env.example            # cross-service env contract
│   └── tasks-api.env.example
└── scripts/                    # Owner-supplied operational scripts (Quinn runs locally)
    └── bootstrap-staging.sh
```

CI lives at `.github/workflows/deploy-staging-<service>.yml` (sibling to this subtree).

## Services (planned)

| Fly app                       | Source                       | Notes                                                                                  |
| ----------------------------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| `sindustries-tasks-api-staging`        | `services/tasks-api/`        | Tasks/approvals/tags/analytics/feature-task API. Health at `/health`. Port 4001.       |
| `sindustries-budget-api-staging`       | `services/budget-api/`       | Budget + Akahu integration. Health at `/health`. Port 4002.                            |
| `sindustries-auto-post-worker-staging` | `services/content-scheduler-api/src/workers/autoPostWorkerMain.ts` | Long-running BullMQ consumer. **Not** HTTP-exposed. Same Fly machine isolation rationale as the `gymtrack-mcp` precedent. |

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

Per service:

```sh
# 1. Set up secrets once (Quinn; idempotent — re-running `fly secrets set` is safe)
fly secrets set --app sindustries-tasks-api-staging \
  DATABASE_URL=... \
  REDIS_URL=... \
  CONTENT_SCHEDULER_REDIS_URL=... \
  CONTENT_SCHEDULER_API_BASE_URL=https://sindustries-content-scheduler-api-staging.fly.dev/api/v1 \
  ROWAN_TASKS_API_APPROVAL_TOKEN=... \
  CORS_ALLOWED_ORIGINS=https://mission-control.sindustries.dev

# 2. Deploy (CI does this on push to main; manual override via workflow_dispatch)
fly deploy --config infra/cloud/fly/tasks-api.fly.toml --strategy canary
```

The CI workflow runs `--strategy canary` for every deploy and curls `/health` as the post-deploy smoke check. Failed http_checks automatically remove the machine from the load balancer; rollback uses `fly releases rollback <v>` (see [`docs/runbooks/cloud-deployment-rollback.md`](../../docs/runbooks/cloud-deployment-rollback.md)).

## First-time environment creation

Quinn runs `infra/cloud/scripts/bootstrap-staging.sh` once. The script:

- Verifies the `fly`, `neonctl`, and `upstash` CLIs are installed and authenticated.
- Creates the missing Fly apps (`fly apps create ...`).
- Sets Fly secrets from a local `infra/cloud/.env.local` file (Quinn never commits this).
- Runs Prisma migrations against the staging Postgres (`fly ssh console -C "npx prisma migrate deploy"`).
- Performs a smoke deploy (`fly deploy --strategy canary`).
- Surfaces a final report with app URLs and the smoke-check result.

The script is idempotent — re-running it does not destroy existing apps.

## PR strategy

WS1 ships as stacked PRs:

1. **PR #1 (this slice):** tasks-api proof-of-concept. Demonstrates the layout, the Fly spec shape, the Dockerfile pattern, and the CI workflow pattern.
2. PR #2: budget-api slice (mirrors PR #1).
3. PR #3: auto-post-worker Fly app (separate process; builds from content-scheduler-api source; **no HTTP exposure**).
4. PR #4: `bootstrap-staging.sh` + `env/.env.example` + per-service `.env.example` files.
5. PR #5: `docs/systems/cloud-platform.md` (durable AC4 doc) + `docs/runbooks/cloud-deployment-rollback.md`.

Stacking rationale: each slice is reviewable in isolation (~150 LoC); Quinn can steer on PR #1 before Rowan replicates the pattern to budget-api and the worker.