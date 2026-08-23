---
status: draft
task_id: b2f62c36-6367-435b-a329-9c55ad62c551
product_spec: /Users/quinnstoffer/.openclaw/workspace/brain/tasks/specs/open/cloud-deployment-foundation.md
shipped_pr: null
shipped_date: null
---

# Cloud Deployment Foundation — Tech Design

## Product spec link

- Product spec: `/Users/quinnstoffer/.openclaw/workspace/brain/tasks/specs/open/cloud-deployment-foundation.md`
- Migration index: `/Users/quinnstoffer/.openclaw/workspace/brain/tasks/specs/open/sindustries-cloud-migration.md`
- Task API detail: `http://localhost:4001/api/v1/tasks/b2f62c36-6367-435b-a329-9c55ad62c551`

## Task and repository

- Task ID: `b2f62c36-6367-435b-a329-9c55ad62c551`
- Task title: `💻 Establish cloud deployment foundation`
- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-b2f62c36-cloud-deployment-foundation`
- Worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-b2f62c36-cloud-deployment-foundation`

## Product intent summary

SIndustries needs a reproducible production-like cloud target before the wider migration (AC1). The destination must be reachable from the public internet, run the same SIndustries services the local dev stack runs, hold its data in a separately owned cloud database (AC2), expose health checks plus a controlled deploy/rollback path (AC3), and ship documented ownership for environments, domains, and credentials (AC4).

This task is the foundation. The next workstream (`Cloud staging environment`) will exercise representative authenticated workflows against this target. The foundation here is concerned with the destination itself, not with the workflows it will eventually host.

## Service boundary and data ownership

- **Cloud platform choice — Fly.io** (`primary_region = 'syd'`). The repo already has a Fly.io deployment for `gymtrack-mcp` (`services/gymtrack-mcp/fly.toml`, `services/gymtrack-mcp/Dockerfile`). Choosing a different platform for the rest of the services would create two operational runbooks and two sets of domain/DNS ownership without a clear reason. The audit precedent and the existing prodlike dev stack suggest minimizing platform sprawl. Alternative is called out explicitly in Open Questions.
- **Database — managed Postgres on Neon** (Sydney region, separate Neon project from any future production project). The runtime config will keep the same `DATABASE_URL` env var the existing services already read, so no application code changes are required for the data plane.
- **Cache/queue — managed Redis on Upstash** (or Fly Redis if the workstream owner prefers one vendor). Same principle: keep the same `REDIS_URL` env var the existing services already read so the bullmq adapter and session/redis consumers from PR #411 (#issue 6492813a) work unchanged.
- **Domain ownership** — the foundation reserves the `sindustries.dev` and `staging.sindustries.dev` namespaces but does not provision DNS records yet. DNS is the next workstream's responsibility (it requires the actual hostname to be live before HTTPS can be wired up).
- **Service ownership** — domain ownership of the application services stays in `services/tasks-api`, `services/budget-api`, `services/gymtrack-mcp`. The cloud platform is the runtime; the application services are unchanged.

## `.openclaw` boundary notes

- **Owner-supplied secrets** — actual cloud credentials (Fly.io API token, Neon connection string, Upstash credentials, DNS provider token) are Quinn-owned and **must not** be committed to the repo. This task writes the wiring in `infra/cloud/fly.*` and a redacted `infra/cloud/.env.example` only. Real values land in Fly.io's encrypted secrets store and (for local-target verification) in Quinn's `.openclaw` environment.
- **Owner-supplied CI token** — GitHub Actions deploy workflow will reference a `FLY_API_TOKEN` repository secret. Posting `[openclaw-needed]` with the secret name + scope is in scope; writing the live token is not.
- **Owner-supplied domains** — DNS records are NOT touched in this task. The expectation is that Quinn owns the registrar and any DNS-side validation. The plan only references the AWS/Cloudflare/hetzner token Quinn already has.
- **No `.openclaw` cron changes** — the auto-deploy/scheduled cleanup is a GitHub Actions cron, owner-supplied, and lives in the repo.

## Implementation plan

### 1. Platform choice documentation

Add `docs/systems/cloud-platform.md` describing:

- Platform: Fly.io (rationale, alternatives considered).
- Region: `syd` (closest to Tom/Quinn geography, also where the existing gymtrack-mcp lives).
- Cost model: free tier + small instances for staging; track monthly cost per app.
- Account ownership: who owns the Fly.io org, who has billing, who can deploy.
- Handover: what the recipient needs to know to operate / deploy / debug.

