# Cloud Platform — handover document

**Type:** System reference (handover)
**Status:** Implemented for staging
**Last updated:** 2026-08-25
**Owner:** Rowan (engineering); Quinn owns the live cloud account + secrets
**Repos:** `Stoffer-Industries/sindustries`
**App:** Staging target on Fly.io (Sydney region) for `tasks-api`, `budget-api`, `auto-post-worker`

> **Naming history:** this workstream was originally scoped as a separate "SIndustries Cloud Platform" spec (task `b2f62c36`). The artefacts land under `infra/cloud/` plus two handover docs (`docs/systems/cloud-platform.md` and `docs/runbooks/cloud-deployment-rollback.md`). Live deployment to production is a follow-on tracked under the broader cloud migration plan (tasks `206927ed`, `2850c5ac`, `020f423e`, `f2c23e26`, `d37681e1`, `4b3d6e9c`); this document covers the **staging** target only.

---

## Context

SIndustries runs a multi-service Node/TypeScript stack (`services/tasks-api`, `services/budget-api`, `services/gymtrack-mcp`, `services/content-scheduler-api`) against a Postgres + Redis back-end. Historically the stack has been operated from Tom's Mac mini. The cloud workstream (task `b2f62c36`) creates the first production-like cloud target so the services can be deployed from CI, scaled independently of the developer's machine, and replicated for new operators without sharing local credentials.

For the design rationale see [`docs/specs/cloud-deployment-foundation-tech-design.md`](../specs/cloud-deployment-foundation-tech-design.md). For the operator-facing index of artefacts see [`infra/cloud/README.md`](../../infra/cloud/README.md). For rollback see [`docs/runbooks/cloud-deployment-rollback.md`](../runbooks/cloud-deployment-rollback.md).

This document exists so a new operator (or Quinn returning after a break) can answer the four handover questions — *what is this, who owns what, how much does it cost, and what happens when it breaks* — without having to reverse-engineer `infra/cloud/`.

---

## Decision summary

| Concern                          | Choice                                                   | Owner  | Lives in                                                      |
| -------------------------------- | -------------------------------------------------------- | ------ | ------------------------------------------------------------- |
| Compute                          | Fly.io (managed VMs, regional)                           | Quinn  | `infra/cloud/fly/*.fly.toml`                                  |
| Application packaging            | Dockerfiles, per service                                 | Rowan  | `infra/cloud/docker/*.Dockerfile`                             |
| HTTP services (tasks-api, budget-api) | Fly `http_service` block + `http_checks` to `/health`  | Rowan  | `infra/cloud/fly/{tasks-api,budget-api}.fly.toml`             |
| Long-running worker              | Separate Fly app process (no HTTP)                       | Rowan  | `infra/cloud/fly/auto-post-worker.fly.toml`                   |
| Primary database                 | Neon managed Postgres (syd region, branch-per-env)       | Quinn  | Neon dashboard (URLs in `infra/cloud/env/*.env.example`)      |
| Queue + cache                    | Upstash managed Redis (TLS, pay-per-request)             | Quinn  | Upstash dashboard (URLs in `infra/cloud/env/*.env.example`)   |
| Object storage                   | (not used yet)                                           | —      | —                                                             |
| Observability                    | OpenTelemetry via `@sindustries/otel-node` → collector   | Shared | `infra/cloud/env/*.env.example` (OTEL_EXPORTER_OTLP_ENDPOINT) |
| Domain                           | `sindustries.dev` (Quinn-registered)                     | Quinn  | DNS provider                                                  |
| CI deploy                        | GitHub Actions, path-filtered per service, canary deploy | Rowan  | `.github/workflows/deploy-staging-*.yml`                      |
| Secrets                          | Fly app secrets + GH repo secrets                        | Quinn  | `fly secrets set …` (operator CLI); `secrets.FLY_API_TOKEN`   |
| First-time setup                 | Idempotent local bootstrap script                        | Quinn  | `infra/cloud/scripts/bootstrap-staging.sh`                    |
| Rollback                         | `fly releases rollback <v>` per Fly app                   | Quinn  | [`docs/runbooks/cloud-deployment-rollback.md`](../runbooks/cloud-deployment-rollback.md) |

