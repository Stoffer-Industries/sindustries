# Cloud Platform — handover document

**Type:** System reference (handover)
**Status:** Implemented for staging
**Last updated:** 2026-10-07
**Owner:** Rowan (engineering); Quinn owns the live cloud account + secrets
**Repos:** `Stoffer-Industries/sindustries`
**App:** Staging target on Fly.io (Sydney region) for `tasks-api`, `budget-api`, `content-scheduler-api`, `auto-post-worker`

> **Naming history:** this workstream was originally scoped as a separate "SIndustries Cloud Platform" spec (task `b2f62c36`). The artefacts land under `infra/cloud/` plus `docs/systems/cloud-platform.md` as the handover doc. The prior `docs/runbooks/cloud-deployment-rollback.md` and `docs/runbooks/rotate-akahu-access-tokens.md` were removed in PR #583 (operational runbooks no longer live in this repo — see `agents/definitions/README.md` "Where operational runbooks live"); their content lives in `~/.openclaw/workspace/docs/infra/runbooks/` or, for the rollback steps, in `docs/specs/cloud-deployment-foundation-tech-design.md`. Live deployment to production is a follow-on tracked under the broader cloud migration plan (tasks `206927ed`, `2850c5ac`, `020f423e`, `f2c23e26`, `d37681e1`, `4b3d6e9c`); this document covers the **staging** target only.

---

## Context

SIndustries runs a multi-service Node/TypeScript stack (`services/tasks-api`, `services/budget-api`, `services/gymtrack-mcp`, `services/content-scheduler-api`) against a Postgres + Redis back-end. Historically the stack has been operated from Tom's Mac mini. The cloud workstream (task `b2f62c36`) creates the first production-like cloud target so the services can be deployed from CI, scaled independently of the developer's machine, and replicated for new operators without sharing local credentials.