This document is the durable answer to AC4.

### 2. Repository-side deployment artifacts

Two new top-level layout areas:

```
infra/cloud/
  README.md                  # index of what is here and why
  fly/
    tasks-api.fly.toml       # Fly.io app spec for tasks-api
    budget-api.fly.toml      # Fly.io app spec for budget-api
    auto-post-worker.fly.toml# separate worker process for content scheduler
  docker/
    tasks-api.Dockerfile     # build image for tasks-api
    budget-api.Dockerfile   # build image for budget-api
  scripts/
    bootstrap-staging.sh     # one-shot, idempotent: create apps, attach secrets, run migrations
  env/
    .env.example             # redacted env var contract (no live values)
    tasks-api.env.example
    budget-api.env.example
.github/workflows/
  deploy-staging-tasks-api.yml
  deploy-staging-budget-api.yml
```

This directory is the single source of truth for how to recreate the staging destination. AC1 ("can be created or reproduced from documented configuration") is satisfied by `bootstrap-staging.sh` plus the env contract.

### 3. Service Dockerfile convention

Follow the existing `services/gymtrack-mcp/Dockerfile` pattern: `node:22-alpine` base, copy package.json + lockfile, install, copy source, non-root user, `NODE_ENV=production`. Each service Dockerfile must:

- Listen on the port Fly.io expects (`internal_port` in the toml — to be wired up).
- Use the existing `prestart`/`predev` Prisma generate lifecycle so migrations apply on boot.
- Skip dev dependencies in production install (`npm ci --omit=dev`).
- Include a `/healthz` endpoint that returns `200 OK` when the service is ready to serve traffic. The existing services already have a `healthz` route; verify and document.

### 4. Fly.io app specs

Each service gets a `fly.toml` that mirrors the existing `services/gymtrack-mcp/fly.toml`:

- `app = 'sindustries-<service>-staging'` (concrete names live in `infra/cloud/README.md`).
- `primary_region = 'syd'`.
- `[http_service]` block with `internal_port`, `force_https = true`, sensible `auto_stop_machines` / `min_machines_running` for staging.
- `[[vm]]` with `cpu_kind = 'shared'`, `cpus = 1`, `memory = '1gb'`.
- `[[services.tcp_checks]]` and `[[services.http_checks]]` referencing the `/healthz` endpoint.

The auto-post worker is a separate Fly app with `processes = ['app']` for the worker process. It does not accept HTTP traffic; it runs the long-running queue consumer.

### 5. Cloud data plane

- **Neon project** (separate from any future production project):
  - Branch: `staging` (Neon branches are intended for ephemeral environments; the staging branch persists alongside `main`).
  - Region: AWS Sydney.
  - Connection string flows into Fly secrets as `DATABASE_URL` (and `DIRECT_URL` for Prisma migrate).
- **Upstash Redis** (or Fly Redis):
  - Database name: `sindustries-staging`.
  - TLS required. Connection string flows into Fly secrets as `REDIS_URL` and `CONTENT_SCHEDULER_REDIS_URL`.
- **Local-dev separation verified** — bootstrap script asserts that the staging `DATABASE_URL` does NOT contain `localhost` and does NOT contain the local dev stack's default credentials. This is the only place we exercise the "separate from local development data" requirement; the rest of the platform is just configuration.

### 6. Bootstrap script

`infra/cloud/scripts/bootstrap-staging.sh`:

- Idempotent: re-running does not destroy existing apps.
- Verifies `fly`, `neonctl`, `upstash` CLIs are installed and authenticated.
- Creates missing Fly apps (`fly apps create ...`).
- Sets Fly secrets from local env (the script sources a `infra/cloud/.env.local` file that Quinn never commits).
- Runs Prisma migrations against the staging Postgres (`fly ssh console -C "npx prisma migrate deploy"`).
- Performs a smoke deploy (`fly deploy --strategy canary`).
- Surfaces a final report with app URLs and the smoke-check result.