All env-var **names** referenced by deploy workflows are reviewable in the repo. Only the **values** are operator-owned.

---

## Why Fly.io (and what we considered)

**Decision:** Fly.io for compute, Neon for Postgres, Upstash for Redis.

### Fly.io

- **Pros.** Fast deploys from a Dockerfile (no platform-specific buildpack). Built-in canary deploys + releases history. Generous free tier + simple shared-cpu pricing. Sydney region available (matches Tom/Quinn geography + Akahu/NZ latency profile). Process-group isolation matches our `gymtrack-mcp` precedent (one Fly app per service). No VPC/networking setup required to start.
- **Cons.** Tied to Fly's machine image + supervisor model. No first-party managed Redis (would have to add Upstash anyway). VM-only — no scale-to-zero for HTTP services without `auto_stop_machines=stop`, which we use for staging cost control.
- **Alternatives considered.**
  - **Render** — easy deploys but no canary strategy out of the box; the team has no operational history with Render.
  - **Railway** — opinionated runtime; would constrain the Dockerfile-based build pattern; no canary.
  - **AWS ECS / Fargate** — far more moving parts (VPC, ALB, IAM, ECR). Justified only when we already have an AWS footprint, which we don't.
  - **GCP Cloud Run** — great scale-to-zero, but cold-start latency for the tasks-api (≤ 2s P99 today) would worsen; no built-in canary.
  - **Hetzner / bare-metal** — cheapest compute, but we'd hand-roll deploys, networking, and observability. Out of scope for a foundation milestone.

Fly.io is the right shape for the foundation milestone: low operational overhead, just enough production primitives (canary, releases, regional placement, `http_checks`), and an exit path (Dockerfiles are portable).

### Neon