For the design rationale see [`docs/specs/cloud-deployment-foundation-tech-design.md`](../specs/cloud-deployment-foundation-tech-design.md). For the operator-facing index of artefacts see [`infra/cloud/README.md`](../../infra/cloud/README.md). For rollback see `docs/specs/cloud-deployment-foundation-tech-design.md` "Rollback" section (the prior `docs/runbooks/cloud-deployment-rollback.md` was retired in PR #583; the runbook convention now lives in `~/.openclaw/workspace/docs/infra/runbooks/`).

This document exists so a new operator (or Quinn returning after a break) can answer the four handover questions — *what is this, who owns what, how much does it cost, and what happens when it breaks* — without having to reverse-engineer `infra/cloud/`.

---

## Decision summary

| Concern                          | Choice                                                   | Owner  | Lives in                                                      |
| -------------------------------- | -------------------------------------------------------- | ------ | ------------------------------------------------------------- |
| Compute                          | Fly.io (managed VMs, regional)                           | Quinn  | `infra/cloud/fly/*.fly.toml`                                  |
| Application packaging            | Dockerfiles, per service                                 | Rowan  | `infra/cloud/docker/*.Dockerfile`                             |
| HTTP services (tasks-api, budget-api, content-scheduler-api) | One Fly app, four child processes behind the nginx router's path-prefix routes; `http_checks` on the platform app | Rowan | `infra/cloud/fly/platform.fly.toml` (+ `infra/cloud/platform/nginx.conf`) |
| Long-running worker              | Child process inside the platform app (no HTTP listener) | Rowan  | `infra/cloud/platform/platform-services.mjs`                 |
| Primary database                 | Neon managed Postgres (syd region, branch-per-env)       | Quinn  | Neon dashboard (URLs in `infra/cloud/env/*.env.example`)      |
| Queue + cache                    | Upstash managed Redis (TLS, pay-per-request)             | Quinn  | Upstash dashboard (URLs in `infra/cloud/env/*.env.example`)   |
| Object storage                   | (not used yet)                                           | —      | —                                                             |
| Observability                    | OpenTelemetry via `@sindustries/otel-node` → collector   | Shared | `infra/cloud/env/*.env.example` (OTEL_EXPORTER_OTLP_ENDPOINT) |
| Domain                           | `sindustries.co.nz` (apex for production; `*.staging.sindustries.co.nz` for staging) — supersedes the foundation's `sindustries.dev` reservation per task `5cb4a8fe` | Quinn  | DNS provider + `infra/cloud/hostname-matrix.json` (machine-readable source of truth) |
| CI deploy                        | GitHub Actions, path-filtered deployable surface, canary deploy of the platform app | Rowan  | `.github/workflows/deploy-staging-platform.yml`               |
| Secrets                          | Fly app secrets + GH repo secrets                        | Quinn  | `fly secrets set …` (operator CLI); `secrets.FLY_API_TOKEN`   |
| First-time setup                 | Idempotent local bootstrap script                        | Quinn  | `infra/cloud/scripts/bootstrap-staging.sh`                    |
| Rollback                         | `fly releases rollback <v>` — app-wide on `sindustries-platform-staging` (shared fate) | Quinn  | `docs/specs/cloud-deployment-foundation-tech-design.md` "Rollback" section (the prior `docs/runbooks/cloud-deployment-rollback.md` was retired in PR #583) |

**The staging rows above are the current topology; the foundation decision is
history.** Since the 2026-11-07 cutover, staging is ONE Fly app
(`sindustries-platform-staging`, `infra/cloud/fly/platform.fly.toml`) carrying
all four processes — the four per-service staging apps were destroyed and are
not recreated. The per-service `fly.toml` files and the per-service
`deploy-staging-*.yml` workflows still sit in the repo, but they are no longer
dispatched: those workflows are `workflow_call`-only and `ci.yml` now calls
`deploy-staging-platform.yml` (and `deploy-staging-health-probe.yml`). Read
"Consolidated platform (task `219fb673`)", "Shared-fate topology (staging)" and
"Operator surfaces after the cutover" for the topology an operator actually
drives.

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

All four staging services run in **`syd` (Sydney, Australia)**. Reasoning:

1. Matches Tom/Quinn geography — operator on-call windows align with business hours.
2. Akahu (NZ open-banking) integration in `services/budget-api` benefits from low latency to NZ endpoints.
3. Twitter/X API has no regional preference, so region is irrelevant for `services/tasks-api` and `services/content-scheduler-api`.
4. Closest Fly.io region to the Auckland-based `services/gymtrack-mcp` for any future cross-region latency testing.

Production may move to `syd` or `nrt` (Tokyo) once traffic patterns emerge. The `primary_region` field in each `fly.toml` is the single change point.

---

## Cost model

Current staging cost (4 services, near-idle):

| Resource                                        | Monthly estimate         | Notes                                                |
| ----------------------------------------------- | ------------------------ | ---------------------------------------------------- |
| Fly — 4 × `shared-cpu-1x` 1 GB machines         | ~$20/mo                  | HTTP services stop when idle; the worker stays available for queued jobs |
| Neon — staging branch (free tier)               | $0                       | Free tier covers staging; production will move to Pro |
| Upstash — staging Redis (free tier)             | $0                       | Pay-per-request model; staging won't exceed free     |
| Domain — `sindustries.co.nz` (annual)           | ~$15/yr (~$1.25/mo)      | Quinn-registered; replaces the foundation's `sindustries.dev` reservation per task `5cb4a8fe` |
| GH Actions (deploys on push to main)            | $0                       | Within repo free tier                                |
| **Total staging**                               | **~$21/mo**              |                                                      |

Production cost projection (when traffic is real): dominated by Neon compute-hours + Upstash request volume. Re-estimate when the production cutover task (`020f423e`) starts.

### Consolidated platform (task `219fb673`)

The staging cost model above assumes four always-on Fly Machines. The
consolidated platform replaces them with ONE 2 GB `shared-cpu-1x` Machine
carrying all four services, so the Fly line becomes a single machine
instead of four.

**Do not quote the task spec's figures.** The spec's "4 × $6.70 = $26.80/mo
→ 1 × $6.70 = $6.70/mo" arithmetic assumed four 1 GB machines' worth of
headroom fits inside one 1 GB Machine. It does not: the consolidated Machine
runs four Node runtimes plus nginx plus the supervisor, so it is sized at
2 GB. The real before/after figures are re-derived from Fly's live billing
API at implementation time and attached to the task — the supervisor's
`/__status` endpoint reports per-child RSS so the size can be re-measured
after the first staging boot.

The production cutover decision (`020f423e`) inherits the same per-service-
Fly-app pattern unless it carries this decision forward deliberately.

---

## Shared-fate topology (staging)

The consolidated platform (task `219fb673`) trades isolation for cost.
**One Machine means one crash domain.** Read this before deploying.

| Fact | Consequence for an operator |
| --- | --- |
| One Machine carries all four services | A crash, an OOM kill, or a deploy restart takes down tasks-api, budget-api, content-scheduler-api and the auto-post worker together. |
| One image, one release | A deploy redeploys all four services even if the change only touched one service's source. |
| One process group | Per-service scaling is impossible. The only scaling axis is "more platform machines", which would run all four services again — so it is not a scaling lever. |
| Rollback is app-wide | `fly releases rollback` restores the whole platform to a prior image. It cannot roll one service back. |
| DNS is separate from the app | Moving the CNAMEs back is the backout path for "the platform itself must go" — see `docs/runbooks/platform-consolidation-rollback.md`. |
| Health is shared | The platform's `/__status` answers **503** when any child is not running, because Fly's `http_check` reads the status code and not the body. One child stuck in a permanent crash loop therefore fails the whole platform's health and Fly restarts the Machine. That is the shared-fate trade taken deliberately: one bad service takes the platform's health down with it, rather than the platform reporting healthy while nginx proxies to a dead upstream. |
| The platform never scales to zero | `min_machines_running = 1` keeps the Machine running. The auto-post worker is queue-bound — no HTTP listener, no route, no traffic at 3am — so a platform allowed to stop would leave queued auto-posts unprocessed until an unrelated request auto-started it. The old per-service worker app had no `[http_service]` at all and therefore never auto-stopped. The cost consequence: the platform is billed for one always-on Machine, not an idle one, and the before/after comparison in the cutover runbook compares **one always-on 2GB Machine** against the four always-on per-service apps it replaces. |
| Secret visibility is shared | Every child inherits the app-level environment, so `TASKS_API_*`, `BUDGET_API_*` and `X_*` secrets on the platform app are readable by every child, not only the service that owns them. The variables that a child's own mapping owns (`DATABASE_URL`, `REDIS_URL`, `CONTENT_SCHEDULER_REDIS_URL`, `CONTENT_SCHEDULER_API_BASE_URL`, `CORS_ALLOWED_ORIGINS`, `PORT`) are **not** inherited — each child gets only the value its own `PLATFORM_*` source maps onto it, so "unset" means absent rather than another service's value. |

Mitigations, in the order they apply:

1. **Canary strategy.** `strategy = 'canary'` means a new Machine comes up
   beside the old release and Fly promotes it only once it is healthy, so a
   bad image does not replace a working one immediately.
2. **`fly releases rollback`** restores the previous image inside the
   platform app.
3. **The old apps stay deployable.** The four per-service apps are scaled to
   zero, not deleted, for the duration of the soak, so the fastest backout
   is a CNAME move plus `fly scale count 1`.

One naming caveat for the dashboards: the health-probe metric
`sindustries_fly_app_health` keeps an operator-supplied `app` label, so the
gauge can stay named `tasks-api` / `budget-api` / `content-scheduler-api`
and the metric contract is preserved literally. After the consolidation that
label no longer names a Fly app — it names a path on the platform app — so
the gauge means "this path on the platform app is healthy", not "this Fly
app is healthy".

Where an operator should look:

- This section — the topology and its consequences.
- `infra/cloud/README.md` — the service table.
- `docs/runbooks/platform-consolidation-rollback.md` — the cutover
  sequence, the backout sequence, and the checklist of transitional guards
  to remove once the cutover has happened.

---

## Platform secret provisioning (task `219fb673`)

The consolidated platform app (`sindustries-platform-staging`) needs twelve
app-level secrets before it can boot: three database URLs, six Redis URLs
and two approval-service credentials. They are provisioned from the
**staging GitHub environment** by
`infra/cloud/platform/platform-provision-secrets.mjs`, which the
`.github/workflows/deploy-staging-platform.yml` workflow runs before the
deploy.

| Platform secret | Staging environment secret | Note |
| --- | --- | --- |
| `PLATFORM_TASKS_API_DATABASE_URL` | `STAGING_TASKS_API_DATABASE_URL` | write-capable; schema forced to `tasks_api` |
| `PLATFORM_BUDGET_API_DATABASE_URL` | `STAGING_BUDGET_API_DATABASE_URL` | write-capable; schema forced to `budget_api` |
| `PLATFORM_CONTENT_SCHEDULER_API_DATABASE_URL` | `STAGING_CONTENT_SCHEDULER_API_DATABASE_URL`, or derived from the tasks-api DSN | one Neon database, three schemas; schema forced to `content_scheduler` |
| `PLATFORM_*_REDIS_URL` (6 names) | `HEALTH_PROBE_REDIS` | one live Redis instance — every live per-service Redis secret has the same Fly digest, so all six names take the same value |
| `PLATFORM_CONTENT_SCHEDULER_API_BASE_URL` | — | public URL, registered as a plain value |
| `TASKS_API_APPROVAL_SERVICE_CREDENTIALS` | `TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN` | inherited name, token wrapped in the `[{token, actor, approvalTypes}]` JSON the services parse |
| `CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS` | `CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN` | inherited name, same wrapping |

**Every database source is write-capable, and the script fails closed
without one.** The platform runs `prisma migrate deploy` in its
`release_command` and the services write normally, so a read-only role
cannot satisfy the contract: the first deploy would fail in the
release/migration phase, and even with migrations skipped the service
could not perform a normal write. The database drill's `TASKS_API_SOURCE_DSN`
and `BUDGET_API_SOURCE_DSN` are read-only BY CONTRACT — they exist so the
drill can dump a source database
(`.github/workflows/cloud-staging-db-drill.yml`,
`docs/runbooks/staging-database-migration-restore.md` §1) — so they are
never mapped onto the live platform. The provisioning script has no
read-only fallback: when a write-capable source is absent it stops with an
error naming the missing environment secret, so the read-only role is never
discovered on the first live deploy.

**Why the staging environment and not a local file.** Fly exposes a digest
per secret, never a value, so a value can only be read where it was
written. The live staging values are not reproducible from
`infra/cloud/.env.local`: that file still carries two Redis instances
while every live app carries one. The staging GitHub environment is where
the live values are readable, so it is the source of record. No value is
ever printed, logged or committed — the mapping runs inside the workflow
and hands the payload to `flyctl secrets set` directly.

**The schema parameter is set explicitly.** Prisma picks the schema from
the URL, and a DSN without `?schema=` silently resolves to `public`, so
every database URL is rewritten to name its schema. The rewrite is
textual: `new URL(...).toString()` re-encodes the password, which would
change it for DSNs whose password contains reserved characters.

**The secrets are set directly, not staged, and they are read back.**
`flyctl secrets set --stage` holds the values for the next release. On the
first live platform deploy that never reached the Machine: the deploy
created the canary Machine, and that Machine still carried the placeholder
(`REPLACE_ME_SEE_QUINN_NOTES`) that had been registered on the app out of
band. The platform booted with a placeholder Redis URL, tasks-api rejected
it as an invalid URL and crash-looped, while `fly secrets list` showed the
staged values sitting on the app. The values are therefore set directly,
so they are the app's live values and every Machine — including the one a
deploy creates — starts with them. After setting them, the script reads
`fly secrets list --json` back and fails when a name did not land: a
`flyctl secrets set` exit code says the command was accepted, not that
every secret is on the app.

**The secret write is detached, so it is not health-gated on the image it
replaces.** `flyctl secrets set` does not only write values: it also
restarts the app's Machines, and in the flyctl the deploy workflow pins
(0.4.102) that restart is a Machine deployment whose progress flyctl
follows to completion. When the running image is unhealthy — exactly the
state a deploy exists to repair — the follow fails, `flyctl secrets set`
exits non-zero, and the workflow aborts BEFORE the canary deploy that
carries the fix. This is not hypothetical: main CI run `42366203146` on
merge commit `27269dbb` failed in the "Provision the platform app and its
secrets" step for exactly this reason. The Machine was listening on the
supervisor's `8081` and the children's `4001`/`4002`/`4003` but not on
`0.0.0.0:8080` (the router did not bind), so the health-gated restart
could not pass and the run never reached "Deploy (canary)" — the step that
would have installed the fixed image.

The provisioner therefore writes with `--detach`. Upstream flyctl 0.4.102
(`internal/command/secrets/secrets.go`, `DeploySecrets`) passes
`SkipHealthChecks: args.Detach` and `SkipDNSChecks: args.Detach ||
!args.CheckDNS` to the restart-only Machine deployment, so the command
returns once the restart is issued instead of waiting for the running
image to become healthy. The health gate belongs to the deploy step that
follows: it installs the new image, and the workflow's smoke checks decide
whether the platform serves. The write still fails closed on a real
failure — a non-zero flyctl exit (rejected value, auth error, API error)
is still an error, and the read-back still fails when a secret NAME did
not land.

The invariant is asserted in two places, so it cannot be lost silently:
`infra/cloud/platform/tests/platform-provision-secrets-cli.test.mjs`
asserts the flyctl argv (`--detach` present, `--stage` absent), and
`infra/cloud/platform/tests/platform-provision-order.test.mjs` asserts the
workflow-level contract — the secrets are registered before the canary
deploy, the workflow never writes secrets directly (a raw `flyctl secrets
set` would reintroduce the health-gated write), and the provisioner owns
the single implementation of the write.

**The supervisor refuses to start on an unusable secret.** A required
source that is present but holds a placeholder passes a presence check and
then breaks the child at boot with an opaque error (a zod "Invalid url"
from tasks-api, a crash loop with no obvious cause). The supervisor
therefore checks the shape of the sources it requires — a `*_REDIS_URL`
must be a `redis://`/`rediss://` URL and a `*_DATABASE_URL` must be a
`postgres://` DSN — and refuses to start with one message naming the
offending source, instead of starting four children that cannot boot.

**The provisioner rejects an unusable Redis source before Fly sees it.**
The live failure on 2026-11-07 showed why this check cannot live only in
the supervisor: the staging `HEALTH_PROBE_REDIS` source still held the
26-character placeholder `REPLACE_ME_SEE_QUINN_NOTES`, the provisioner
accepted it as one Redis "URL", registered all six `PLATFORM_*_REDIS_URL`
names, and the read-back confirmed only the names. The new Machine then
failed the supervisor's shape gate. The provisioner now uses the same
Redis-URL predicate as the supervisor and fails closed before
`flyctl secrets set` when the source is not a `redis://` or `rediss://`
URL. The read-back log says **secret name(s)** deliberately: Fly exposes
names and a non-reproducible change hint, not values, so this step cannot
prove the stored value. The authoritative proof remains a healthy
Machine plus its supervisor logs.

**The router's config path is absolute.** `nginx -c <path>` resolves a
relative path against nginx's own compile-time prefix
(`/var/lib/nginx` on alpine), not against the child's working directory,
so the relative form failed with `nginx: [emerg] open()
"/var/lib/nginx/infra/cloud/platform/nginx.conf" failed`. The image holds
the file at `/app/infra/cloud/platform/nginx.conf`, so that is the path the
router is given.

**The router logs on the inherited fd, not on a device node.** The
supervisor spawns every child — the router included — with PIPED stdio. In
that context `error_log /dev/stderr` fails to open with `nginx: [emerg]
open() "/dev/stderr" failed (6: No such device or address)`, and the router
exits before it can bind `:8080`, so fly-proxy cannot reach the platform
and Fly's health check fails the Machine. The config therefore uses
`error_log stderr` and `access_log stdout`, which log on the inherited fd 2
and fd 1 directly.

**The server-names hash bucket is sized for the longest server name.** The
server names are up to 47 characters long
(`content-scheduler-api.staging.sindustries.co.nz`), and nginx's default
`server_names_hash_bucket_size` of 64 cannot hold them: the router refuses
to start with `nginx: [emerg] could not build server_names_hash, you
should increase server_names_hash_bucket_size: 64`. The config sets
`server_names_hash_bucket_size 128` — the smallest power of two that holds
every name in the file.

Both router start-up failures have the same shape: the router never binds
`:8080`, the platform answers nothing through fly-proxy, and the Machine's
health check fails, which takes all four consolidated services down at
once. `infra/cloud/platform/tests/platform-supervisor.test.mjs` asserts both
invariants against the config file so neither can regress silently.

**The deploy stays opt-in.** Provisioning the app and its secrets is safe
at any time — no Machine runs until a deploy. The deploy itself is gated
on the staging environment variable `STAGING_PLATFORM_DEPLOY_ENABLED=true`,
because the platform's auto-post worker starts consuming the BullMQ queue
as soon as the platform is deployed, while the old
`sindustries-auto-post-worker-staging` app is still running. The operator
path (`infra/cloud/bin/deploy platform`) is gated by the same variable, so
the opt-in cannot be bypassed. The cutover order is in
`docs/runbooks/platform-consolidation-rollback.md` §3: the old auto-post
worker is scaled to zero BEFORE the platform is deployed.

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
| `sindustries.co.nz` (apex) | Production frontends + APIs (mission-control, tasks, tasks-api, budget-api, content-scheduler-api, health-probe) | Quinn-registered; matrix at `infra/cloud/hostname-matrix.json`; CNAMEs pending per task `5cb4a8fe` |
| `staging.sindustries.co.nz` (subdomain) | Staging frontends + APIs (same six surfaces)        | Delegation pending per task `5cb4a8fe`; matrix at `infra/cloud/hostname-matrix.json` |
| `sindustries.dev` (legacy)    | Wildcard CNAMEs to Fly app subdomains (audited historical reservation) | Superseded by `sindustries.co.nz` for staging and production per task `5cb4a8fe`; remains documented for audit only |

## Stable hostname matrix (task `5cb4a8fe`)

The full staging + production hostname matrix lives at [`infra/cloud/hostname-matrix.json`](../../infra/cloud/hostname-matrix.json) (the machine-readable source of truth). The matrix records:

- Six public surfaces: mission-control, tasks-app, tasks-api, budget-api, content-scheduler-api, health-probe.
- The auto-post worker row with `staging: null`, `production: null`, and `publicUrl: false` — the explicit non-public nature is auditable from the matrix and from the per-hostname comment block at the top of `infra/cloud/fly/auto-post-worker.fly.toml`.
- A `providerFallback` per public surface (the `*.fly.dev` / `*.vercel.app` URL the design records as the migration path until the stable CNAMEs + certs land).

The static checks `tests/cloud/scripts/check-stable-hostname-matrix.mjs` and `tests/cloud/scripts/check-stable-url-fallbacks.mjs` enforce the matrix on every CI run; both pass on the committed tree at the time of writing.

Until the stable CNAMEs land, deploys use the default `*.fly.dev` URLs:

- `https://sindustries-tasks-api-staging.fly.dev/health` <!-- stable-fallback: documented-migration; superseded by https://tasks-api.staging.sindustries.co.nz/health once the stable CNAME + cert land (task 5cb4a8fe) -->
- `https://sindustries-budget-api-staging.fly.dev/health` <!-- stable-fallback: documented-migration; superseded by https://budget-api.staging.sindustries.co.nz/health once the stable CNAME + cert land (task 5cb4a8fe) -->
- `https://sindustries-content-scheduler-api-staging.fly.dev/health` <!-- stable-fallback: documented-migration; superseded by https://content-scheduler-api.staging.sindustries.co.nz/health once the stable CNAME + cert land (task 5cb4a8fe) -->
- `https://sindustries-auto-post-worker-staging.fly.dev` (no HTTP — Fly supervises by PID) <!-- stable-fallback: documented-migration; auto-post worker keeps no public URL on the stable hostname matrix either (task 5cb4a8fe) -->

Once DNS lands, point `<service>.staging.sindustries.dev` CNAMEs at the matching `*.fly.dev` host and update the smoke check URLs in the deploy workflows.

## Vercel env var matrix (task `5cb4a8fe`)

The **Vercel half** of AC3 — the contract between the hostname matrix and the VITE_* env vars the two Vercel frontends consume at build time — lives at [`infra/cloud/vercel-env-matrix.json`](../../infra/cloud/vercel-env-matrix.json). The contract records, per Vercel project, per environment, which VITE_* env vars to set and what value to set them to. Every matrix-derived value is the production or staging hostname from `infra/cloud/hostname-matrix.json`; the static check `tests/cloud/scripts/check-vercel-env-matrix.mjs` enforces that on every CI run.

| Vercel project | App | Production env | Preview env (staging) |
| --- | --- | --- | --- |
| `sindustries-mission-control` | `apps/mission-control` | `VITE_TASKS_API_BASE_URL`, `VITE_CONTENT_SCHEDULER_API_BASE_URL` | `VITE_TASKS_API_BASE_URL`, `VITE_CONTENT_SCHEDULER_API_BASE_URL` |
| `sindustries-tasks` | `apps/tasks` | `VITE_TASKS_API_BASE_URL` | `VITE_TASKS_API_BASE_URL` |

Out of scope for this matrix (recorded in `outOfScope[]`):

- `sindustries-gymtrack` — owned by the Clerk cutover (task `bb09eaed`); GymTrack's VITE_SUPABASE_URL / VITE_AUTH_PROVIDER / VITE_GYMTRACK_MCP_BASE_URL env vars are not in scope for `5cb4a8fe`.
- `sindustries-website` — static marketing content with no API surface; no VITE_* env vars.

Quinn sets the actual values in the Vercel dashboard per the contract; the contract itself is the engineer's responsibility and is the part this slice ships.

The custom domains Vercel serves each project on (production: `mission-control.sindustries.co.nz` / `tasks.sindustries.co.nz`; preview → staging: `mission-control.staging.sindustries.co.nz` / `tasks.staging.sindustries.co.nz`) are also recorded in the matrix JSON and enforced by the same static check, so a typo in either the env var value or the custom domain fails CI rather than silently shipping to Vercel.

## Production blockers (task `5cb4a8fe`)

The full production-blockers list — DNS records, TLS certs, Vercel custom domain registration, Vercel env var provisioning, Fly secrets, and the cross-environment safety net — is tracked in [`docs/cloud/production-blockers.md`](../cloud/production-blockers.md). Each blocker has a named owner (Quinn for DNS / TLS / Vercel / Fly secrets; separate tasks for production deploy workflows and production cutover) and a status field; the production deploy workflows and production cutover are explicitly out of scope for `5cb4a8fe` and tracked under tasks `020f423e` and `f2c23e26`.

The static checks above are the cross-environment safety net: a staging URL accidentally pasted into a production Vercel environment or production fly.toml fails the cross-env drift check at compile time, not at runtime. Quinn does not need to remember "don't paste staging credentials into production"; the contract makes it impossible to ship without the matching matrix value.

---

## Credential boundary

The `.openclaw` boundary Quinn confirmed on the PR #508 review (merged `d6ee2d8`):

- **Quinn owns** the live values: `FLY_API_TOKEN`, Neon `DATABASE_URL` / `DIRECT_URL`, Upstash `REDIS_URL` / `CONTENT_SCHEDULER_REDIS_URL`, DNS provider token. These never enter the repo.
- **Quinn registers** `FLY_API_TOKEN` through GitHub's masked secret UI under the `staging` and `production` environments as applicable. Workflow YAML references `secrets.FLY_API_TOKEN` by name and performs a fail-fast presence check before installing or invoking Fly tooling.
- **Rowan ships** only env-var names, Fly app specs, Dockerfiles, and deploy workflows. The workflow templates include `FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}` so the deploy job picks up Quinn's value at job time.
- **Quinn runs** `infra/cloud/scripts/bootstrap-staging.sh` once. It reads `infra/cloud/.env.local` (gitignored), translates Quinn's per-service prefixed values into the source names the platform provisioner reads, and hands them to `infra/cloud/platform/platform-provision-secrets.mjs`, which registers the app-level `PLATFORM_*` secrets. The provisioner is the single implementation of that mapping, so the local bootstrap and the CI provisioning path cannot register different secrets on the same app.
- **Quinn rotates** any secret out-of-band. Rotation procedure for tokens with downstream ciphertext rows (e.g. Akahu) was previously `docs/runbooks/rotate-akahu-access-tokens.md` (retired in PR #583; the procedure steps should be regenerated as a new runbook at `~/.openclaw/workspace/docs/infra/runbooks/rotate-akahu-access-tokens.md` if Quinn needs to rotate Akahu tokens); no rotation procedure is needed for non-derived secrets.

A new operator joining Quinn's seat gets the same out-of-band onboarding path: 1Password (or equivalent) handoff for `FLY_API_TOKEN` + Neon + Upstash + DNS, plus the `infra/cloud/.env.local` template.

If a Fly deployment reports that `FLY_API_TOKEN` is unavailable, repair it only through **GitHub → Settings → Environments → staging/production → Environment secrets**. Never paste the value into an issue, task, PR, workflow-dispatch input, command argument, URL, or chat. Re-run the failed gated deployment after the masked value is restored.

---

## Deploy procedure (reference)

`.github/workflows/ci.yml` is the deployment orchestrator. It detects changed deployable surfaces, runs CI, and emits one stable `CI / merge gate` result. The active `main` ruleset requires that result. Deploy workflows expose `workflow_call` only, so they cannot race or bypass the CI run for the same commit.

- Pull-request website staging starts only after the merge gate succeeds.
- A website change on `main` deploys a production-configured candidate to staging, smoke-checks that exact deployment URL, then promotes the same deployment to production.
- The website deploy workflow resolves **one** Vercel target at job scope (`VERCEL_TARGET`, derived from the `production-candidate` input), and the `vercel pull`, `vercel build`, and `vercel deploy --prebuilt` phases all consume it. Vercel refuses to publish prebuilt output whose recorded target differs from the deploy target, so a single shared value is what keeps the staging candidate publishable. A production-configured candidate is deployed with `--skip-domain`, so it stays off the production custom domains until it is explicitly promoted. The static check `tests/cloud/scripts/check-vercel-deploy-target.mjs` enforces the contract on every CI run.
- The production promotion resolves the candidate in the Vercel team that created it, from one explicit source: the job-scope `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` repository secrets. The staging job writes the project link with `vercel pull`, but the production job runs on a clean runner with no link, so an unscoped CLI request carries no team context and Vercel refuses the promotion with `Deployment belongs to a different team` (main run `42239656677`, job `127968156801`). The production path now links the project (`vercel link --project "$VERCEL_PROJECT_ID" --scope "$VERCEL_ORG_ID"`) and every mutating call — `vercel promote` and `vercel alias set` — carries `--scope "$VERCEL_ORG_ID"`. The static check `tests/cloud/scripts/check-vercel-production-promotion-scope.mjs` enforces the contract on every CI run.
- Fly staging services, GymTrack, GymTrack MCP, and the budget-mobile EAS update start only from a successful `main` merge gate when their central changed-path filter matches.
- The `production` GitHub environment accepts protected-branch deployments only. Staging remains available to pull-request branches.
- Staging cancels superseded runs for the same target/ref. Production serializes runs and never cancels an in-progress deployment.

### Vercel credential topology

`VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` and `VERCEL_TOKEN` are **repository-level** secrets. Neither the `staging` nor the `production` GitHub environment defines Vercel secrets of its own, so both website deploy jobs authenticate with the same token against the same team — the environment a job runs in does not select a team.

That makes the team scope something the workflow has to state, not something it can infer: the token's own default scope is the personal account that owns the team, not the team itself, and an unscoped request resolves the deployment under that default. Two consequences for anyone touching these jobs:

- A job that must act on a deployment created by another job needs the project context and the team scope explicitly (`vercel link --project "$VERCEL_PROJECT_ID" --scope "$VERCEL_ORG_ID"`, or `--scope "$VERCEL_ORG_ID"` on the mutating call itself). The production promotion job is the case in point.
- The scope must stay bound to the job-scope secret. A literal team id or slug in a workflow is a second source of truth, and it is the one that drifts when the team changes.

Fly reusable workflows run a credential preflight, install a commit-pinned setup action and version-pinned `flyctl`, run `flyctl deploy --strategy canary`, then smoke-check:

- **HTTP services** — curl `https://<app>.fly.dev/health` (10 retries, 5s apart). Tasks, Budget, and Content Scheduler each expose `/health`; Fly's `[[http_service.checks]]` block hits the same route every 15 seconds.
- **Worker** — `flyctl logs --app <app> --no-tail | grep '\[content-scheduler-worker\] starting (adapter=bullmq)'`. A clean boot line means Prisma connected + the BullMQ worker registered. Fly's process supervisor handles PID liveness; there's no `http_service` block to monitor.

If the smoke check fails, the deploy job exits non-zero. Quinn/Lox investigates via `flyctl logs --app <app>` and either forward-fixes or rolls back per the rollback procedure in `docs/specs/cloud-deployment-foundation-tech-design.md` "Rollback" section (the prior `docs/runbooks/cloud-deployment-rollback.md` was retired in PR #583).

---

## First-time environment creation

Staging is ONE Fly app (`sindustries-platform-staging`) since the cutover on
2026-11-07. The four per-service staging apps were destroyed, so the
bootstrap script provisions the platform app only.

Quinn runs `infra/cloud/scripts/bootstrap-staging.sh` once. The script:

1. Verifies the `fly` CLI is installed and authenticated, and refuses the
   retired per-service names with the reason (bootstrapping one would
   recreate an app that must stay destroyed — see "Shared-fate topology
   (staging)").
2. Translates the keys in `infra/cloud/.env.local` (gitignored) into the
   source names the platform provisioner reads, and fails closed if one is
   missing — before it touches Fly.
3. Creates the platform Fly app if it is missing (`fly apps create ...`).
4. Registers the app-level `PLATFORM_*` secrets through
   `infra/cloud/platform/platform-provision-secrets.mjs` (the single
   implementation of the source-to-secret mapping, and the same one the CI
   path uses).
5. Optionally runs the platform's Prisma migration chain (`--migrate`) and/or
   deploys the platform (`--deploy`).
6. Surfaces a final report with the app URL and the service routes.

The script is **idempotent** — re-running it does not destroy existing apps or secrets.

---

## Operator surfaces after the cutover

Every operator path in `infra/cloud/` resolves to the consolidated app:

| Surface | Resolves to | Note |
| ------- | ----------- | ---- |
| `infra/cloud/bin/deploy <service>` | `sindustries-platform-staging` + `infra/cloud/fly/platform.fly.toml` | The four service names are aliases; the deploy is opt-in (`STAGING_PLATFORM_DEPLOY_ENABLED=true`), exactly as the CI path is. |
| `infra/cloud/bin/status [service]` | `sindustries-platform-staging` | Also reads the supervisor's `/__status` payload, so a service alias reports the state of its CHILD inside the app. An unreadable payload is reported as unknown, not as healthy. |
| `infra/cloud/bin/rollback <service>` | `sindustries-platform-staging` | A rollback is shared-fate: every service rolls back together. |
| `infra/cloud/scripts/bootstrap-staging.sh` | `sindustries-platform-staging` | Refuses the retired per-service names with the reason. |
| `infra/cloud/observability/failure-inject.sh` | refuses service-scoped drills | The `tasks-api-down` / `budget-api-down` scenarios can no longer be produced by scaling a Fly app. They refuse any staging target, and refuse the consolidated platform in particular: scaling it to zero takes down ALL FOUR services, so a service-scoped drill against it is a full-platform outage wearing a service-scoped label. Producing a service-scoped outage needs a child-level mechanism inside the platform Machine, which does not exist yet. The refusal is mode-aware: `--dry-run` exits 0 and prints REFUSED (the task-31233a0a contract is "a preview has no side effects and needs no credentials", and a refusal has neither), while a real run exits 1 without touching Fly. |
| `.github/workflows/cloud-staging-validate.yml` | `sindustries-platform-staging` | Its "wake the content-scheduler machines" step targets the platform app (the Machine that can be cold), not the destroyed per-service app. Its preflight validates each staging target variable against its OWN surface's (host, path-prefix) routes from `infra/cloud/hostname-matrix.json` (`stagingRoutes`), so a variable still pointing at a destroyed app — or at a DIFFERENT surface — fails as a configuration error instead of a harness timeout. The routes are per target, not one shared allow-list: every service exposes `/health`, so a host-only allow-list let `STAGING_TASKS_API_URL` point at the budget-api hostname, probe the wrong service and report `tasks.health: pass`. The check never resolves DNS (the stable hostnames do not resolve yet — the CNAME gap on task 5cb4a8fe). |

`bin/status` reads `flyctl status --json`, and that envelope's shape has
changed between flyctl releases: some versions nest the release version
under `Release`, some carry a flat `Version`; some publish the process
types under `Services[].Ports[].Type`, some under `ProcessTypes`, and
the 0.4.111 envelope carries neither — the running process group is
readable only from each machine's own `FLY_PROCESS_GROUP` env. The
operator script accepts all of those shapes and names the source it
used (`processTypeSource`), so a process type that cannot be detected is
distinguishable from one that is genuinely absent. Machine identity
fields are read in either casing. Only `FLY_PROCESS_GROUP` is read out of
the machine env; no other env value reaches the report. When flyctl
itself fails, its stderr is shown to the operator instead of a bare
"status failed", because a TLS or auth failure and a missing app look
identical otherwise.

The credential redaction on those operator surfaces lives in ONE module,
`infra/cloud/platform/redact-output.mjs`, which `bin/status` and the
platform provisioner both use — they used to carry separate rules, and a
`postgres://` DSN printed in the clear through `bin/status`. The module
masks URL/DSN credentials, JSON credential fields, the `Authorization:
Bearer`/`Basic` and Fly `FlyV1` header forms, `NAME=value` assignments,
the credential keywords and Fly's own `fly_<token>` form, and it keeps
closing punctuation outside the mask so a diagnostic does not lose
characters the operator is reading.

`bin/status` calls `flyctl` with DIRECT egress: `HTTP_PROXY`,
`HTTPS_PROXY`, `http_proxy`, `https_proxy`, `SSL_CERT_FILE` and
`SSL_CERT_DIR` are unset for the call, the same proxy policy
`agents/lib/github-cli.sh` keeps for `gh` plus the CA-bundle variables.
An ambient TLS-intercepting proxy otherwise makes flyctl fail with `x509:
"api.fly.io" certificate is not trusted` while `curl` and `openssl
s_client` verify the same host cleanly — the cause is the operator's
shell, not the platform. The CA-bundle variables go with the proxy ones
because on this host the ambient `SSL_CERT_FILE` points at the egress
proxy's trust bundle, which a direct connection cannot verify Fly's
certificate against. An operator whose host has no direct route (or
whose root CA lives only in that bundle) sets
`FLY_STATUS_USE_AMBIENT_PROXY=1` to pass the ambient environment through
untouched.

The retired per-service app names must not reappear in an executable
position. `infra/cloud/scripts/tests/retired-staging-apps.test.sh` fails the
build if one does: the platform's auto-post worker and a resurrected worker
app would be TWO consumers on the same BullMQ queue, and every scheduled
post would be processed twice — silently, with no error anywhere. The guard
covers six surfaces (the three `bin/` wrappers, the bootstrap script, the
failure drill and the staging validation workflow) and additionally asserts
that the failure drill's service-scoped scenarios actually CALL the
platform-scale refusal — a behavioural assertion, not a comment check.

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
- [`docs/specs/cloud-staging-environment-tech-design.md`](../specs/cloud-staging-environment-tech-design.md) — task `2850c5ac` design: staging validation workflow, AC2 authenticated harness, AC3 failure-drill, AC4 evidence contract.
- [`infra/cloud/README.md`](../../infra/cloud/README.md) — operator index, Quinn-vs-Rowan ownership table, PR-stack history.
- [`infra/cloud/env/.env.example`](../../infra/cloud/env/.env.example) — cross-service env contract template.
- [`infra/cloud/hostname-matrix.json`](../../infra/cloud/hostname-matrix.json) — stable hostname matrix (task `5cb4a8fe`); source of truth for the static checks under `tests/cloud/scripts/`.
- [`infra/cloud/vercel-env-matrix.json`](../../infra/cloud/vercel-env-matrix.json) — Vercel env var contract (task `5cb4a8fe` slice 5); per-Vercel-project, per-environment VITE_* env var values, all matrix-derived; the static check `tests/cloud/scripts/check-vercel-env-matrix.mjs` enforces the host names match `infra/cloud/hostname-matrix.json`.
- [`docs/cloud/production-blockers.md`](../cloud/production-blockers.md) — AC6 production-blockers list (task `5cb4a8fe` slice 5); named owner per blocker, status field, cross-environment safety net contract.
- [`infra/cloud/scripts/bootstrap-staging.sh`](../../infra/cloud/scripts/bootstrap-staging.sh) — Quinn-runnable first-time setup.
- `~/.openclaw/workspace/docs/infra/runbooks/cloud-deployment-rollback.md` — rollback procedure (was at `docs/runbooks/cloud-deployment-rollback.md`; retired in PR #583 — re-create in workspace if Quinn needs to roll back a deploy without re-deriving from `docs/specs/cloud-deployment-foundation-tech-design.md`).
- `~/.openclaw/workspace/docs/infra/runbooks/rotate-akahu-access-tokens.md` — secret rotation precedent (was at `docs/runbooks/rotate-akahu-access-tokens.md`; retired in PR #583 — re-create in workspace before rotating an Akahu token with downstream ciphertext rows).

---

## Server-side enforcement evidence index (task `02c5475c`)

The merge-gate hardening (task `02c5475c-b4c9-420b-800b-7d6a9ecb0eb6`, PR #680) is code-complete on `main`; the residual server-side enforcement evidence that lives outside the repo (rulesets, environments, masked secrets) is tracked here so AC1/AC3/AC4 have a single point of read-back rather than living in a task comment.

| AC   | Server-side artifact                                                                                                                                                          | Last read-back     | Where the contract is enforced (workflow)                                                                                                                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AC1  | Repository ruleset `13513816` (`main`) — `required_status_checks` = `CI / merge gate`, `enforcement: active`                                                                    | 2026-09-17 (Quinn) | `.github/workflows/ci.yml` `merge gate` job under `if: always()`; `infra/cloud/scripts/check-ci-results.py` accepts only `success` / `skipped`                                                                                                                       |
| AC3  | Production GitHub environment accepts `main`-only deploy jobs; production jobs gate on `github.ref == 'refs/heads/main'`                                                       | 2026-09-18 (Ash)   | `deploy-website-production` / `deploy-gymtrack-production` / `deploy-gymtrack-mcp-production` / `eas-update-production` `if:` clauses                                                                                                                                |
| AC4  | `FLY_API_TOKEN` provisioned in the `staging` environment (created 2026-09-15); masked repair procedure documented in the "Credential boundary" section above                   | 2026-09-15 (Quinn) | Fly deploy workflows' "Require Fly deployment credential" preflight step (`::error::FLY_API_TOKEN is not configured for the …`)                                                                                                                                      |

Read-back procedure for future drift:

1. `gh api repos/Stoffer-Industries/sindustries/rulesets/13513816` — confirm `required_status_checks[*].context == "CI / merge gate"` and `enforcement == "active"`.
2. `gh api repos/Stoffer-Industries/sindustries/environments/production` — confirm production deploy jobs still hit the `main` branch restriction (workflow-level `if:` is the active control until the server-side `deployment_branch_policy` is added; that enhancement is not in scope for `02c5475c`).
3. `gh api repos/Stoffer-Industries/sindustries/environments/staging/secrets/public-key` (or the equivalent secrets list endpoint) — confirm `FLY_API_TOKEN` exists in the staging environment. The production secret is Quinn-owned out-of-band per the Credential boundary section; the workflow preflight guarantees a clean fail-fast until it lands.

Update this table whenever any of the three artifacts changes; the `Last read-back` field is the source of truth for what the lobster should cite when the AC entry needs a `(📄 not code: …)` evidence pointer.

---

## Merge-gate required-job coverage (task `5674a6c1`)

The aggregate `merge gate` job is the **sole** status check on `main`: repository ruleset `13513816` (`main`, `enforcement: active`) requires exactly one `required_status_checks` entry, and classic branch protection on `main` does not exist (404). A verification job that is absent from `merge-gate.needs` therefore blocks neither the merge nor any of the ten deployment jobs, because each deployment job gates only on `needs.merge-gate.result == 'success'`.

This was not a theoretical gap. `gh-with-agent-token-tests` — the only regression guard for the per-agent GitHub identity shim, the `bin/deploy|status|rollback` contracts, the cloud staging workflow harness, the staging failure drill, and the stable-hostname harness/schema check — was declared in `ci.yml` but missing from `merge-gate.needs`. The contract test could not catch it because its `expected_required` set was a **second hand-maintained literal** that repeated the same omission: config and "proof" were copied from the same wrong source, so they agreed with each other and disagreed with reality.

### Required vs. advisory is graph position, plus one explicit allowlist

- **Required** = every job in `ci.yml` that is neither `merge-gate` itself nor downstream of it (i.e. its `needs` does not include `merge-gate`).
- **Advisory** = named in `ADVISORY_VERIFICATION_JOBS`, an explicit empty-by-default frozenset in `infra/cloud/scripts/tests/ci-deployment-gates.test.sh`, co-located with the derivation it constrains. It is empty today: there is no verification job whose failure is allowed to not block release.

`continue-on-error` is deliberately **not** the advisory marker, and no job relies on it any more: the `gitleaks` job — the one job that used to carry `continue-on-error: true` — is blocking by construction (see *Secret scan enforcement* below). Adding a name to `ADVISORY_VERIFICATION_JOBS` is a security-posture decision and requires the same tech-design + Quinn-approval path as the task that created the allowlist.

### Secret scan enforcement

The `gitleaks` job is a required `merge-gate` input, and it now blocks the merge. It runs the gitleaks CLI directly — **not** `gitleaks/gitleaks-action`, which refuses to start on an organisation repo without a paid `GITLEAKS_LICENSE` secret. That path aborted before scanning anything, and the `continue-on-error: true` on the step turned the abort into a green `success`, so the merge gate had been collecting a green secret-scan result from a job that had never scanned a commit (W42 F6, W43 F2, W44, W46 F3; task `2b3962b1`).

| Property | Value |
|---|---|
| Binary | gitleaks `v8.30.1`, MIT-licensed — no credential, no organisation secret, no owner-only provisioning step |
| Pin | `gitleaks_8.30.1_linux_x64.tar.gz`, SHA256 `551f6fc8…70eb`, checked with `sha256sum --check --strict` |
| Entrypoint | `infra/cloud/scripts/run-secret-scan.sh` — the CI job, the contract test and the local pre-commit hook all call it |
| Scope | the change: `base.sha..HEAD` for pull requests, `before..sha` for pushes to `main` |
| Failure modes | secrets found, missing binary (exit 2), missing config (exit 3), empty scan scope (exit 4) — every one of them blocking |

The install is pinned and checksummed, and it is deliberately not a single point of failure. The GitHub release-asset CDN intermittently answers `504` for this asset — reproduced locally for that asset while another asset from the same release downloaded cleanly — so the job caches the verified archive between runs and falls back to the API's asset endpoint (a different CDN route to the same bytes) when the release URL fails. The SHA256 check runs on every path, including the cache hit, so the fallback cannot weaken the guarantee: a truncated, tampered or substituted download fails the job either way. A required merge-gate input must not be able to block a merge for a reason unrelated to the code being merged.

The scope is the change, not the whole history. A history-wide scan on every run would redden `main` on the first historic finding after it lands, and the tempting fix — a broad allowlist — would weaken the gate this exists to make real. A repository-wide sweep is therefore tracked separately (the M2 follow-up of task `2b3962b1`): one triage of the real findings, and only then does the tree scan join the gate with a clean baseline.

Two properties make a green meaningful:

- **The entrypoint never reports success for an empty scope.** A range that resolves to zero commits is exit 4 with an `::error::` annotation, so a green can never again mean "scanned nothing".
- **Every setup failure is visible and blocking.** A missing binary or config exits non-zero with an `::error::` annotation; there is no `|| true`, no `continue-on-error` and no `set +e` around the scan.

That the gate is real is scripted rather than asserted. `infra/cloud/scripts/secret-scan-negative-control.sh` publishes a synthetic canary token — detected by the test-only rule `sindustries-secret-scan-canary`, which only ever adds detections and never suppresses one — on a throwaway branch, opens a pull request so the `pull_request` trigger runs, and asserts that both the `gitleaks secret scan` job and the `merge gate` job conclude `failure`. The canary is synthetic and carries no credential; the branch and the pull request are deleted when the control finishes. The always-on half of the same proof is the contract test `infra/cloud/scripts/tests/secret-scan-enforcement.test.sh`, which runs inside the `gitleaks` job itself.

#### The config itself was inert until task `2b3962b1`

Turning the gate on exposed two defects in `.gitleaks.toml` that had been masked by the gate never running at all. Both are fixed in the same change, because a green gate over a scan that detects nothing is not enforcement:

- **`[extend]` never loaded the default ruleset.** `useDefault` has defaulted to **false** since gitleaks v8.19, and the `[extend]` table set no keys, so the config shipped with *no* rules at all. The comment above the table claimed the bundled ruleset was in use. With the default ruleset loaded, the scan detects the secrets it claims to detect — for example a `API_KEY=sk_live_…` line, which the previous config did not flag at all.
- **A rule's pattern is read from `regex` (singular); the plural `regexes` form is ignored.** The two per-rule overrides that aimed at empty `.env.example` placeholders therefore carried a path and no pattern, and one of them shadowed the built-in `generic-api-key` rule for the whole repository. They have been removed — the global allowlist already covers the `.env.example` path and the empty-assignment shape they were written for, so removing them restores the bundled rules at full strength instead of narrowing them. (An allowlist does legitimately use the plural `regexes` form; only a *rule* does not.)

The corrected config was measured against the tracked tree at `main` before it was enabled: **zero** findings across all 1356 tracked files, so switching the default ruleset on does not retroactively redden the repository. The findings it does surface are in gitignored local development files (`.vercel/`, `*.env.local`, `*.env.prodlike`) — local machine state, not repository history — which is why the gate scans the change rather than the tree. A repository-wide triage of history remains the M2 follow-up of task `2b3962b1`; the contract test now guards all three facts (the default ruleset is loaded, no rule uses the ignored plural field, and the canary rule exists) so the config cannot silently go inert again.

### The expected set is derived, not hand-maintained

`compute_expected_required(jobs)` derives the required-job set from `ci.yml` structure, so the contract test and the workflow cannot drift apart the way the old literal and `merge-gate.needs` already had. Two self-tests keep the derivation honest:

- **AC3** — the validator is driven with the *real* `merge-gate.needs` job names with `gh-with-agent-token-tests` forced to `failure`; the gate must exit 1 and name the failing job. The deploy-job loop separately asserts that every one of the ten deployment jobs requires `needs.merge-gate.result == 'success'`, so a failing required job blocks deployment.
- **AC4** — a sentinel verification job appended to a temporary copy of `ci.yml` must make the comparison fail *and* name the omitted job; wiring it into `merge-gate.needs` in that copy must make it pass. The temp copy is normalised first so the sentinel is the only defect under test, and the fixture is hermetic — it inherits no live omission.

### Ruleset coupling is asserted hermetically

`merge-gate`'s `name:` field is asserted against the named constant `REQUIRED_STATUS_CHECK_CONTEXT = 'merge gate'`. The ruleset is **not** re-read live from CI: that would need `administration: read`, a second security-posture expansion riding inside a task scoped to the `needs` hole, and would couple the assertion to a numeric ruleset ID that breaks if the ruleset is recreated. The contract suite stays hermetic (file-parsing only, no network).

Server-side read-back (live `gh api repos/Stoffer-Industries/sindustries/rulesets/13513816`, 2026-10-24): `enforcement: active`, `required_status_checks` = exactly one entry with context `merge gate` (GitHub's UI renders this as `CI / merge gate`, where `CI` is the workflow name). Re-verify during repo-audit passes if the ruleset changes.

`skipped` remains an allowed result, so path-filtered jobs (for example `feature-task-clippy`, which only runs on `feature_task` changes) do not block unrelated pull requests.

### Offline contract tests are now a required gate input (task `d63b1491`)

Five contract tests existed on disk but no CI job executed them, so they asserted nothing in the merge gate: the PR opener identity guard (`agents/skills/dev/pr-open/tests/test_assert_opener_identity.sh`) and the four cloud-database checks under `scripts/cloud/database/tests/`. They were visible only as a ledger in `CONTRIBUTING.md` and in the `NOT_RUN_BY_CI` set of `infra/cloud/scripts/tests/ci-job-script-inventory.test.sh` — a list that records the gap rather than closing it.

The `offline-contract-tests` job now runs all five and is wired into `merge-gate.needs`, so a failure in any of them blocks the merge. The job is deliberately minimal: all five tests are offline by construction (the opener-identity test stages a stub `gh`; the schema-presence test stages stub `psql`/`pg_restore`), so the job needs a checkout, `python3` (the cleanup script shells out to it) and `shasum` (the schema-presence test's `sha256sum` stub delegates to it). The job declares `python3` through `actions/setup-python` and installs the `shasum` provider only when the runner image does not already provide it.

The live-database drill that shares the root `test:cloud-db` npm script (`tests/cloud/tests/staging-db-migration-failure-drill.test.sh`) is **not** part of this job: it needs a real database, so it stays with the root script and the `cloud-staging-db-drill` workflow, and it remains on the not-run-by-CI ledger. Splitting it out is deliberate — it is a live-service prerequisite, not a missing CI wire.

---

## Cloud staging validation (task `2850c5ac`)

The first end-to-end check that the staging target is production-shaped runs through `.github/workflows/cloud-staging-validate.yml`, a `workflow_dispatch`-only job on the `cloud-staging` concurrency group with a 45-minute cap. The workflow:

- Applies `prisma migrate deploy` for budget-api before any harness step (idempotent; resolves the bootstrap-staging prerequisite).
- Mints a synthetic budget-api session via `npx tsx services/budget-api/scripts/staging-smoke-session.ts mint --staging` (mode-0600 bearer file in `/tmp/budget-smoke-bearer`, SIGINT/SIGTERM cleanup trap). The CLI refuses to run unless `BUDGET_STAGING_ENVIRONMENT=staging`, `--staging` is passed, and `DATABASE_URL` does not look production-shaped.
- Runs `tests/cloud/staging-workflows.mjs` (pure Node 22 ESM, no install step on the runner) against the live staging endpoints. Verifies Tasks API create/read/comment/patch/archive/list-excludes, Budget API `/me`, and Content Scheduler create/approve/health-bullmq/unapprove. Cleanup runs unconditionally via try/finally; the bearer file is unlinked before exit.
- Optionally runs `tests/cloud/staging-failure-drill.sh` when `run_failure_drill=true` (default false; AC3 prerequisite `31233a0a` is the hosted-observability contract that has not yet closed).
- Always uploads `artifacts/staging-workflows.json` + `artifacts/staging-failure-drill.json` + (on harness crash) `artifacts/harness-crash.json`. The structured summary surfaces verdict, per-check status, cleanup.ok, and accepted limitations inline.

### Why `workflow_dispatch` only (not on push)

The validate workflow depends on branch-local files (`staging-smoke-session.ts`, `staging-workflows.mjs`, the failure-drill script, the harness-side crash-capture). Until those land on main via PR #695, the workflow file on main is incomplete and any run against `main` will fail at the mint step with `ERR_MODULE_NOT_FOUND` (observed on Quinn-dispatched run 37417928545 at 2026-10-06T05:19:07Z). Until PR #695 merges, Quinn dispatches against the branch head from the Actions tab (no `gh workflow run` path, per the dispatch-path note at task comment `5681276981`).

### Evidence contract (AC4)

Each run produces a dated evidence record at `docs/infra/cloud-staging-validation-YYYY-MM-DD.md` (template at `docs/infra/cloud-staging-validation-template.md`). Verdict is `PASS` only when `productionBlockers == []`; `FAIL` is acceptable for known accepted limitations if `acceptedLimitations` is non-empty. Production blockers and accepted limitations live in separate tables in the evidence doc so reviewers cannot mistake one for the other.

### Operator notes

- The workflow refuses to run with an empty `FLY_ORG` (silent fail-fast is worse than a loud refusal at workflow start).
- AC3 requires Quinn-owned Grafana Cloud + Neon + Fly secrets to land under task `31233a0a`; until then the failure-drill step emits `AC3_OBSERVABILITY_VERIFICATION_UNIMPLEMENTED` as an accepted limitation.
- The `bin/{deploy,status,rollback}` wrappers in `infra/cloud/bin/` are operator hotfix paths; they are NOT a replacement for the CI workflows and they MUST NOT be used to bypass the merge gate.
- Per-deploy intent commit SHA is exposed on every HTTP service `/health` as `version: process.env.GIT_COMMIT_SHA`; the AC2 harness asserts `matchesIntent === true` for Tasks, Budget, and Content Scheduler using this signal.