The script is the operational answer to AC1 (reproducible) and AC3 (controlled rollback — Fly's `image` flag plus the canary strategy).

### 7. CI/CD

Two GitHub Actions workflows (one per app) that:

- Trigger on push to `main` only when the relevant service path is touched (`paths:` filter).
- Use `flyctl/actions` with the `FLY_API_TOKEN` repo secret.
- Run `fly deploy --strategy canary` for each app.
- Run a post-deploy smoke check (curl the `/healthz` endpoint).
- Comment on the relevant PR with the deployed URL.

The worker is also deployed on push when its path changes. The worker uses `--strategy canary` and verifies the consumer is processing the queue.

### 8. Health checks and rollback

- **Health checks** — `[[services.http_checks]]` in each `fly.toml` points at `/healthz`. Failed checks automatically remove the machine from the load balancer. The smoke check in CI re-uses the same endpoint.
- **Rollback** — `fly releases` lists versions; `fly releases rollback <v>` returns to a previous known-good release. Documented in `docs/systems/cloud-platform.md` and in `infra/cloud/README.md`.
- **Manual rollback runbook** — `docs/runbooks/cloud-deployment-rollback.md` (new file): one-page runbook covering the failure modes that warrant rollback, the `fly releases rollback` command, and the post-rollback verification step.

### 9. Documentation handover

- `docs/systems/cloud-platform.md` — durable platform description (AC4).
- `infra/cloud/README.md` — operator-facing index of artefacts.
- `infra/cloud/env/.env.example` — the env-var contract (no live values).
- `docs/runbooks/cloud-deployment-rollback.md` — rollback runbook.
- Update `docs/systems/tasks.md` (in a separate, much smaller PR) to add a paragraph on where the cloud deploy artefacts live. **Out of scope for this PR** — that paragraph is a system-spec touch-up, not a feature of this task.

## Data model and API contract changes

**None.** This task adds deployment artefacts and operator documentation. No application code, no schema, no API contract changes. The services consume the same `DATABASE_URL`, `REDIS_URL`, and existing env vars they already use locally.

If a missing env var is discovered during the bootstrap (e.g., the apps reference a key that isn't documented anywhere), this task adds the missing entry to the service's `.env.example` and surfaces it in the runbook — it does not extend the deploy to add a new runtime feature.

## Workflow, cron, and skill changes

- **Cron:** none in `.openclaw`. GitHub Actions scheduled runs (e.g., weekly "staging deploy verification" smoke) are repo-owned and tracked in `.github/workflows/`.
- **Skills:** no agent skill changes. The `agents/skills/ops/tasks-api` skills are unrelated to the deployment target.
- **Workflow:** the lobster workflow is unchanged. The fact that the deploy target is now a real environment does not change task state semantics.

## Test plan

### Automated tests

- **Shellcheck** on `bootstrap-staging.sh` and the GitHub Actions YAML.
- **`fly config validate`** against each `fly.toml` (Fly.io's own validator, runs in CI).
- **Dockerfile lint** — `hadolint` in CI for each new Dockerfile.
- **Smoke test** — `curl` against the deployed `/healthz` endpoint, asserting 200.
- **Round-trip auth flow** — a Playwright/puppeteer script or `curl` chain that:
  1. Hits the staging `tasks-api` `/healthz` and gets 200.
  2. Reads the staging `Database` via a single SELECT to prove it's not empty / it's the staging DB.
  3. Asserts the staging `DATABASE_URL` host is **not** `localhost` and **not** the local dev DB.

These run as part of the SMOKE job in the GitHub Actions workflow, not as unit tests in the service repos.

### AC verification matrix

| AC | Verification approach | Planned evidence |
| --- | --- | --- |
| AC1 | Bootstrap script runs end-to-end: creates the missing Fly apps, sets secrets, runs migrations, deploys, passes the smoke check. Re-running the script is idempotent. | Output of `bootstrap-staging.sh` (creates + deploys + smoke = green) plus a CI workflow that exercises bootstrap in a non-prod sandbox. The local target verification is owner-supplied (Quinn runs the script once with their live secrets). |
| AC2 | Bootstrap script asserts `DATABASE_URL` host is not `localhost` and not the local dev stack. Staging Postgres is a separate Neon project. The same service binary connects to both local and staging Postgres by changing the env var only. | Bootstrap smoke output + the assertion text in the script. Plus a documented test in `infra/cloud/README.md` that demonstrates the same `tasks-api` image running against local Postgres and against staging Postgres via env-var swap. |
| AC3 | `fly releases rollback <v>` is documented and exercised in the rollback runbook. The CI workflow uses `--strategy canary` for every production-like deploy. | Rollback runbook file + a one-time manual rollback exercise recorded as a `git`-tracked note in `docs/runbooks/cloud-deployment-rollback.md`. |
| AC4 | `docs/systems/cloud-platform.md` covers platform choice, region, account ownership, cost expectations, and handover. The `infra/cloud/README.md` indexes the artefacts. | The two doc files plus a checklist in the PR description that confirms each AC4 bullet is satisfied. |

### Manual verification

- Quinn runs `bootstrap-staging.sh` once with their live tokens and confirms the smoke check passes.
- Quinn performs the rollback runbook manually once and confirms the recovery path works.
- Owner-supplied steps are documented in `infra/cloud/README.md` so a future operator can repeat them without re-deriving the procedure.

## Open questions and risks

1. **Platform choice — Fly.io vs Render vs Railway.** Chosen Fly.io for consistency with the existing `gymtrack-mcp` deployment. Render or Railway would each come with their own operational quirks. If Quinn wants a different platform, the bootstrap script and CI workflows need to change but the contract (env vars, health checks, deployment artefacts) stays the same. Flag for review before approval.
2. **Neon vs Supabase vs Fly Postgres.** Chosen Neon because the existing data plane already expects "managed Postgres with a connection string" and Neon has a Sydney region. Fly Postgres would lock-in to Fly, which is a downside. Supabase is overkill (we don't need RLS or auth for this task). Flag for review.
3. **Upstash vs Fly Redis.** Upstash has a generous free tier and TLS'd connections from anywhere. Fly Redis is convenient but couples the queue to the same vendor as the apps. Default to Upstash unless Tom says otherwise.
4. **Domain and DNS.** This task reserves the `*.sindustries.dev` namespace in docs but does not provision DNS. The next workstream needs the actual certificate to deploy. The plan is for Quinn to register `sindustries.dev` (or hand off the existing one) and create CNAME records. Time estimate: 30 minutes once the registrar account is in scope.
5. **Outbound IP allowlist for Akahu.** The budget-api calls Akahu. Akahu's IP allowlist must add the Fly.io outbound IPs for the staging region. If Akahu's allowlist is the production IP only, the staging app may be denied. Plan: request the Fly.io outbound IP range once and wire it into the Akahu app. Quinn owns the Akahu account.
6. **Content Scheduler worker idle cost.** The worker is a long-running Fly machine. Setting `auto_stop_machines = 'stop'` and `min_machines_running = 0` makes it cheaper but means a short delay when a long-idle auto-post is scheduled. For staging, the default is `min_machines_running = 1` (always-on) so the smoke test is reliable. Document the trade-off.
7. **Bootstrap script authority.** The bootstrap script is a one-shot tool Quinn runs. It does not run in CI. CI runs the deploy workflow only. This is a deliberate split — running bootstrap in CI would require CI to have owner-supplied cloud credentials, which we don't want to grant.
8. **What happens if the cloud foundation drifts.** A drift detection cron (separate workstream) compares the staging environment to the repo's expected `infra/cloud/` tree. Out of scope here.
9. **No code-garden precedent for infra.** The repo's existing code-garden policy targets audit findings and small fixes. This task is large enough that it is not a code-garden candidate — it is a feature task that ships a new `infra/cloud/` subtree. If the policy needs to carve out an exception for infra work, that is a separate editorial call.
10. **No backward compatibility required.** This task is the first time the staging environment exists. There is no prior state to preserve.

## AC matrix (cross-reference)

| AC | Spec text | Implementation reference |
| --- | --- | --- |
| AC1 | Required SIndustries services have a documented production-like cloud deployment target. | `infra/cloud/fly/*.toml`, `infra/cloud/docker/*.Dockerfile`, `infra/cloud/scripts/bootstrap-staging.sh`, `.github/workflows/deploy-staging-*.yml`. |
| AC2 | The cloud data environment has the required connectivity, access controls, and separation from local development data. | Neon Postgres project + Upstash Redis DB, secret-managed connection strings, smoke check asserts staging `DATABASE_URL` is not the local dev host. |
| AC3 | A service deployment can be health-checked and safely reverted to a previous known-good version. | `fly.toml` http_checks + `/healthz` route + `fly releases rollback <v>` + `docs/runbooks/cloud-deployment-rollback.md`. |
| AC4 | Cloud resource ownership, domains, and operational prerequisites are documented for handover. | `docs/systems/cloud-platform.md` + `infra/cloud/README.md` + `infra/cloud/env/.env.example`. |