- **Pros.** Managed Postgres with branch-per-env (Neon's signature feature) lets us spin up an isolated DB for a PR without standing up a new cluster. Sydney region. `?schema=<service>` URL suffix keeps service data isolated in a single cluster for staging cost; production can split into per-service Neon projects.
- **Cons.** Vendor lock-in for the branch workflow. Serverless-tier cold start (~500ms) on first query.
- **Alternatives considered.** Fly Postgres (single-region only, shared cluster), Supabase (more about auth + storage, not our shape), RDS (heavier than we need for staging), self-hosted (operational burden).

### Upstash

- **Pros.** Serverless Redis with TLS by default; scales to zero so the staging queue costs near-nothing when idle. Sydney region. Keeps the existing `REDIS_URL` env-var contract (the `services/tasks-api` BullMQ adapter from PR #411 and `services/gymtrack-mcp` Redis consumers work as-is).
- **Cons.** Vendor lock-in for the serverless-pricing model. REST API surface as an alternative to `rediss://` for locked-down environments.
- **Alternatives considered.** Fly Redis (would couple queue vendor to compute vendor — explicit non-goal for foundation), self-hosted Redis (operational burden), Memcached (no persistence, no BullMQ).

---

## Region

All three services run in **`syd` (Sydney, Australia)**. Reasoning:

1. Matches Tom/Quinn geography — operator on-call windows align with business hours.
2. Akahu (NZ open-banking) integration in `services/budget-api` benefits from low latency to NZ endpoints.
3. Twitter/X API has no regional preference, so region is irrelevant for `services/tasks-api` and `services/content-scheduler-api`.
4. Closest Fly.io region to the Auckland-based `services/gymtrack-mcp` for any future cross-region latency testing.

Production may move to `syd` or `nrt` (Tokyo) once traffic patterns emerge. The `primary_region` field in each `fly.toml` is the single change point.

---

## Cost model

Current staging cost (3 services, near-idle):

| Resource                                        | Monthly estimate         | Notes                                                |
| ----------------------------------------------- | ------------------------ | ---------------------------------------------------- |
| Fly — 3 × `shared-cpu-1x` 1 GB machines         | ~$15/mo                  | `auto_stop_machines=stop` keeps idle cost low        |
| Neon — staging branch (free tier)               | $0                       | Free tier covers staging; production will move to Pro |
| Upstash — staging Redis (free tier)             | $0                       | Pay-per-request model; staging won't exceed free     |
| Domain — `sindustries.dev` (annual)             | ~$15/yr (~$1.25/mo)      | Quinn-registered                                     |
| GH Actions (deploys on push to main)            | $0                       | Within repo free tier                                |
| **Total staging**                               | **~$16/mo**              |                                                      |

Production cost projection (when traffic is real): dominated by Neon compute-hours + Upstash request volume. Re-estimate when the production cutover task (`020f423e`) starts.

---

## Account / ownership / billing

| Asset                                | Owner  | How it's paid                                |
| ------------------------------------ | ------ | -------------------------------------------- |
| Fly.io organisation `sindustries`    | Quinn  | Quinn's personal card; will move to SIndustries billing once that's a legal entity |
| Neon account + projects              | Quinn  | Same                                         |
| Upstash account                      | Quinn  | Same                                         |
| `sindustries.dev` domain             | Quinn  | Same                                         |
| GH repo secrets (`FLY_API_TOKEN`)    | Quinn  | n/a (no cost)                                |
| GH Actions minutes                   | GitHub | Within the org's plan                        |

This is a staging foundation — Quinn is the single point of contact for credential rotation and billing. When the SIndustries entity exists, transfer all four accounts.

---

## Domain reservations

| Domain             | Use                                       | Status                         |
| ------------------ | ----------------------------------------- | ------------------------------ |
| `sindustries.dev`  | Wildcard CNAMEs to Fly app subdomains     | Quinn-registered, DNS pending  |

Until DNS lands, deploys use the default `*.fly.dev` URLs:

- `https://sindustries-tasks-api-staging.fly.dev/health`
- `https://sindustries-budget-api-staging.fly.dev/health`
- `https://sindustries-auto-post-worker-staging.fly.dev` (no HTTP — Fly supervises by PID)

Once DNS lands, point `<service>.staging.sindustries.dev` CNAMEs at the matching `*.fly.dev` host and update the smoke check URLs in the deploy workflows.

---

## Credential boundary

The `.openclaw` boundary Quinn confirmed on the PR #508 review (merged `d6ee2d8`):

- **Quinn owns** the live values: `FLY_API_TOKEN`, Neon `DATABASE_URL` / `DIRECT_URL`, Upstash `REDIS_URL` / `CONTENT_SCHEDULER_REDIS_URL`, DNS provider token. These never enter the repo.
- **Quinn registers** the GitHub repo secrets under fixed names (`FLY_API_TOKEN` is the only one CI uses today). Workflow YAML references `secrets.FLY_API_TOKEN` by name.
- **Rowan ships** only env-var names, Fly app specs, Dockerfiles, and deploy workflows. The workflow templates include `FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}` so the deploy job picks up Quinn's value at job time.
- **Quinn runs** `infra/cloud/scripts/bootstrap-staging.sh` once. It reads `infra/cloud/.env.local` (gitignored) and applies Quinn's per-service `TASKS_API_*`, `BUDGET_API_*`, `AUTO_POST_WORKER_*` prefixed env vars via `fly secrets set`.
- **Quinn rotates** any secret out-of-band. Rotation procedure for tokens with downstream ciphertext rows (e.g. Akahu) is the existing [`docs/runbooks/rotate-akahu-access-tokens.md`](../runbooks/rotate-akahu-access-tokens.md); no rotation procedure is needed for non-derived secrets.

A new operator joining Quinn's seat gets the same out-of-band onboarding path: 1Password (or equivalent) handoff for `FLY_API_TOKEN` + Neon + Upstash + DNS, plus the `infra/cloud/.env.local` template.

---

## Deploy procedure (reference)

Per-service deploy happens automatically on push to `main` via `.github/workflows/deploy-staging-<service>.yml` (path-filtered to the service's source + `infra/cloud/` + the workflow file itself). Manual override is via `workflow_dispatch`.

The CI workflow runs `flyctl deploy --strategy canary` then a smoke check:

- **HTTP services** — curl `https://<app>.fly.dev/health` (10 retries, 5s apart). The `/health` route is mounted in `services/tasks-api/src/app.ts` (and the equivalent in budget-api); Fly's `[[services.http_checks]]` block in the `fly.toml` hits the same route on the 15s interval.
- **Worker** — `flyctl logs --app <app> --no-tail | grep '\[content-scheduler-worker\] starting (adapter=bullmq)'`. A clean boot line means Prisma connected + the BullMQ worker registered. Fly's process supervisor handles PID liveness; there's no `http_service` block to monitor.

If the smoke check fails, the deploy job exits non-zero. Quinn/Lox investigates via `flyctl logs --app <app>` and either forward-fixes or rolls back per [`docs/runbooks/cloud-deployment-rollback.md`](../runbooks/cloud-deployment-rollback.md).

---

## First-time environment creation

Quinn runs `infra/cloud/scripts/bootstrap-staging.sh` once. The script:

1. Verifies the `fly`, `neonctl`, and `upstash` CLIs are installed and authenticated.
2. Creates the missing Fly apps (`fly apps create ...`).
3. Reads `infra/cloud/.env.local` (gitignored) and applies each service's `TASKS_API_*` / `BUDGET_API_*` / `AUTO_POST_WORKER_*` prefixed env vars to the corresponding Fly app via `fly secrets set`. The prefix is stripped at apply time.
4. Optionally runs Prisma migrations (`--migrate`) and/or deploys (`--deploy`).
5. Surfaces a final report with app URLs and the smoke-check result.

The script is **idempotent** — re-running it does not destroy existing apps or secrets.

---

## Out of scope (today)

| Concern                                | Why                                                                | Tracked under                                       |
| -------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------- |
| Production cutover                     | Foundation (staging) milestone first                               | `020f423e` (Execute production cloud cutover)      |
| Production runtime config hardening    | Quinn-owned secrets; staging proves the contract first             | `206927ed` (Define and secure production runtime config) |
| Observability stack + alerts           | `@sindustries/otel-node` is wired but the collector host is TBD    | `4b3d6e9c` (Add hosted observability + alerts)      |
| Multi-region                            | Single-region (`syd`) is enough for staging                        | (no task yet)                                       |
| Auto-scaling                            | Staging uses `auto_stop_machines=stop`; production scaling is TBD   | (no task yet)                                       |
| WAF / rate limiting                    | Fly's per-app rate limits are off in staging                       | (no task yet)                                       |

---

## Related documents

- [`docs/specs/cloud-deployment-foundation-tech-design.md`](../specs/cloud-deployment-foundation-tech-design.md) — design rationale, WS1–WS4 split, AC coverage matrix.
- [`infra/cloud/README.md`](../../infra/cloud/README.md) — operator index, Quinn-vs-Rowan ownership table, PR-stack history.
- [`infra/cloud/env/.env.example`](../../infra/cloud/env/.env.example) — cross-service env contract template.
- [`infra/cloud/scripts/bootstrap-staging.sh`](../../infra/cloud/scripts/bootstrap-staging.sh) — Quinn-runnable first-time setup.
- [`docs/runbooks/cloud-deployment-rollback.md`](../runbooks/cloud-deployment-rollback.md) — rollback procedure.
- [`docs/runbooks/rotate-akahu-access-tokens.md`](../runbooks/rotate-akahu-access-tokens.md) — secret rotation precedent.