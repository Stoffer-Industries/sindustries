# Cloud Platform — handover document

**Type:** System reference (handover)
**Status:** Implemented and live in staging and production (the production route cutover is still open under `020f423e`)
**Last updated:** 2026-11-22
**Owner:** Rowan (engineering); Quinn owns the live cloud account + secrets
**Repos:** `Stoffer-Industries/sindustries`
**App:** One consolidated Fly app per environment (Sydney region), each carrying `tasks-api`, `budget-api`, `content-scheduler-api` and `auto-post-worker` as child processes — `sindustries-platform-staging` and `sindustries-platform-production`, plus a separate health-probe app per environment

> **Naming history:** this workstream was originally scoped as a separate "SIndustries Cloud Platform" spec (task `b2f62c36`). The artefacts land under `infra/cloud/` plus `docs/systems/cloud-platform.md` as the handover doc. The prior `docs/runbooks/cloud-deployment-rollback.md` and `docs/runbooks/rotate-akahu-access-tokens.md` were removed in PR #583 (operational runbooks no longer live in this repo — see `agents/definitions/README.md` "Where operational runbooks live"); neither was regenerated: the workspace repo's canonical `infra/runbooks/` holds neither, and the older `docs/infra/runbooks/` path they name is legacy (see `agents/definitions/README.md` "Where operational runbooks live"). The live rollback runbook for the staging platform is in this repository at `docs/runbooks/platform-consolidation-rollback.md`; the Akahu token-rotation procedure does not exist and is written from scratch, into the workspace repo's `infra/runbooks/`, only if a rotation is needed. Production deployment shipped with task `fb1240c0` (PR #979, merged 2026-11-17) and the production platform app and its hostnames are live — verified live 2026-11-22, `flyctl apps list` showing `sindustries-platform-production` deployed and all three production API hostnames answering HTTP 200 on `/health` — so this document covers the **staging and production** targets; see [Production topology](#production-topology-task-fb1240c0). The remaining production work (the route cutover, the runtime configuration and the hosted observability stack) is tracked under the broader cloud migration plan (tasks `206927ed`, `2850c5ac`, `020f423e`, `f2c23e26`, `d37681e1`, `4b3d6e9c`).

---

## Context

SIndustries runs a multi-service Node/TypeScript stack (`services/tasks-api`, `services/budget-api`, `services/gymtrack-mcp`, `services/content-scheduler-api`) against a Postgres + Redis back-end. Historically the stack has been operated from Tom's Mac mini. The cloud workstream (task `b2f62c36`) creates the first production-like cloud target so the services can be deployed from CI, scaled independently of the developer's machine, and replicated for new operators without sharing local credentials.

For the design rationale see [`docs/specs/cloud-deployment-foundation-tech-design.md`](../specs/cloud-deployment-foundation-tech-design.md). For the operator-facing index of artefacts see [`infra/cloud/README.md`](../../infra/cloud/README.md). For rollback see [`docs/runbooks/platform-consolidation-rollback.md`](../runbooks/platform-consolidation-rollback.md) — the live **staging** rollback runbook (`fly releases rollback --app sindustries-platform-staging`; in production the same app-wide command runs against `sindustries-platform-production`, the production platform app the environment manifest names); the prior `docs/runbooks/cloud-deployment-rollback.md` was retired in PR #583 and was never regenerated outside this repository.

This document exists so a new operator (or Quinn returning after a break) can answer the four handover questions — *what is this, who owns what, how much does it cost, and what happens when it breaks* — without having to reverse-engineer `infra/cloud/`.

---

## Decision summary

| Concern                          | Choice                                                   | Owner  | Lives in                                                      |
| -------------------------------- | -------------------------------------------------------- | ------ | ------------------------------------------------------------- |
| Compute                          | Fly.io (managed VMs, regional)                           | Quinn  | `infra/cloud/fly/*.fly.toml`                                  |
| Application packaging            | One Dockerfile builds the platform image for all four processes; the four per-service Dockerfiles are RETIRED templates | Rowan  | `infra/cloud/docker/platform.Dockerfile`                             |
| HTTP services (tasks-api, budget-api, content-scheduler-api) | One Fly app, four child processes behind the nginx router's path-prefix routes; `http_checks` on the platform app | Rowan | `infra/cloud/fly/platform.fly.toml` (+ `infra/cloud/platform/nginx.conf.template`) |
| Long-running worker              | Child process inside the platform app (no HTTP listener) | Rowan  | `infra/cloud/platform/platform-services.mjs`                 |
| Primary database                 | Neon managed Postgres (syd region, branch-per-env)       | Quinn  | Neon dashboard (URLs in `infra/cloud/env/*.env.example`)      |
| Queue + cache                    | Separate Fly-managed Upstash Redis add-ons for staging and production, both Pay-as-you-go in `syd` | Quinn | Fly Redis (`fly redis list --org personal`); names/plan/region in `platform-environments.mjs` |
| Object storage                   | (not used yet)                                           | —      | —                                                             |
| Observability                    | OpenTelemetry via `@sindustries/otel-node` → collector   | Shared | `infra/cloud/env/*.env.example` (OTEL_EXPORTER_OTLP_ENDPOINT) |
| Domain                           | `sindustries.co.nz` (apex for production; `*.staging.sindustries.co.nz` for staging) — supersedes the foundation's `sindustries.dev` reservation per task `5cb4a8fe` | Quinn  | DNS provider + `infra/cloud/hostname-matrix.json` (machine-readable source of truth) |
| CI deploy                        | GitHub Actions, path-filtered deployable surface, canary deploy of the platform app | Rowan  | `.github/workflows/deploy-staging-platform.yml`               |
| Secrets                          | Fly app secrets + GH repo secrets                        | Quinn  | `fly secrets set …` (operator CLI); `secrets.FLY_API_TOKEN`   |
| First-time setup                 | Idempotent local bootstrap script                        | Quinn  | `infra/cloud/scripts/bootstrap-staging.sh`                    |
| Rollback                         | `fly releases rollback <v>` — app-wide on the environment's platform app (`sindustries-platform-staging`, or `sindustries-platform-production` in production; shared fate) | Quinn  | `docs/runbooks/platform-consolidation-rollback.md` — the live staging rollback runbook (the prior `docs/runbooks/cloud-deployment-rollback.md` was retired in PR #583 and was never regenerated) |

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

**Decision:** Fly.io for compute, Neon for Postgres, and Fly-managed Upstash Redis.

### Fly.io

- **Pros.** Fast deploys from a Dockerfile (no platform-specific buildpack). Built-in canary deploys + releases history. Generous free tier + simple shared-cpu pricing. Sydney region available (matches Tom/Quinn geography + Akahu/NZ latency profile). Process-group isolation matched our `gymtrack-mcp` precedent (one Fly app per service) at the foundation milestone — the 2026-11-07 consolidation deliberately traded that isolation for shared fate, so staging is now one Fly app carrying all four services as child processes (see "Consolidated platform (task `219fb673`)"). No VPC/networking setup required to start.
- **Cons.** Tied to Fly's machine image + supervisor model. The Redis add-on is Upstash operated through Fly rather than a native Fly data service. VM-only — no scale-to-zero for HTTP services without `auto_stop_machines=stop`, which we use for staging cost control. Since the consolidation that lever is app-wide rather than per-service: the one platform app carries all four processes, so stopping it for cost stops every service with it — and it cannot be used for a service-scoped drill at all, because scaling the platform to zero is a full-platform outage wearing a service-scoped label (`infra/cloud/observability/failure-inject.sh` refuses for exactly that reason).
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

### Fly-managed Upstash Redis

- **Pros.** Serverless Redis with TLS by default, provisioned and billed through the same Fly organization as compute. Sydney region. Keeps the existing `REDIS_URL` contract unchanged.
- **Isolation.** `sindustries-staging` and `sindustries-production` are distinct Pay-as-you-go databases. They must never be collapsed: the BullMQ queue name is not environment-suffixed, so sharing one Redis would let either worker consume the other environment's jobs.
- **Cons.** The database still runs on Upstash, while lifecycle and billing are mediated by Fly. Direct Upstash account APIs cannot inventory these add-ons; the production evidence reads Fly's add-on GraphQL surface instead.
- **Alternatives considered.** Direct Upstash account databases (retired for staging and not the production source of truth), self-hosted Redis (operational burden), Memcached (no persistence, no BullMQ).

---

## Region

All four staging services run in **`syd` (Sydney, Australia)**. Reasoning:

1. Matches Tom/Quinn geography — operator on-call windows align with business hours.
2. Akahu (NZ open-banking) integration in `services/budget-api` benefits from low latency to NZ endpoints.
3. Twitter/X API has no regional preference, so region is irrelevant for `services/tasks-api` and `services/content-scheduler-api`.
4. Closest Fly.io region to the Auckland-based `services/gymtrack-mcp` for any future cross-region latency testing.

Production may move to `syd` or `nrt` (Tokyo) once traffic patterns emerge. The `primary_region` field is the single change point: `infra/cloud/fly/platform.fly.toml` for the staging platform, and the production app inherits that same value because `infra/cloud/fly/platform.production.overlay.toml` carries only `app` and `[env]`. The four per-service `fly.toml` files are RETIRED templates and are not the change point.

---

## Cost model

Current staging cost (4 services, near-idle):

| Resource                                        | Monthly estimate         | Notes                                                |
| ----------------------------------------------- | ------------------------ | ---------------------------------------------------- |
| Fly — 4 × `shared-cpu-1x` 1 GB machines         | ~$20/mo                  | HTTP services stop when idle; the worker stays available for queued jobs |
| Neon — staging branch (free tier)               | $0                       | Free tier covers staging; production will move to Pro |
| Fly-managed Upstash — staging Redis (Pay-as-you-go) | usage-based           | Dedicated `sindustries-staging` database in `syd`    |
| Domain — `sindustries.co.nz` (annual)           | ~$15/yr (~$1.25/mo)      | Quinn-registered; replaces the foundation's `sindustries.dev` reservation per task `5cb4a8fe` |
| GH Actions (deploys on push to main)            | $0                       | Within repo free tier                                |
| **Total staging**                               | **~$21/mo**              |                                                      |

Production cost projection: dominated by Neon compute-hours + Fly-managed Upstash request volume. Production uses its own `sindustries-production` Pay-as-you-go database in `syd`.

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
| DNS is separate from the app | The stable staging hostnames are live (task `5cb4a8fe`): each CNAME points at the consolidated platform app, so DNS still moves independently of the app. The per-service apps a CNAME move could once have pointed at were destroyed on 2026-11-07, so there is no per-service DNS backout to move. The backout inside the platform app is `fly releases rollback` — see `docs/runbooks/platform-consolidation-rollback.md`. |
| Health is shared | The platform's `/__status` answers **503** when any child is not running, because Fly's `http_check` reads the status code and not the body. One child stuck in a permanent crash loop therefore fails the whole platform's health and Fly restarts the Machine. That is the shared-fate trade taken deliberately: one bad service takes the platform's health down with it, rather than the platform reporting healthy while nginx proxies to a dead upstream. |
| The platform never scales to zero | `min_machines_running = 1` keeps the Machine running. The auto-post worker is queue-bound — no HTTP listener, no route, no traffic at 3am — so a platform allowed to stop would leave queued auto-posts unprocessed until an unrelated request auto-started it. The old per-service worker app had no `[http_service]` at all and therefore never auto-stopped. The cost consequence: the platform is billed for one always-on Machine, not an idle one, and the before/after comparison in the cutover runbook compares **one always-on 2GB Machine** against the four always-on per-service apps it replaces. |
| Secret visibility is shared | Every child inherits the app-level environment, so `TASKS_API_*`, `BUDGET_API_*` and `X_*` secrets on the platform app are readable by every child, not only the service that owns them. The variables that a child's own mapping owns (`DATABASE_URL`, `REDIS_URL`, `CONTENT_SCHEDULER_REDIS_URL`, `CONTENT_SCHEDULER_API_BASE_URL`, `CORS_ALLOWED_ORIGINS`, `PORT`) are **not** inherited — each child gets only the value its own `PLATFORM_*` source maps onto it, so "unset" means absent rather than another service's value. |

Mitigations, in the order they apply:

1. **Canary strategy.** `strategy = 'canary'` means a new Machine comes up
   beside the old release and Fly promotes it only once it is healthy, so a
   bad image does not replace a working one immediately.
2. **`fly releases rollback`** restores the previous image inside the
   platform app.
3. **The old apps are gone.** The four per-service apps were destroyed ahead
   of the 2026-11-07 cutover, so the CNAME-move-plus-`fly scale count 1`
   backout no longer exists. The only backout inside the platform app is
   `fly releases rollback` (mitigation 2 above).

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

## Production topology (task `fb1240c0`)

Production uses the **same consolidated topology as staging** — one Fly app
carrying all four services, plus a separate app for the health probe. The
environment manifest (`infra/cloud/platform/platform-environments.mjs`) is the
single source of truth for the production app names, and the bootstrap, the
deploy workflows, the hostname matrix and the secret contract all read it
from there instead of restating it.

| Fact | Production value | Where it comes from |
| --- | --- | --- |
| Platform app | `sindustries-platform-production` | the manifest's `platformApp` |
| Health-probe app | `sindustries-health-probe-production` | the manifest's `healthProbeApp` |
| API hostnames | `tasks-api.sindustries.co.nz`, `budget-api.sindustries.co.nz`, `content-scheduler-api.sindustries.co.nz` | `infra/cloud/hostname-matrix.json` |
| Health hostname | `health-probe.sindustries.co.nz` | `infra/cloud/hostname-matrix.json` |
| Provision gate (CI) | `PRODUCTION_PLATFORM_PROVISION_ENABLED=true` | the manifest |
| Deploy gate | `PRODUCTION_PLATFORM_DEPLOY_ENABLED=true` | the manifest |
| Migrations gate | `PRODUCTION_PLATFORM_MIGRATIONS_ENABLED=true` | the manifest |
| Fly config | the shared `infra/cloud/fly/platform.fly.toml` plus the production overlay, rendered to a gitignored path | `infra/cloud/fly/platform.production.overlay.toml` |

**Shared fate applies to production exactly as it does to staging.** One
Machine carries tasks-api, budget-api, content-scheduler-api and the
auto-post worker, so a crash, an OOM kill or a deploy restart takes all four
down together; `fly releases rollback` is app-wide and cannot roll one
service back; per-service scaling is impossible. Read
[Shared-fate topology (staging)](#shared-fate-topology-staging) for the full
consequence table — it carries over unchanged, because production deploys
the same shared topology with a production overlay rather than a
one-app-per-service shape. The production-only difference is the deployment
target: the overlay names the production app and the production CORS
origins, and the renderer refuses an overlay that forks the topology.

**Ownership split.** Rowan owns the repository contracts — the manifest, the
provisioner, the bootstrap, the deploy workflows, the drift checks and these
docs. Quinn owns the operator execution — the production Neon branch, the
Fly apps, the secrets, the DNS records, the spend limit and the deploy
dispatch — using the credentials registered in the `production` GitHub
Environment. Tom owns the organisation billing action if the Fly account
does not allow the spend limit to be set directly. The full operator order
is Slice D of
[`docs/specs/production-environment-provisioning-tech-design.md`](../specs/production-environment-provisioning-tech-design.md).

**The spend bound is designed to come before real traffic.** The
production app carries a live budget and a public API surface, so the
organisation/app spend bound must be set — and read back — **before** the
platform canary deploy or any public hostname is enabled. It is not a
post-cutover tidy-up: the limit is what bounds the blast radius of a
runaway production deploy, and the health probe must not go out before it
either (the operator order deploys the platform first and the probe last).

That order is enforced, not only documented. The provisioning-state checker
decides a `fly.spend-limit-before-public-exposure` gate: while a
production hostname is published in DNS, the consolidated production
platform app is running, or the production health-probe app is running,
an artifact with no recorded spend-limit read-back fails the gate. The
platform app is exposure in its own right: every production API hostname
points at it and Fly gives it its own public `.fly.dev` hostname, so it
answers on the public internet before any DNS record exists. A second
gate, `fly.spend-bound-ordering`, enforces the ORDER
itself: the capture records when production became publicly exposed (the
Cloudflare record's creation time, the production platform app's release
time and the production probe's release
time), and the bound's read-back time is compared with it. A bound read
back after the exposure fails that gate — the order cannot be un-violated
by recording — so the closure path is a recorded human acceptance of the
deviation (`flySpendOrderingDeviation`, the same value-free shape as every
other read-back, and it must name every exposed surface — the production
hostnames, the health-probe app and the production platform app), or the
exposure is rolled back until the bound is in place.

On this account Fly exposes no native spend-limit surface, so the approved
bound is a dedicated prepaid/capped billing method. The actual production
bound was read back after public exposure. Tom explicitly accepted that
irreversible ordering deviation on 2026-11-18 and selected the capped card
as the external financial control; the recorded acceptance names every
exposed surface and is kept in
`infra/cloud/evidence/production-operator-evidence.json`. The checker does
not rewrite the chronology: it still reports that the bound followed
exposure and cites the recorded acceptance as the closure path.

The read-back itself is operator evidence — a boolean, the time it
was read back, the CONTROL that bounded the spend (a native Fly spend
limit, or the approved prepaid/capped billing method — this account has
no native Fly spend-limit surface), and a required pointer to the
read-back, never a value — recorded in
the artifact's `operatorEvidence` section by
`infra/cloud/scripts/capture-production-provisioning-state.mjs`. The
committed `infra/cloud/evidence/production-operator-evidence.json` is
loaded automatically; `--operator-evidence <file>` overrides it for a
one-off capture. The same section closes the four operator read-backs no
machine can prove (the staging/dev Neon denial proof, one successful
production probe interval, the production API health responses and the
DNS resolution/TLS read-back) and carries the two explicit human
decision records (the Neon Free-tier control and the spend-order
deviation).

A recorded read-back is only as good as what it covers, so it also names
the production surfaces it was read back against, in `targets`. A boolean
proves that a statement was made, not that the statement was true of the
production environment: a record scoped "done" would otherwise close the
DNS read-back while no production hostname resolved. The checker compares
`targets` against the surfaces the repository expects for that slot — the
production app scope for the spend limit, the production health-probe app
for the probe interval, the three production API hostnames for the health
responses, every production hostname for the DNS/TLS read-back, and the
production branch with both the staging and the dev credential for the
Neon denial proof — and leaves the obligation open when the record names
none of them, only some of them, or a surface production does not use. The
app names and hostnames are derived from the environment manifest and the
hostname matrix; the Neon credential kinds are fixed by the Neon contract.
The expected sets therefore cannot drift away from the topology the
repository uses. The pointer is required, not decorative: a recorded slot
without an inspectable `evidenceRef` is refused, and a read-back stamped
after the artifact was captured is refused too. A pointer is only
inspectable if it RESOLVES: it must be a repository-relative path to a
file that exists in the checkout, and a path that escapes the repository
or names nothing is refused. A slot therefore cannot close on a pointer
nobody could open. The capture therefore fails
fast on an incomplete record instead of producing an artifact whose gates
cannot be trusted.

**Credential boundary.** The production credential path is the same rule as
staging, with the `production` GitHub Environment instead of `staging`: the
live values (`FLY_API_TOKEN`, the Neon production DSNs, the Fly-managed
Upstash production Redis URL, the DNS provider token) are owned and registered by
Quinn as masked secrets and never enter the repo. The repository carries
only the *names* the manifest requires (the `PRODUCTION_*` source names) and
the provisioning contract that maps them onto the app-level `PLATFORM_*`
secrets. The provisioner refuses a production value that still carries a
staging/dev hostname, a placeholder or a localhost address, so a staging
credential cannot be registered on the production app by accident, and the
dry-run mode prints secret *names* only — never values. See
[Credential boundary](#credential-boundary) for the full boundary and the
repair path for a missing `FLY_API_TOKEN`.

**Production is live.** On 2026-11-16 the consolidated platform, production
health probe, Neon branch, dedicated Fly-managed Redis add-on and the four
Fly-hosted production DNS/TLS surfaces were provisioned. The value-free live
read-backs are in
[`docs/cloud/production-provisioning-readback.md`](../cloud/production-provisioning-readback.md).

**The Neon connectivity control is schema-scoped service-role isolation.**
The production Neon organisation deliberately remains on the Free plan,
where IP Allow is unavailable. Tom's 2026-11-18 decision re-specifies
AC2's evidence around the control this account can enforce: one
write-capable, schema-scoped login role per production schema, with the
staging and dev credentials both proved unable to connect to the
production branch. The provisioning-state checker decides
`neon.connectivity-restriction` from the live role inventory, the denial
proof and the recorded acceptance; on a complete Free-plan record the
IP-allowlist gates are **not applicable**, not green. The checker never
claims an allowlist that the provider cannot express. The abandoned
app-scoped Fly egress allocations are a cleanup candidate, not an open AC2
gate. See
[`docs/cloud/production-neon-contract.md`](../cloud/production-neon-contract.md).

---

## Platform secret provisioning (task `219fb673`)

The consolidated platform app (`sindustries-platform-staging`) needs fifteen
app-level secrets before it can boot: three database URLs, six Redis URLs,
two approval-service credentials, one public base URL and three CORS
allow-lists. They are provisioned from the
**staging GitHub environment** by
`infra/cloud/platform/platform-provision-secrets.mjs`, which the
`.github/workflows/deploy-staging-platform.yml` workflow runs before the
deploy.

The provisioner is parameterised by environment
(`--environment staging|production`, default staging). Every
environment-owned fact — the Fly app names, the GitHub Environment, the
secret source names, the schema names, the public base URLs and the CORS
allow-lists — lives in one place,
`infra/cloud/platform/platform-environments.mjs`. The table below is the
staging half of that manifest; the production half differs in the source
names, the base URLs and the CORS allow-lists.

| Platform secret | Staging environment secret | Note |
| --- | --- | --- |
| `PLATFORM_TASKS_API_DATABASE_URL` | `STAGING_TASKS_API_DATABASE_URL` | write-capable; schema forced to `tasks_api` |
| `PLATFORM_BUDGET_API_DATABASE_URL` | `STAGING_BUDGET_API_DATABASE_URL` | write-capable; schema forced to `budget_api` |
| `PLATFORM_CONTENT_SCHEDULER_API_DATABASE_URL` | `STAGING_CONTENT_SCHEDULER_API_DATABASE_URL`, or derived from the tasks-api DSN | one Neon database, three schemas; schema forced to `content_scheduler` |
| `PLATFORM_*_REDIS_URL` (6 names) | `HEALTH_PROBE_REDIS` | one live Redis instance — every live per-service Redis secret has the same Fly digest, so all six names take the same value |
| `PLATFORM_CONTENT_SCHEDULER_API_BASE_URL` | — | public URL, registered as a plain value |
| `TASKS_API_APPROVAL_SERVICE_CREDENTIALS` | `TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN` **+** `TASKS_API_OPERATOR_APPROVAL_SERVICE_CREDENTIALS` | inherited name; the platform token and the operator array are MERGED into one `[{token, actor, approvalTypes}]` JSON the services parse — see [Production approval credential set](#production-approval-credential-set-task-3c004590) |
| `CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS` | `CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN` **+** `CONTENT_SCHEDULER_API_OPERATOR_APPROVAL_SERVICE_CREDENTIALS` | inherited name, same merge |
| `PLATFORM_TASKS_API_CORS_ALLOWED_ORIGINS` | — | comma-separated allow-list; from the environment manifest (`corsAllowedOrigins.tasksApi`), not a GitHub environment secret |
| `PLATFORM_BUDGET_API_CORS_ALLOWED_ORIGINS` | — | comma-separated allow-list; from the environment manifest (`corsAllowedOrigins.budgetApi`) |
| `PLATFORM_CONTENT_SCHEDULER_API_CORS_ALLOWED_ORIGINS` | — | comma-separated allow-list; from the environment manifest (`corsAllowedOrigins.contentSchedulerApi`) |

**This table is the operator contract, and it matches the supervisor.**
The three CORS values are not optional: `infra/cloud/platform/platform-services.mjs`
lists them in each child's `requiredSources`, so the supervisor refuses to
boot without them. They are registered from the environment manifest
rather than left to the Fly TOML, because the TOML holds the STAGING
allow-lists — a production app that inherited them would answer every
preflight from the wrong origin.

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

**The router's config path is absolute, and the config is rendered from the
environment manifest.** `nginx -c <path>` resolves a relative path against
nginx's own compile-time prefix (`/var/lib/nginx` on alpine), not against
the child's working directory, so the relative form failed with `nginx:
[emerg] open() "/var/lib/nginx/infra/cloud/platform/nginx.conf" failed`.
The image now carries the topology as
`/app/infra/cloud/platform/nginx.conf.template`; before spawning nginx, the
supervisor renders the environment-owned hostnames into
`/tmp/sindustries-platform/nginx.conf` and passes that absolute path to
nginx. Staging renders the staging stable hostnames and production renders
the production stable hostnames from
`infra/cloud/platform/platform-environments.mjs`. This removes the previous
production hazard where one static staging-only nginx file would have made
the production app route production traffic by staging hostnames.

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
and the gate is a blanket opt-in on every staging deploy: after the
2026-11-07 cutover every service name resolves to the platform app, so
there is no service name that reaches it without passing the gate. The
operator path (`infra/cloud/bin/deploy platform`) is gated by the same
variable, so the opt-in cannot be bypassed. The gate's original purpose
— keeping a merged platform deploy from cutting staging over while the old
`sindustries-auto-post-worker-staging` app was still consuming the same
BullMQ queue — was discharged by that cutover: the four per-service
staging apps were destroyed ahead of it, so the platform's auto-post worker
is the only consumer of the queue. The cutover order was
`docs/runbooks/platform-consolidation-rollback.md` §3, which records the
sequence as it was executed on 2026-11-07 (the DNS steps 3, 4 and 7 did not
run in that sequence). The DNS leg has since landed separately: task
`5cb4a8fe` created the three stable `*.staging.sindustries.co.nz` records and
pointed them at the platform app, so stable-hostname traffic is live and the
`*.fly.dev` provider hostnames are the documented fallback rather than the
only route. Verified 2026-11-19: each stable hostname resolves to the
platform app's provider hostname and answers HTTP 200 on `/health`
(`sindustries-platform-staging.fly.dev` <!-- stable-fallback: provider CNAME target; the stable hostnames are the per-service *.staging.sindustries.co.nz names -->).

## Account / ownership / billing

| Asset                                | Owner  | How it's paid                                |
| ------------------------------------ | ------ | -------------------------------------------- |
| Fly.io organisation `personal`       | Quinn  | Quinn's personal card; will move to SIndustries billing once that's a legal entity |
| Neon account + projects              | Quinn  | Same                                         |
| Fly-managed Redis add-ons            | Quinn  | Billed through the `personal` Fly organization |
| `sindustries.co.nz` domain           | Quinn  | Same                                         |
| GH repo secrets (`FLY_API_TOKEN`)    | Quinn  | n/a (no cost)                                |
| GH Actions minutes                   | GitHub | Within the org's plan                        |

This is a staging foundation — Quinn is the single point of contact for credential rotation and billing. When the SIndustries entity exists, transfer all four accounts.

---

## Domain reservations

| Domain             | Use                                       | Status                         |
| ------------------ | ----------------------------------------- | ------------------------------ |
| `sindustries.co.nz` (apex) | Production frontends + APIs (mission-control, tasks, tasks-api, budget-api, content-scheduler-api, health-probe) | Quinn-registered; matrix at `infra/cloud/hostname-matrix.json`; CNAMEs + certs live (task `5cb4a8fe`, verified live 2026-11-21: all six production hostnames resolve and serve HTTP 200) |
| `staging.sindustries.co.nz` (subdomain) | Staging frontends + APIs (same six surfaces)        | Records live in the same apex zone (task `5cb4a8fe`, verified live 2026-11-21: all six staging hostnames resolve and serve HTTP 200); matrix at `infra/cloud/hostname-matrix.json` |
| `sindustries.dev` (legacy)    | Wildcard CNAMEs to Fly app subdomains (audited historical reservation) | Superseded by `sindustries.co.nz` for staging and production per task `5cb4a8fe`; remains documented for audit only |

## Stable hostname matrix (task `5cb4a8fe`)

The full staging + production hostname matrix lives at [`infra/cloud/hostname-matrix.json`](../../infra/cloud/hostname-matrix.json) (the machine-readable source of truth). The matrix records:

- Six public surfaces: mission-control, tasks-app, tasks-api, budget-api, content-scheduler-api, health-probe.
- The auto-post worker row with `staging: null`, `production: null`, and `publicUrl: false` — the explicit non-public nature is auditable from the matrix and from the per-hostname comment block at the top of `infra/cloud/fly/auto-post-worker.fly.toml`.
- A `providerFallback` per public surface (the `*.fly.dev` / `*.vercel.app` URL the design records as the migration path). The stable CNAMEs + certs have landed since — task `5cb4a8fe` created the records (verified live 2026-11-21) — so the provider URL is the documented fallback rather than the only route.
- A `cnameTargets` per public surface (the DNS target each stable hostname's CNAME must resolve to, per environment).
- A `vercelProject` per frontend surface (the production Vercel project that owns the production stable hostname) and a `vercelStagingProject` (the staging Vercel project that owns the staging stable hostname).

`providerFallback` and `cnameTargets` are different things and are not interchangeable. `providerFallback` is the **production** provider host — the documented migration path. `cnameTargets` is the per-environment DNS target:

| Surface | `cnameTargets.staging` | `cnameTargets.production` |
| --- | --- | --- |
| mission-control | `cname.vercel-dns.com` | `cname.vercel-dns.com` |
| tasks-app | `cname.vercel-dns.com` | `cname.vercel-dns.com` |
| tasks-api | `sindustries-platform-staging.fly.dev` <!-- stable-fallback: provider CNAME target; the stable hostname is tasks-api.staging.sindustries.co.nz --> | `sindustries-platform-production.fly.dev` <!-- stable-fallback: provider CNAME target; the stable hostname is tasks-api.sindustries.co.nz --> |
| budget-api | `sindustries-platform-staging.fly.dev` <!-- stable-fallback: provider CNAME target; the stable hostname is budget-api.staging.sindustries.co.nz --> | `sindustries-platform-production.fly.dev` <!-- stable-fallback: provider CNAME target; the stable hostname is budget-api.sindustries.co.nz --> |
| content-scheduler-api | `sindustries-platform-staging.fly.dev` <!-- stable-fallback: provider CNAME target; the stable hostname is content-scheduler-api.staging.sindustries.co.nz --> | `sindustries-platform-production.fly.dev` <!-- stable-fallback: provider CNAME target; the stable hostname is content-scheduler-api.sindustries.co.nz --> |
| health-probe | `sindustries-health-probe-staging.fly.dev` <!-- stable-fallback: provider CNAME target; the stable hostname is health-probe.staging.sindustries.co.nz --> | `sindustries-health-probe-production.fly.dev` <!-- stable-fallback: provider CNAME target; the stable hostname is health-probe.sindustries.co.nz --> |

The three API surfaces use one consolidated platform Fly app per environment
(staging: task `219fb673`; production: task `fb1240c0`). Health-probe keeps its
own Fly app per environment. The matrix retains each API's legacy per-service
`providerFallback` for migration and rollback evidence, but those hosts are not
the target topology. Health-probe likewise retains
`sindustries-health-probe.fly.dev` <!-- stable-fallback: legacy production provider host retained for migration evidence --> only as its legacy `providerFallback`; its
production app and production CNAME target are
`sindustries-health-probe-production` and
`sindustries-health-probe-production.fly.dev`. <!-- stable-fallback: production provider CNAME target; the stable hostname is health-probe.sindustries.co.nz -->

The Vercel frontends CNAME to Vercel's shared managed custom-domain target in both environments. That target is the same for **every** Vercel project, so the DNS shape carries no environment identity at all for those two surfaces: the staging hostname and the production hostname of one project resolve to byte-identical DNS. The environment separation therefore lives in the Vercel **project** that owns each stable hostname — the staging hostname lives in the staging project, the production hostname in the production project:

| Surface | `vercelStagingProject` | `vercelProject` |
| --- | --- | --- |
| mission-control | `sindustries-mission-control-staging` | `sindustries-mission-control` |
| tasks-app | `sindustries-tasks-app-staging` | `sindustries-tasks` |

**Project model (Quinn, 2026-11-13, task `5cb4a8fe`).** The separation is per project, not per Vercel environment. Neither project has a `preview` target: each carries exactly one environment — its own production deployment target — and `infra/cloud/vercel-env-matrix.json` records which Sindustries environment that target serves in `servesEnvironment`. The earlier model (`vercelEnvironments.staging = preview`) did not describe reality: the live staging projects have no `preview` target and their custom domains are bound to their production deployment target.

`tests/cloud/scripts/check-stable-hostname-matrix.mjs` asserts that the two stable hostnames bind to **different** Vercel projects, that each project carries exactly one environment, and that each project's environment binds the matching stable hostname in `infra/cloud/vercel-env-matrix.json`.

**AC2 for the two frontends is verified at two different levels, and the weaker one must not be overstated:**

- **Repo-verified (contract):** the staging stable hostname is bound to the surface's staging Vercel project and the production stable hostname to a different one; the staging project's `VITE_*` API base URLs point at the staging API hostnames (asserted by `tests/cloud/scripts/check-vercel-env-matrix.mjs`).
- **Operator-verified (Vercel — not repo-verified):** that the bound project is actually serving a deployment built from the expected branch (`main` for both the staging and the production projects). The `mission-control-vercel` branch named by the earlier mission-control-vercel-deployment tech design was never created in the repository; the deployments serving the stable staging hostnames were built from `main`, commit 7ba14896.

The HTTPS check does **not** distinguish a staging deployment from a production one — a production build served under the staging hostname returns a healthy 200. It is a reachability and certificate check, not an environment-separation check, and the docs must not describe it as the separator.

Asserting `providerFallback` against a staging hostname demands a CNAME to the **production** provider host. That is a cross-environment alias — the thing AC2 forbids — and no staging deployment serves it. The harness therefore reads `cnameTargets[environment]`; `tests/cloud/scripts/check-stable-hostname-matrix.mjs` additionally fails the build if a staging target is **any** production target — the union of `cnameTargets.production` and `providerFallback`, because those two are deliberately allowed to diverge (task `020f423e` renames the production apps, so the CNAME target moves while the documented migration-path fallback stays). Vercel's shared managed target is excepted from the comparison, since it carries no environment identity.

The static checks `tests/cloud/scripts/check-stable-hostname-matrix.mjs` and `tests/cloud/scripts/check-stable-url-fallbacks.mjs` enforce the matrix on every CI run; both pass on the committed tree at the time of writing.

Staging is reached on the one consolidated platform app — one path prefix per API surface on the provider hostname, and the root of each surface on its own stable hostname, because the stable staging CNAMEs are live. The four per-service staging Fly apps (`sindustries-tasks-api-staging`, `sindustries-budget-api-staging`, `sindustries-content-scheduler-api-staging`, `sindustries-auto-post-worker-staging`) were destroyed by the 2026-11-07 cutover (task `219fb673`); the three API services and the auto-post worker now run as supervisor children of the platform app, and the in-container nginx router strips the matched path prefix before proxying. The shared router topology lives in `infra/cloud/platform/nginx.conf.template`; the supervisor renders the environment-specific hostnames from the environment manifest at boot.

- `https://sindustries-platform-staging.fly.dev/tasks-api/health` <!-- stable-fallback: documented-migration; superseded by https://tasks-api.staging.sindustries.co.nz/health — the stable staging CNAME and cert are live (verified 2026-11-18) -->
- `https://sindustries-platform-staging.fly.dev/budget-api/health` <!-- stable-fallback: documented-migration; superseded by https://budget-api.staging.sindustries.co.nz/health — the stable staging CNAME and cert are live (verified 2026-11-18) -->
- `https://sindustries-platform-staging.fly.dev/content-scheduler-api/health` <!-- stable-fallback: documented-migration; superseded by https://content-scheduler-api.staging.sindustries.co.nz/health — the stable staging CNAME and cert are live (verified 2026-11-18) -->
- auto-post worker — it has no HTTP surface of its own (it is a queue-bound child process with no listener). Its health is observed on the content-scheduler-api surface at `https://sindustries-platform-staging.fly.dev/content-scheduler-api/api/v1/content-scheduler/auto-post/health` <!-- stable-fallback: documented-migration; auto-post worker keeps no public URL on the stable hostname matrix either (task 5cb4a8fe) -->

The same host-and-path-prefix pairs are recorded per surface in `infra/cloud/hostname-matrix.json` (`stagingRoutes`).

### Live AC5 harness result (2026-11-11)

`MATRIX_LIVE=1 node tests/cloud/scripts/stable-hostname-verification.mjs --mode live` against the real staging hostnames:

| Surface | DNS | HTTPS | CORS preflight | Row |
| --- | --- | --- | --- | --- |
| tasks-api | ok | ok | ok | ok |
| budget-api | ok | ok | ok | ok |
| content-scheduler-api | ok | ok | ok | ok |
| health-probe | ok | ok | ok | ok |
| mission-control | ok | **502 (observer-side block)** | skipped | fail |
| tasks-app | ok | **502 (observer-side block)** | skipped | fail |
| auto-post-worker | — | — | — | skip (no public URL by design) |

The four API surfaces pass the full DNS + HTTPS + CORS chain through their stable staging hostnames.

The two Vercel frontends could not be verified **from the host that ran the harness**: `mission-control.staging.sindustries.co.nz` and `tasks.staging.sindustries.co.nz` return HTTP 502 with the body `Secret egress proxy could not reach the upstream host.`, and a direct (proxy-bypassed) request from the same host fails to connect at all. The same host, through the same proxy, reaches those deployments' own `*.vercel.app` hostnames with HTTP 200 and the app HTML. The 502 is therefore produced by the proxy in the request path, **before** the request reaches the deployment — it is not evidence that the deployment is down, and it is not a DNS-shape gap either. The CNAMEs are correct (`cname.vercel-dns.com`, matching the matrix's `cnameTargets.staging`).

The harness now classifies this case explicitly for both HTTPS and CORS preflight probes: a response whose body carries a proxy marker, or a gateway status behind a proxy that `NO_PROXY` does not exempt, is recorded as `failureMode: proxy_blocked` rather than an upstream status, and the row evidence says the harness could not reach the deployment. CORS preflight also requires both a successful 2xx status and the expected allow-origin header; a failed preflight reads a bounded response-body excerpt and applies the same failure classification. Before an excerpt is persisted in result JSON or row evidence, the redactor removes URI userinfo and Basic/Proxy-Authorization credential values. The row still fails — the harness could not verify the hostname, so the AC5 live gate stays open — but the failure is no longer attributed to the deployment.

**Outstanding for AC5 (as recorded on 2026-11-11):** the two frontend rows must be verified from a host that is not behind the proxy block (or from CI) before the live gate can pass. **That verification now exists** — see [Live AC5 harness result — public-internet runner (2026-11-15 NZ)](#live-ac5-harness-result--public-internet-runner-2026-11-15-nz) below: dispatched on a public-internet runner, both frontend rows pass. The representative authenticated staging workflow was still open at that point; the separate staging-validation run recorded below now closes that final AC5 staging leg.

### Live verification from a public-internet runner

`.github/workflows/stable-hostname-live-verify.yml` is the dispatch-only path that produces the public-internet verdict the operator host cannot. It runs the same harness (`--mode live`) on a GitHub-hosted `ubuntu-latest` runner with the proxy environment cleared and `NO_PROXY` pinned, so the request path is provably direct: a proxy in the path answers before the request leaves the runner and turns a deployment verdict into `failureMode: proxy_blocked`.

The workflow is deliberately narrow:

- **dispatch only** — no `push`, `pull_request` or `schedule` trigger, so it never fires unattended against a moving deployment;
- **no deploy** — it does not touch the Fly or Vercel control planes;
- **no credentials** — the harness performs DNS resolution, an HTTPS `GET` on a health endpoint and a CORS preflight and reads no token, so the job needs no GitHub environment and no secret;
- **the redacted result JSON is uploaded as a run artifact**, including when the harness reports a failure, because a failing run is the evidence.

`tests/cloud/tests/stable-hostname-live-verify-workflow.test.mjs` asserts that contract on every CI run, so the workflow cannot quietly start firing unattended, reading a credential, deploying, or running behind a proxy again.

A failing row in that workflow is the honest signal that a surface is not serving as the matrix describes. The workflow produces evidence; it does not assert an AC.

**The expectation this section carried until 2026-11-15 was wrong, and the workflow is what caught it.** It previously stated that the two Vercel frontends were expected to fail because the matrix names Vercel projects that do not exist. That conflated two different projects. The names the matrix records for the **production** hostnames (`vercelProject`) did not exist in the Vercel team when this section was written; that gap closed on 2026-11-18, when task `5044e708` provisioned the two production projects and bound their custom domains. The **staging** hostnames are bound to the staging projects the matrix already records as `vercelStagingProject`, and those serve. The first dispatch of this workflow returns `verdict: pass` for both frontend rows; the AC5 staging clause is therefore evidenced.

### Live AC5 harness result — public-internet runner (2026-11-15 NZ)

`.github/workflows/stable-hostname-live-verify.yml` dispatched on `main` at commit `e2c58158` — run `43595192346`, harness `runId: stable-hostname-live-43595192346-1` — produced the first public-internet verdict for this matrix:

| Surface | DNS | HTTPS | CORS preflight | Row |
| --- | --- | --- | --- | --- |
| tasks-api | ok | ok | ok | ok |
| budget-api | ok | ok | ok | ok |
| content-scheduler-api | ok | ok | ok | ok |
| health-probe | ok | ok | — | ok |
| mission-control | ok | ok | — | ok |
| tasks-app | ok | ok | — | ok |
| auto-post-worker | — | — | — | skip (no public URL by design) |

`verdict: pass`. Every public surface resolves through its stable staging hostname, answers HTTPS with a certificate valid for that hostname, and — for the three API surfaces — passes a CORS preflight from the expected frontend origin. The two Vercel frontends return HTTP 200 on `/` through their stable hostnames, and the content-scheduler surface answers 200 on the auto-post worker's health route, so the worker is observed on the API surface exactly as the matrix records it. The auto-post worker row is skipped because it has no public URL by design.

Three rows carry no CORS column value because they are not CORS origins: the two frontends are browser entry points rather than API servers, and the health probe exposes no browser-facing surface. The harness records `cors: null` for those rows rather than a pass, so the table above does not overstate them.

This credential-free public-runner result did **not** cover the representative authenticated staging workflow (`representativeWorkflow: skip`, owned by `tests/cloud/staging-workflows.mjs`). The separate staging-validation run below now covers that leg. The production hostnames have moved since: every per-surface production hostname now resolves to the deployment the matrix names and presents a certificate whose CN is the hostname itself (read back 2026-11-18), so the production DNS/TLS state is recorded as closed in the AC6 register [`docs/cloud/production-blockers.md`](../../docs/cloud/production-blockers.md). What still sits on the production side is the smoke-and-cutover activity the register tracks as a separate task, not the hostname state.

A caveat worth keeping in view: the harness proves a hostname resolves and serves. It cannot tell a staging deployment from a production one behind the same hostname, because both are verified through reachability and TLS only. Environment separation for the two Vercel frontends therefore rests on the distinct Vercel projects recorded by the matrix (`vercelStagingProject` for staging and `vercelProject` for production), not on this verdict.

### Authenticated staging workflow result — staging-validation runner (2026-11-15 NZ)

`.github/workflows/cloud-staging-validate.yml` dispatched on `main` at commit `5c924937` — [run `43606147320`](https://github.com/Stoffer-Industries/sindustries/actions/runs/43606147320), harness `runId: staging-validate-20261114144157-4a73` — exercised the representative authenticated staging workflows through the stable hostnames:

| Surface | Authenticated workflow evidence |
| --- | --- |
| tasks-api | create, read, comment, patch, archive, and list-excludes-archived all passed through `tasks-api.staging.sindustries.co.nz` |
| budget-api | `/me` passed through `budget-api.staging.sindustries.co.nz` using the synthetic staging session |
| content-scheduler-api | auto-post health, create, approve, and unapprove passed through `content-scheduler-api.staging.sindustries.co.nz` |

The structured result is `verdict: pass`; all 15 recorded checks pass, and `cleanup.ok` is `true`. The synthetic budget session was revoked (one user and one session deleted), the synthetic scheduler item was removed, and the synthetic task was archived. The artifact is redacted and contains no credential values.

The run's intent commit is `5c924937`, whose diff is documentation-only, so the workflow classified it as `tests-only`; the deployed services reported version `e2c58158` and `matchesIntent: true` under that scope rule. This does not weaken the AC5 result: every request in the authenticated harness used the stable staging hostname, and none used a provider fallback URL.

One accepted limitation remains explicit in the result: the deeper Budget API linked-card write path is skipped by design because its prerequisite fixture is not exposed publicly. That boundary is recorded in the approved staging-environment design and does not replace the representative `/me` authenticated workflow.

Together, run `43595192346` and run `43606147320` now supply the complete AC5 staging evidence: public frontend roots/assets, API health, Content Scheduler auto-post health, and representative authenticated staging workflows all work through the stable hostnames. The task checkbox remains untouched pending Tom/QA's gate.

The stable staging CNAMEs are live: each `<service>.staging.sindustries.co.nz` CNAME points at the consolidated platform app (the router serves each stable hostname at the root of its own surface), and the live deploy workflow `.github/workflows/deploy-staging-platform.yml` now smoke-checks both routes — the provider-host path-prefix routes are the blocking readiness check, and the stable hostnames are reported alongside them. The four per-service `deploy-staging-*.yml` workflows are retained-but-orphaned (`workflow_call` only; each still defines its own `deploy` job, but nothing calls them since their caller jobs were removed from `ci.yml` on 2026-11-07) and are scheduled for deletion in `docs/runbooks/platform-consolidation-rollback.md` §5.

## Vercel env var matrix (task `5cb4a8fe`)

The **Vercel half** of AC3 — the contract between the hostname matrix and the VITE_* env vars the two Vercel frontends consume at build time — lives at [`infra/cloud/vercel-env-matrix.json`](../../infra/cloud/vercel-env-matrix.json). The contract records, per Vercel project, which Sindustries environment its production deployment target serves, which VITE_* env vars to set and what value to set them to. Every matrix-derived value is the production or staging hostname from `infra/cloud/hostname-matrix.json`; the static check `tests/cloud/scripts/check-vercel-env-matrix.mjs` enforces that on every CI run.

| Vercel project | App | Serves | Build-time vars |
| --- | --- | --- | --- |
| `sindustries-mission-control` | `apps/mission-control` | production | `VITE_TASKS_API_BASE_URL`, `VITE_CONTENT_SCHEDULER_API_BASE_URL` |
| `sindustries-mission-control-staging` | `apps/mission-control` | staging | `VITE_TASKS_API_BASE_URL`, `VITE_CONTENT_SCHEDULER_API_BASE_URL` |
| `sindustries-tasks` | `apps/tasks` | production | `VITE_TASKS_API_BASE_URL` |
| `sindustries-tasks-app-staging` | `apps/tasks` | staging | `VITE_TASKS_API_BASE_URL` |

Out of scope for this matrix (recorded in `outOfScope[]`):

- `sindustries-gymtrack` — owned by the Clerk cutover (task `bb09eaed`); GymTrack's VITE_SUPABASE_URL / VITE_AUTH_PROVIDER / VITE_GYMTRACK_MCP_BASE_URL env vars are not in scope for `5cb4a8fe`.
- `sindustries-website` — static marketing content with no API surface; no VITE_* env vars.

Quinn sets the actual values in the Vercel dashboard per the contract; the contract itself is the engineer's responsibility. The project is the environment boundary: each of the four projects has exactly one Vercel production target, and there is no shared-project preview target carrying staging.

The custom domain each project serves is also recorded in the matrix JSON and enforced by the same static check, so a typo in either the env var value or the custom domain fails CI rather than silently shipping to Vercel.

## Production blockers (task `5cb4a8fe`)

The full production-blockers list — DNS records, TLS certs, Vercel custom domain registration, Vercel env var provisioning, Fly secrets, and the cross-environment safety net — is tracked in [`docs/cloud/production-blockers.md`](../cloud/production-blockers.md). Each blocker has a named owner (Quinn for DNS / TLS / Vercel / Fly secrets; separate tasks for production deploy workflows and production cutover) and a status field. The production deploy workflows and the production cutover are explicitly out of scope for `5cb4a8fe`: the deploy workflows ship with task `fb1240c0` (see [Production topology](#production-topology-task-fb1240c0)), and the cutover stays with tasks `020f423e` and `f2c23e26`.

The static checks above are the cross-environment safety net: a staging URL accidentally pasted into a production Vercel environment or production fly.toml fails the cross-env drift check at compile time, not at runtime. Quinn does not need to remember "don't paste staging credentials into production"; the contract makes it impossible to ship without the matching matrix value.

`tests/cloud/scripts/check-production-blockers-register.mjs` closes the last gap in that net: the register and the matrix are two files, and a rename in the matrix that did not reach the register would leave the operator-facing document pointing at a project that does not exist. The check asserts every surface with a production hostname has a row in the register and that the row carries the matrix's exact project/app identifier.

The production projects `sindustries-mission-control` and `sindustries-tasks` were provisioned on 2026-11-18 with their production custom domains and VITE_* values. `infra/cloud/vercel-env-matrix.json` records that observed state with `provisioned: true`; the blockers register remains the evidence surface for first-deployment TLS and live-bundle verification.

## Production cutover readiness (task `f2c23e26`)

The production data cutover has three independent keys: the `production` GitHub Environment's required reviewers, the typed `MIGRATE PRODUCTION` confirmation, and the declared source/destination endpoints. Two of them are enforced in code — the workflow refuses a mistyped confirmation (exit 10) and the harness refuses any endpoint outside the declared allowlist. The THIRD was, until this slice, enforced in prose only.

The Environment's approval gate is the only key the ENVIRONMENT can enforce, so it is also the only one that can be silently inert: an Environment with no protection rules has no reviewer, no approval, and a dispatch that starts unattended. The six cutover DSN secrets were in the same position — the workflow fails closed on them (exit 11), but only at dispatch time, on the operator's machine, naming no owner. The cutover moves TWO services: `tasks_api` and `content_scheduler` (Budget and GymTrack MCP are deferred), so the harness migrates and reconciles those two schemas and no longer the `budget_api` one.

`tests/cloud/scripts/check-production-cutover-readiness.mjs` decides every gate in the table below, BEFORE the dispatch, and names the owner of each unmet gate. It reads the redacted artifact that `infra/cloud/scripts/capture-production-provisioning-state.mjs` writes (schema version 13, which records the Environment's protection rule types, the required-reviewer count, the wait timer and whether admins may bypass — rule types and a count only; a reviewer's login is a person's identity and no gate needs it — and the production environment's Neon database inventory). The checker fails closed: an Environment that could not be read is an OPEN gate, not a silent pass, because "not captured" is not "fine".

A third fact sat in the same position and is now a gate too: a cutover DSN secret can be REGISTERED against a database that does not exist. The workflow's secret check asks only whether the secret is non-empty, so a DSN pointing at a database that was never created passes it and fails at the RESTORE — after the dump, with the source already quiesced. `neon.cutover-destination-database` therefore counts the distinct databases the production Neon branches serve and refuses to call the cutover ready while there are none. A Neon DATABASE is identified by its branch and its name, never by the endpoint that serves it: a branch can carry several compute endpoints — a read-write endpoint plus read-only replicas — and those replicas share the branch's storage, so they are several ADDRESSES for one database. Counting endpoints instead of databases would let one database read as several capacity slots and pass this gate with a single database to restore into. Schema version 13 counts databases; the checker refuses an artifact captured under an earlier version rather than reading its count as capacity.

**The cutover's topology (Tom's execution decision, 2026-11-19).** The destination is the EXISTING production Neon database — its `tasks_api` and `content_scheduler` schemas — and no new permanent production database is created for this cutover. The recovery target is a TEMPORARY, isolated database that exists only to prove a verified backup restores into a usable state. The earlier gate demanded three distinct PRODUCTION databases (source, destination, recovery) and that requirement is obsolete: it asked the operator to create permanent production databases the migration is explicitly forbidden from creating. One existing database is now the whole requirement, and the gate says so.

**The recovery target's isolation is a code invariant, not a runbook sentence.** The drill reads the host out of each recovery DSN file (without loading the credential into the environment) and refuses the run when the recovery target shares a host with the source — which would overwrite the rollback source — or with the destination — which would reconcile the destination against itself. The workflow requires a declared `recovery_host` that differs from the source and destination hosts, and adds it to the endpoint allowlist, so a recovery target can never be an endpoint the operator did not name.

**The restore is per schema, because production gives each schema its own service role.** The archive carries both `tasks_api` and `content_scheduler`, and the production profile gives each schema a distinct write-capable login role (`sindustries_tasks_api` / `sindustries_content_scheduler`). Restoring that one archive through a single destination DSN hands BOTH schemas to whichever role that DSN connects as: `content_scheduler` comes back owned by the tasks role, the content-scheduler role holds USAGE=false and CREATE=false on its OWN schema, and the tasks role holds the cross-schema access that the connectivity control above exists to forbid. The restore SUCCEEDED. The failure surfaced one step later, at `prisma migrate deploy` for the content-scheduler, as `permission denied for schema content_scheduler` — after the live schema had already been dropped and recreated with the wrong owner.

So `restore.sh` restores per schema: each role creates its own schema (`CREATE SCHEMA <name>;` run AS that role, so it needs no SET ROLE authority and no privileged operator role) and restores its own objects through its own DSN. `pg_restore --schema=<name>` restores the objects INSIDE a schema and does not create the schema itself, which is why the role creates it first.

**The resulting ownership is asserted, not assumed.** The defect was silent: the restore reported success and the drill moved on. The restore now proves, at the one point that can see it, that each schema is owned by the role that restored it (the server's `current_user` against `pg_get_userbyid(nspowner)`), that each role can USE its own schema, and — when the two roles differ — that neither role holds USAGE on the other's schema. Two destination DSNs that connect as the SAME role are refused outright in a production run: that arrangement is the shape of the defect, and it would satisfy every ownership assertion, because each schema's owner would equal the role that connected. Staging genuinely uses one role and records `singleRoleDestination: true` in the restore envelope instead. The content-scheduler destination DSN is REQUIRED, so the defect cannot be reintroduced by omitting a flag.

**The isolation assertion also runs BEFORE the first destructive statement.** The assertion above runs after `pg_restore`, so a destination whose ROLE MODEL cannot confine one service role to its own schema was discovered only once the live schemas had already been dropped and recreated — the drill aborts with the data moved, the migrations not applied, and the service role unable to use its own schema. That access is a property of the ROLES, not of the data: a role that is a member of a role carrying `pg_read_all_data` or `pg_write_all_data` holds USAGE, and read and write, on every schema in the database, and NO explicit GRANT can withdraw it. So it is knowable before anything is written, and the same assertion now runs in `cleanup-destination.sh` immediately before the first `DROP SCHEMA`, and in `restore.sh` before the first `CREATE SCHEMA`. A mis-provisioned destination therefore refuses with both schemas still in place instead of being dropped and then failing downstream.

The predicate is `has_schema_privilege(current_user, <other schema>, 'USAGE')` and it is deliberately NOT the schemas' explicit ACL list (`aclexplode(nspacl)`). The two are not interchangeable: measured against a reproduction of the production role model, the explicit ACL for `content_scheduler` named only its own owner role — so an explicit-ACL-only check read CLEAN — while the same role read and wrote the other schema's rows. Narrowing the check to explicit ACLs would report a green light on a live cross-schema write and would silently disagree with the platform's own `neon.service-role-scope` gate, which asks the same question. One implementation of the predicate is shared by the preflight and the end-state assertion (`cloud_db_assert_cross_schema_isolation` in `scripts/cloud/database/common.sh`) so the two cannot drift apart.

**The cross-schema access between the two production service roles is ACCEPTED, and the acceptance is declared in three places that must agree.** Per-schema confinement is not enforceable in the production Neon role model: both service roles are DIRECT members of `neon_superuser`, which carries `pg_read_all_data` and `pg_write_all_data`, so each holds USAGE — and read and write — on every schema, and no explicit GRANT can withdraw it, because no explicit grant was the source. Tom accepted that shared access on 2026-11-23 07:25 NZDT (recorded by Quinn, task `f2c23e26`, option (b)) rather than revoke the membership, which would be a wider change to the production role model than the decision authorises.

1. `databaseServiceRoleSharedAccess` in `infra/cloud/platform/platform-environments.mjs` declares the accepted pair, the reason and the decision reference. It is the single source of truth for WHICH pair the acceptance covers.
2. The `neon.service-role-scope` proof carries an `acceptedSharedAccess` block, and `tests/cloud/scripts/check-production-provisioning-state.mjs` refuses when the recorded evidence and the declared topology name different pairs. An accepted deviation that is not named on both sides is drift.
3. The harness applies the acceptance only for a production run, only when the declared pair is EXACTLY the two roles the run connects as, only when a non-empty reason is recorded, and it reports the acceptance in the log and in the run envelope. Every other pairing still refuses.

**The destructive DDL runs as the schema OWNER, not as the service roles.** The production schemas are owned by the database owner role (`neondb_owner`), so `DROP SCHEMA ... CASCADE` and `CREATE SCHEMA` are owner-only statements: as a service role the cleanup fails closed with "must be owner of schema", and as a service role the restore would make that role the schema's owner — a topology change the accepted shared-access decision did not authorise. `cleanup-destination.sh` and `restore.sh` therefore take an optional owner connection (`--dest-owner-dsn-file` / `--destination-owner-dsn-file`); the owner creates the schemas and grants the service role USAGE, CREATE on its own schema for the data load, and the post-restore ownership assertion expects the owner role. Without the owner connection the scripts behave exactly as before, which is what the staging topology (one role owning both schemas) needs.

| Gate | Met when | Owner of an unmet gate |
|---|---|---|
| `github.production-environment-captured` | the `production` Environment could be read at all | Quinn (operator) |
| `github.cutover-dsn-secrets` | all six cutover DSN secrets are registered on the Environment | Quinn (operator) |
| `github.production-approval-gate` | the Environment has at least one required reviewer and admins cannot bypass the gate | Quinn (operator) |
| `neon.cutover-destination-database` | the production Neon environment serves at least one distinct database — the EXISTING production database that is the destination — counted as databases, not as endpoint hosts, because a read replica is another address for the same database | Quinn (operator) |

The gate names are bound to the workflow: `tests/cloud/tests/check-production-cutover-readiness.test.mjs` asserts the checker's secret list and the workflow's `secrets.*` reads are the same set, so the checker cannot drift away from the workflow it gates. The sentinel cases prove each gate can go red — a gate that cannot fail asserts nothing.

The operator procedure is in [`docs/runbooks/production-data-migration-restore.md`](../runbooks/production-data-migration-restore.md) §3.

---

## Production route cutover (task `020f423e`)

The data cutover above moves the DATA. The route cutover moves the ROUTE: which origin each in-scope surface is bound to. They are separate tasks because they are separate failures — data that landed in the wrong place and traffic that reached the wrong place need different recoveries.

**What the route is.** This deployment has no weighted load balancer between two live origins: the stable hostnames CNAME at the cloud platform, and the callers resolve their base URL from the environment they run in. So the route adapter is not a traffic splitter — it is the guarded control plane that owns which origin each surface is bound to, driven through a fixed phase order (`prodlike` → `canary` → `partial` → `majority` → `cloud_active` → `observing` → `acceptance_pending`). The approved tech design anticipated this case explicitly: if the provider cannot do weighted traffic, the adapter must support an atomic, health-checked origin switch at the stable front-door; DNS TTL alone does not satisfy the interface. The binding switch is atomic per run, health-checked before and after, and reversible — which is the property the design was actually protecting.

**Ownership boundary.** The route state is an infra/workflow-boundary artefact, not a product service. `infra/cloud/cutover/` owns the declarative manifest and the adapter; `scripts/cloud/cutover/` owns the guarded preflight, switch, observe and rollback orchestration. The adapter holds no credentials and makes no provider calls: it exists to make a mistake impossible to make silently.

**Why compare-and-set.** A cutover window has more than one pair of hands in it. Two operators, or an operator and a retry, must not silently overwrite each other's route change. Every write carries the route version the operator believed was live and is refused when the live version has moved. The manifest is likewise validated fail-closed: a manifest carrying a credential-shaped substring, an unset observation duration, a non-monotonic phase order, or no declared rollback surface is refused rather than used.

**Rollback modes.** (1) *Runtime rollback* — the normal case: route traffic back to the warm prodlike services, which keep using the canonical cloud PostgreSQL/Redis, so there is no data divergence. (2) *Cloud data-layer incident* — never point prodlike at the stale pre-cutover database after production writes; quiesce writes, restore from the accepted backup/PITR, reconcile, and route only after a second go/no-go. (3) *Pre-write abort* — the frozen pre-cutover database is usable only once the write ledger proves no cloud-only writes occurred. No dual-write or multi-primary layer is introduced.

**Prodlike is retained.** Decommissioning is not part of this task. It stays warm and healthy through the observation period and remains the tested rollback surface until Tom explicitly accepts; a successful switch is not a reason to remove it. The harness's final phase is `acceptance_pending` and it stops there — the script never accepts on Tom's behalf and never retires the fallback.

**The preflight names a missing credential, and refuses a substituted one.** The hosted-signals probe reads the active alert count from the hosted Grafana stack and fails closed without a credential, so the window already stops — but it stopped inside the health gate, where the result reads "the probes do not report production healthy" and sends the operator to the service instead of to the environment, when the actual defect is a credential nobody provisioned. The preflight now carries a `hosted-observability-credential` gate that names the missing endpoint or credential directly, and that refuses the window when the hosted-observability credential is byte-identical to `GRAFANA_CLOUD_PROVISIONING_AUTH`: the provisioning token can write dashboards and delete alert rules, so it must never observe production and never reach the window's evidence. The read-scoped token is a separate service account from the provisioning one, and it is not in `infra/cloud/observability/.env.local` — that file carries the provisioning token only.

**The route has two classes of caller, and the read-back only sees one.** The adapter's managed caller inventory is the runtime configuration — the `.env` keys it writes and the read-back reads back. AC2 names more than that: "agent workflows, cron/automation callers, deployment configuration and operator-facing docs", and those callers live in the repository. A repository-owned caller follows the live route by RESOLVING the route variable, never by pinning an origin, and because the manifest does not name them the adapter's read-back cannot see them. `tests/cloud/scripts/check-agent-caller-routes.mjs` is therefore a hard gate on the repository side: it fails closed when a cron prompt, a heartbeat prompt or a skill assigns a prodlike origin to the route variable, targets one in a `curl` or an HTTP client call, or pairs one with a request method. The origin is allowed as the default of a route variable, because a local-dev fallback is not a route. AC2's proof is two halves — the read-back proves the runtime configuration moved, and this gate proves the repository-owned callers will follow it — and neither half is sufficient alone.

**A health check must not impose a content type the surface does not serve.** The preflight health-checks every in-scope surface on BOTH bindings, and the operator-facing frontends declare their document root (`/`) as their health path because they are single-page applications rather than services with a `/health` endpoint. The probe sent `Accept: application/json` on every request, so the prodlike frontends — Vite dev servers whose history fallback only serves index.html to a request that accepts HTML — answered 404 from a surface that was serving perfectly well, and the `health:prodlike` gate read the rollback fallback as unhealthy and refused the window. The production frontends hid the defect: the hosting platform serves index.html for `/` whatever the Accept header says, so the same probe passed against production and failed against the binding the rollback depends on. The negotiation now follows the surface kind, which is already part of the manifest contract: an `api` surface keeps asking for JSON, a `frontend` surface is asked for the document it serves. The manifest schema is unchanged, so an operator's prepared manifest needs no edit.

**Operational surfaces.**

| Surface | Path |
|---|---|
| Operator runbook | [`docs/runbooks/production-cloud-cutover.md`](../runbooks/production-cloud-cutover.md) |
| Execution record template | [`docs/infra/production-cloud-cutover-record-template.md`](../infra/production-cloud-cutover-record-template.md) |
| Tech design | `docs/specs/production-cloud-cutover-rollback-tech-design.md` |
| Route adapter | `infra/cloud/cutover/traffic-route.mjs` (CLI: `infra/cloud/bin/traffic-route`) |
| Harness | `scripts/cloud/cutover/` — `preflight.sh`, `execute.sh`, `observe.sh`, `rehearse.sh`, `rollback.sh`, `verify-local-recovery.sh` |
| Continuous probes | `tests/cloud/production-cutover-probes.mjs` |
| Repository caller gate | `tests/cloud/scripts/check-agent-caller-routes.mjs` (AC2's second half — the repository-owned callers the adapter's read-back cannot see) |
| Dispatch workflow | `.github/workflows/production-cloud-cutover.yml` (`workflow_dispatch` only, `production` Environment, concurrency group `production-cutover`) |

---

## Production approval credential set (task `3c004590`)

The platform app registers two approval-credential secrets on Fly:
`TASKS_API_APPROVAL_SERVICE_CREDENTIALS` and
`CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS`. Each holds a JSON
array of `{token, actor, approvalTypes}` entries, and each entry is one
actor the named service accepts writes as.

**The provisioner MERGES that array; it never replaces it.** The
platform deploy workflow runs when the `platform` surface changes on a
merge to `main`, and the provisioner used to write a ONE-entry array
holding only the platform's own `production-cloud-validate` actor.
`flyctl secrets set` replaces the live secret outright, so every routine
merge reset the credential set to a single actor and every agent write
on production then failed with `401 AUTH_REQUIRED`. Reads kept working
(they are unauthenticated by design), so the break was invisible until
an agent tried to write.

**The deploy is called from CI.** `ci.yml` calls
`deploy-production-platform.yml` from its `deploy-platform-production`
job. That job runs only on a push to `main`, only when the `platform`
surface changed, and only after the staging platform deploy succeeded
and the merge gate was green. The workflow itself is `workflow_call` only,
so before this caller existed the production platform was never
deployed by a merge at all (GitHub reported zero runs for it) and the
merged credential set was never applied. The caller's existence and its
gates are checked by
`tests/cloud/scripts/check-production-deploy-contract.mjs`, so removing
the caller fails the merge gate instead of silently stopping
production deploys.

**The deploy fails closed, loudly.** When the operator credential arrays
are absent from the protected `production` Environment the provisioner
refuses to touch Fly and the run fails BEFORE any `flyctl secrets set`,
naming the source that is missing. The live secrets are untouched and
the services keep serving with whatever was registered last.

### Who owns what

| Fact | Owner | Where |
| --- | --- | --- |
| The actor set, and each actor's allowed `approvalTypes` | the repository | `infra/cloud/platform/platform-environments.mjs`, `approvalCredentials` |
| The token VALUES | Quinn (operator) | the protected `production` GitHub Environment |
| The merge, the validation and the Fly write | the repository | `infra/cloud/platform/platform-provision-secrets.mjs` |
| The runtime proof that each credential still authenticates | the repository | `infra/cloud/platform/verify-platform-approval-credentials.mjs` |

There is no second actor list. `buildServiceCredentials` used to hard-code
the single-actor shape, and `platform-environments.mjs` hard-coded the
actors per environment; both now read the one `approvalCredentials`
contract, so a new actor is registered by changing that contract and the
operator array together, and nothing else.

The actor sets are deliberately SERVICE-SPECIFIC. The Tasks API carries
the nine agent and service actors that write to it; the Content Scheduler
carries only `Ivy` and `tasks_app_browser`, the callers that actually
write there. Registering the Tasks actor set on the Content Scheduler
would widen production write access to callers that never write there.

### The production Environment secrets

| Environment secret | Carries |
| --- | --- |
| `PRODUCTION_TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN` | the `production-cloud-validate` platform token |
| `PRODUCTION_TASKS_API_OPERATOR_APPROVAL_SERVICE_CREDENTIALS` | the COMPLETE Tasks operator array (`[{token, actor, approvalTypes}]`) |
| `PRODUCTION_CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN` | the `production-cloud-validate` platform token |
| `PRODUCTION_CONTENT_SCHEDULER_API_OPERATOR_APPROVAL_SERVICE_CREDENTIALS` | the COMPLETE Content Scheduler operator array |

The operator arrays are the authoritative registration: a credential
registered by hand in the live Fly secret is drift, and the next deploy
replaces it. **A live credential is never registered by hand.**

### Adding or removing an actor

1. Change the actor set in `infra/cloud/platform/platform-environments.mjs` —
   the service's `operatorActors` list, with each actor's exact
   `approvalTypes`.
2. Update the matching operator array in the protected GitHub Environment
   in the SAME change. The array must carry precisely the declared
   actors, with precisely the declared approval types, and one distinct
   token per actor.
3. Run the local suites: `node --test infra/cloud/platform/tests/` and
   `node --test tests/cloud/tests/`.
4. Merge. The production workflow fails BEFORE any Fly write if the
   Environment array does not match the contract — a missing actor, an
   unknown actor, a widened `approvalTypes`, a shared token, a
   malformed array or an empty array all stop the deploy, and the live
   secrets are left untouched.
5. The post-deploy verifier then presents every merged credential to its
   own service and requires the service to report the intended actor.

Direct `flyctl secrets set` edits are unsupported: the next deploy
replaces them.

### When an agent write starts returning `401 AUTH_REQUIRED`

1. Read the latest `production` platform workflow run. A red run names
   the exact source that is missing, malformed or mismatched.
2. Compare the manifest's `approvalCredentials` actor set against the
   operator array in the GitHub Environment. **Never print the array or
   a token** — compare actor names and counts only.
3. Run the verifier through the protected workflow rather than by hand:
   `node infra/cloud/platform/verify-platform-approval-credentials.mjs --environment production`.
   It reports actor names and service names only, and never prints a token.
4. If one actor's token is wrong or revoked, rotate ONLY that actor's
   entry in the Environment array. Do not change actor membership or
   permissions unless the manifest changes in the same reviewed delivery.
5. Never paste a token into a task comment, a PR, a log or a chat.


## Credential boundary

The `.openclaw` boundary Quinn confirmed on the PR #508 review (merged `d6ee2d8`):

- **Quinn owns** the live values: `FLY_API_TOKEN`, Neon `DATABASE_URL` / `DIRECT_URL`, Fly-managed Upstash `REDIS_URL` / `CONTENT_SCHEDULER_REDIS_URL`, DNS provider token. These never enter the repo.
- **Quinn registers** `FLY_API_TOKEN` through GitHub's masked secret UI under the `staging` and `production` environments as applicable. Workflow YAML references `secrets.FLY_API_TOKEN` by name and performs a fail-fast presence check before installing or invoking Fly tooling.
- **Rowan ships** only env-var names, Fly app specs, Dockerfiles, and deploy workflows. The workflow templates include `FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}` so the deploy job picks up Quinn's value at job time.
- **Quinn runs** `infra/cloud/scripts/bootstrap-staging.sh` once. It reads `infra/cloud/.env.local` (gitignored), translates Quinn's per-service prefixed values into the source names the platform provisioner reads, and hands them to `infra/cloud/platform/platform-provision-secrets.mjs`, which registers the app-level `PLATFORM_*` secrets. The provisioner is the single implementation of that mapping, so the local bootstrap and the CI provisioning path cannot register different secrets on the same app.
- **Quinn rotates** any secret out-of-band. Rotation procedure for tokens with downstream ciphertext rows (e.g. Akahu) was previously `docs/runbooks/rotate-akahu-access-tokens.md` (retired in PR #583 and never regenerated; the procedure steps should be written as a new runbook in the workspace repo's `infra/runbooks/`, with a row in that repo's `infra/RUNBOOKS.md`, if Quinn needs to rotate Akahu tokens); no rotation procedure is needed for non-derived secrets.

A new operator joining Quinn's seat gets the same out-of-band onboarding path: 1Password (or equivalent) handoff for `FLY_API_TOKEN` + Neon + DNS and the Fly-generated Redis connection URLs, plus the `infra/cloud/.env.local` template.

If a Fly deployment reports that `FLY_API_TOKEN` is unavailable, repair it only through **GitHub → Settings → Environments → staging/production → Environment secrets**. Never paste the value into an issue, task, PR, workflow-dispatch input, command argument, URL, or chat. Re-run the failed gated deployment after the masked value is restored.

---

## Deploy procedure (reference)

`.github/workflows/ci.yml` is the deployment orchestrator. It detects changed deployable surfaces, runs CI, and emits one stable `CI / merge gate` result. The active `main` ruleset requires that result. Automated deploys are downstream of that gate; the production frontend workflow additionally exposes an operator-only manual dispatch.

- Mission Control and the Tasks app share the manually dispatchable, reusable `deploy-production-vercel-frontends.yml` workflow. A dispatch selects one surface, preserving independent project concurrency and rollback boundaries.
- The workflow resolves the Vercel project, app path, workspace name and custom domain from `hostname-matrix.json` plus `vercel-env-matrix.json` through `vercel-project-facts.mjs`; those values are never duplicated in workflow YAML.
- `PRODUCTION_VERCEL_DEPLOY_ENABLED=true` in the production GitHub environment is the explicit deploy gate. A matrix row with `provisioned: false`, a missing credential, or a closed gate fails or skips before a Vercel mutation.
- The workflow installs from the repository root lockfile, tests and builds the selected workspace, then links the selected project with an explicit team scope. It deploys a production-target candidate with `--skip-domain`, smoke-checks that candidate, and promotes that exact deployment.
- The Vercel CLI runs at the repository root, not inside the app path. It resolves the app directory as `join(repoRoot, project.rootDirectory)`, and the production projects set `rootDirectory` to the app path, so a CLI run from inside that path resolves a directory that does not exist and the build dies with `spawn sh ENOENT` (observed on run `44210902125`).
- After promotion it verifies the stable hostname over HTTPS, checks the certificate hostname, and inspects the emitted JavaScript bundle. Every production VITE_* value must be present and no staging hostname may appear.
- `check-production-vercel-deploy-contract.mjs` protects this sequence in the merge gate. `verify-live-vercel-bundle.mjs` is both the deployment-time AC4 check and an offline-tested verifier.

- Pull-request website staging starts only after the merge gate succeeds.
- A website change on `main` deploys a production-configured candidate to staging, smoke-checks that exact deployment URL, then promotes the same deployment to production.
- The website deploy workflow resolves **one** Vercel target at job scope (`VERCEL_TARGET`, derived from the `production-candidate` input), and the `vercel pull`, `vercel build`, and `vercel deploy --prebuilt` phases all consume it. Vercel refuses to publish prebuilt output whose recorded target differs from the deploy target, so a single shared value is what keeps the staging candidate publishable. A production-configured candidate is deployed with `--skip-domain`, so it stays off the production custom domains until it is explicitly promoted. The static check `tests/cloud/scripts/check-vercel-deploy-target.mjs` enforces the contract on every CI run.
- The production promotion resolves the candidate in the Vercel team that created it, from one explicit source: the job-scope `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` repository secrets. The staging job writes the project link with `vercel pull`, but the production job runs on a clean runner with no link, so an unscoped CLI request carries no team context and Vercel refuses the promotion with `Deployment belongs to a different team` (main run `42239656677`, job `127968156801`). The production path now links the project (`vercel link --project "$VERCEL_PROJECT_ID" --scope "$VERCEL_ORG_ID"`) and every mutating call — `vercel promote` and `vercel alias set` — carries `--scope "$VERCEL_ORG_ID"`. The static check `tests/cloud/scripts/check-vercel-production-promotion-scope.mjs` enforces the contract on every CI run.
- Fly staging services, GymTrack, GymTrack MCP, and the budget-mobile EAS update start only from a successful `main` merge gate when their central changed-path filter matches.
- The `production` GitHub environment accepts protected-branch deployments only. Staging remains available to pull-request branches.
- Staging cancels superseded runs for the same target/ref. Production serializes runs and never cancels an in-progress deployment.

### Vercel credential topology

`VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` and `VERCEL_TOKEN` are **repository-level** secrets. The website deploy uses all three. The production frontend workflow uses only `VERCEL_ORG_ID` and `VERCEL_TOKEN`: its project name is non-secret repo-owned contract data resolved from the Vercel env matrix. The production GitHub environment supplies the deployment gate and environment protection; selecting that environment does not itself select a Vercel team or project.

That makes the team scope something each workflow has to state, not something it can infer: the token's own default scope is the personal account that owns the team, not the team itself, and an unscoped request resolves the deployment under that default. Three consequences for anyone touching these jobs:

- A job that must act on a deployment created by another job needs the project context and the team scope explicitly (`vercel link --project "$VERCEL_PROJECT_ID" --scope "$VERCEL_ORG_ID"`, or `--scope "$VERCEL_ORG_ID"` on the mutating call itself). The production promotion job is the case in point.
- A frontend production job binds by the matrix-owned project name and carries `--scope "$VERCEL_TEAM_SCOPE" --token="$VERCEL_TOKEN"` on every Vercel link, pull, build, deploy and promote call. Never replace either value with a literal. `VERCEL_TEAM_SCOPE` is the `VERCEL_ORG_ID` repository secret under a name the CLI does not reserve, because the CLI treats `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` as a paired contract: `getLinkedProject` refuses to resolve a project when only one of them is exported (`You specified VERCEL_ORG_ID but you forgot to specify VERCEL_PROJECT_ID`, observed on run `44209522804`) and then ignores the `.vercel/project.json` link that `vercel link` had already written. A job that binds by project name therefore exports neither reserved name and lets the link file carry the resolved org and project ids.
- The scope must stay bound to the job-scope secret. A literal team id or slug in a workflow is a second source of truth, and it is the one that drifts when the team changes.

Fly reusable workflows run a credential preflight, install a commit-pinned setup action and version-pinned `flyctl`, run `flyctl deploy --strategy canary`, then smoke-check. The reusable workflow set is per ENVIRONMENT and per app, not per service: staging has `deploy-staging-platform.yml` for the consolidated app and `deploy-staging-health-probe.yml` for the probe's own app, and production has the matching `deploy-production-platform.yml` and `deploy-production-health-probe.yml`. The four per-service staging deploy workflows (`deploy-staging-<service>.yml`) were retired at the 2026-11-07 cutover, are `workflow_call`-only with no caller, and no per-service staging Fly app remains to deploy.

- **HTTP services** — one app serves all three API surfaces, so the health routes are reached through the router rather than through one hostname per service. Staging curls the provider hostname's path-prefix routes (`$PROVIDER_URL/<surface>/health`, 10 attempts, 5s apart) and reports the stable hostnames separately; production curls each production API hostname's own `/health`. Fly's health check on the consolidated app is a single `[[http_service.checks]]` entry against `/__status` — the supervisor's status endpoint, which answers 503 while any child is not running — every 15 seconds. There is no per-service check block any more.
- **Worker** — the auto-post worker is a supervisor child of the same Machine, not a Fly app of its own, so it has no hostname and no health route. Its evidence is a startup line in the platform app's logs: `flyctl logs --app <platform-app> --no-tail`, grepped for `[content-scheduler-worker] starting`, polled every 5s within a 60s deadline. A clean boot line means Prisma connected and the BullMQ worker registered. The platform app's single `[[http_service.checks]]` entry covers the whole Machine, so there is nothing to monitor for the worker separately.

If the smoke check fails, the deploy job exits non-zero. Quinn/Lox investigates via `flyctl logs --app <platform-app>` and either forward-fixes or rolls back per the rollback procedure in `docs/runbooks/platform-consolidation-rollback.md` §4 "Backout" — the live staging rollback runbook, which records the app-wide `fly releases rollback --app sindustries-platform-staging` backout; in production the same app-wide command runs against `sindustries-platform-production` (the prior `docs/runbooks/cloud-deployment-rollback.md` was retired in PR #583, and the design-time doc's "Rollback" section now defers to the same runbook).

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
| `.github/workflows/cloud-staging-validate.yml` | `sindustries-platform-staging` | Its "wake the content-scheduler machines" step targets the platform app (the Machine that can be cold), not the destroyed per-service app. Its preflight validates each staging target variable against its OWN surface's (host, path-prefix) routes from `infra/cloud/hostname-matrix.json` (`stagingRoutes`), so a variable still pointing at a destroyed app — or at a DIFFERENT surface — fails as a configuration error instead of a harness timeout. The routes are per target, not one shared allow-list: every service exposes `/health`, so a host-only allow-list let `STAGING_TASKS_API_URL` point at the budget-api hostname, probe the wrong service and report `tasks.health: pass`. The check never resolves DNS: it validates each configured target against the matrix's own (host, path-prefix) routes rather than resolving the hostname, so a stable hostname that does not resolve yet cannot fail this preflight. The stable staging hostnames do resolve now — see the public-internet runner result above. |

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
- [`docs/runbooks/platform-consolidation-rollback.md`](../runbooks/platform-consolidation-rollback.md) — the live staging rollback runbook (`fly releases rollback --app sindustries-platform-staging`; in production the same app-wide command runs against `sindustries-platform-production`); the prior `docs/runbooks/cloud-deployment-rollback.md` was retired in PR #583 and was never regenerated outside this repository.
- Akahu token rotation (tokens with downstream ciphertext rows) — **no runbook exists**; `docs/runbooks/rotate-akahu-access-tokens.md` was retired in PR #583 and was never regenerated in the workspace repo's `infra/runbooks/`, so Quinn writes it there — with a row in that repo's `infra/RUNBOOKS.md` — before rotating an Akahu token. No rotation procedure is needed for non-derived secrets.

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
| Installer | `infra/cloud/scripts/install-gitleaks.sh` — the merge-gate job, scheduled history workflow and local runs all install the same version/checksum pin |
| Entrypoint | `infra/cloud/scripts/run-secret-scan.sh` — the CI job, scheduled history workflow, contract test and local pre-commit hook all call it |
| Scope | the change (`base.sha..HEAD` / `before..sha`) plus the complete tracked tree at HEAD; published history runs on a weekly schedule as an alert |
| Failure modes | secrets found, missing binary (exit 2), missing config (exit 3), empty commit or tracked-tree scope (exit 4) — every one of them blocking |

The install is pinned and checksummed, and it is deliberately not a single point of failure. The GitHub release-asset CDN intermittently answers `504` for this asset — reproduced locally for that asset while another asset from the same release downloaded cleanly — so the job caches the verified archive between runs and falls back to the API's asset endpoint (a different CDN route to the same bytes) when the release URL fails. The SHA256 check runs on every path, including the cache hit, so the fallback cannot weaken the guarantee: a truncated, tampered or substituted download fails the job either way. A required merge-gate input must not be able to block a merge for a reason unrelated to the code being merged.

The merge-gate scope is the change **and** the tracked tree (`run-secret-scan.sh --tree`). A history-wide scan on every run would be wasteful and would make a history-only finding block a merge that does not contain it, so the full published history runs in `.github/workflows/secret-scan-history.yml` on a weekly schedule and on manual dispatch. That workflow fetches every published ref, uses the same pinned installer and shared entrypoint, publishes a metadata-only artifact, and fails visibly when a finding exists; it is an alerting surface, not a merge-gate input.

The tree scan joined the gate only after the repository-wide triage established a clean baseline (task `46211c26`). The individually triaged published-ref findings, the individually triaged tracked-tree findings and their remediation state are recorded in `docs/runbooks/secret-scan-triage.md`; the runbook also carries the local triage and history-rewrite procedure. The baseline scan names the resolved scope and finding count, so a green cannot mean "scanned nothing".

**There is no global path allowlist.** The global `[allowlist]` table suppresses no file path at all — it holds only value-shape rules (an empty-assignment regex and placeholder stopwords) — so every tracked file is scanned by every rule and the merge gate's claim that a secret committed into any tracked file fails the required job holds literally. Two subtree-shaped global path entries (`tests/.*/fixtures/.*` and `services/.*/test/.*\.test\.[jt]sx?$`) were suppressing live tracked-tree findings and were removed; the four findings they hid are now triaged as tracked-tree rows in the runbook. The remaining exceptions are rule-scoped and name either an exact commit or an exact anchored value shape together with an exact path. The contract test rejects a global path allowlist outright and rejects a rule-scoped allowlist whose value scope is unanchored.

`git archive` honours the `export-ignore` attribute, so a tracked file marked with it is deliberately absent from the export. The tree scope counts the archive's own entries rather than the tracked blob count, and accounts for every excluded path explicitly: an intentional `export-ignore` exclusion is named in a warning, while a tracked file missing for any other reason fails the scan closed. A submodule entry is a gitlink rather than a tracked file and is not counted against the export.

Two properties make a green meaningful:

- **The entrypoint never reports success for an empty scope.** A range that resolves to zero commits is exit 4 with an `::error::` annotation, so a green can never again mean "scanned nothing".
- **Every setup failure is visible and blocking.** A missing binary or config exits non-zero with an `::error::` annotation; there is no `|| true`, no `continue-on-error` and no `set +e` around the scan.

That the gate is real is scripted rather than asserted. `infra/cloud/scripts/secret-scan-negative-control.sh` publishes a synthetic canary token — detected by the test-only rule `sindustries-secret-scan-canary`, which only ever adds detections and never suppresses one — on a throwaway branch, opens a pull request so the `pull_request` trigger runs, and asserts that both the `gitleaks secret scan` job and the `merge gate` job conclude `failure`. The canary is synthetic and carries no credential; the branch and the pull request are deleted when the control finishes. The always-on half of the same proof is the contract test `infra/cloud/scripts/tests/secret-scan-enforcement.test.sh`, which runs inside the `gitleaks` job itself.

#### The config itself was inert until task `2b3962b1`

Turning the gate on exposed two defects in `.gitleaks.toml` that had been masked by the gate never running at all. Both are fixed in the same change, because a green gate over a scan that detects nothing is not enforcement:

- **`[extend]` never loaded the default ruleset.** `useDefault` has defaulted to **false** since gitleaks v8.19, and the `[extend]` table set no keys, so the config shipped with *no* rules at all. The comment above the table claimed the bundled ruleset was in use. With the default ruleset loaded, the scan detects the secrets it claims to detect — for example a `API_KEY=sk_live_…` line, which the previous config did not flag at all.
- **A rule's pattern is read from `regex` (singular); the plural `regexes` form is ignored.** The two per-rule overrides that aimed at empty `.env.example` placeholders therefore carried a path and no pattern, and one of them shadowed the built-in `generic-api-key` rule for the whole repository. They have been removed — the empty-assignment regex in the global allowlist covers the shape they were written for, so removing them restores the bundled rules at full strength instead of narrowing them. (An allowlist does legitimately use the plural `regexes` form; only a *rule* does not.)

The corrected config was measured against the tracked tree at `main` before it was enabled: **zero** findings across all tracked files, so switching the default ruleset on did not retroactively redden the repository. The findings it surfaced in gitignored local development files (`.vercel/`, `*.env.local`, `*.env.prodlike`) are local machine state, not repository history. The later repository-wide triage (task `46211c26`) measured both the published history and the tracked tree, triaged each published-ref finding individually, and established the clean baseline required before the tree scan joined the gate. The contract test now guards the default ruleset, the canary rule, the shared entrypoint, the narrow allowlist, the new scopes, and the ledger so the config or its enforcement cannot silently go inert again.

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

## Database transfer harness (task `d37681e1`, extended by `f2c23e26`)

The database transfer harness lives in `scripts/cloud/database/` and is the single implementation of the transfer procedure for both environments. There is no separate "production script set": one harness, two environment profiles, resolved by `cloud_db_set_environment` in `scripts/cloud/database/common.sh`.

The stages are `inventory.sh` → `assert-source-schema-matches-model.sh` → `dump.sh` → `restore.sh` → `migrate.sh` → `reconcile.mjs`, orchestrated by `drill.sh`, which seals each run's evidence into `manifest.sh` (`manifest-<run-id>.json`: the digest of every artefact plus the rolled-up verdict).

`assert-source-schema-matches-model.sh` is a read-only gate that runs BEFORE the destructive destination cleanup. The restore copies the source schema wholesale — every table, every row — so a source table that the repository's `schema.prisma` does not model would land in the destination as permanent drift that no later `prisma migrate` run reconciles or prunes, and it would land after `cleanup_destination` had already dropped the live schemas. The gate compares the source schema's table inventory (per schema, over the connection that owns it) against the model list read from the service's own `prisma/schema.prisma`, and refuses on either direction: an unmodelled table in the source, or a modelled table the source lacks. The refusal names each table and its row count, so the operator sees the data that would have been carried. On the live prodlike source (read-only, 2026-11-23) the `tasks_api` schema carries `ContentSchedulerItem` (29 rows, orphaned in that schema by the schema split) and `Task_blocked_ready_backup` (48 rows, left behind by the rolled-back `add_blocked_ready_columns` migration); neither is modelled by `services/tasks-api/prisma/schema.prisma`, so the gate refuses that source before anything is destroyed.

| | `staging` profile | `production` profile |
|---|---|---|
| Endpoint identification | refused if the DSN carries a production marker | **required** allowlist of `host[:port]` (`--expected-host` / `CLOUD_DB_EXPECTED_HOSTS`) |
| Second key | not required | `CLOUD_DB_PRODUCTION_ACK=1` in the environment |
| Database-name rule | must carry `sindustries_staging_` | must NOT carry the staging prefix |
| Artefact directory / envelope kind | `artifacts/cloud-staging` / `cloud-staging-*` | `artifacts/cloud-production` / `cloud-production-*` |

**Why the production profile identifies its target by endpoint, not by name.** The production Neon branch database is named `neondb` — the same name staging uses — so a database-name prefix cannot distinguish them. A production run therefore has to declare the exact endpoints it may touch, and the scripts refuse any endpoint outside that list. The staging profile keeps its deny-list behaviour unchanged: a staging run refuses any DSN carrying a production marker.

**Three keys guard a production move.** The `production` GitHub Environment (approval gate), the typed confirmation `MIGRATE PRODUCTION` (which is what sets `CLOUD_DB_PRODUCTION_ACK=1`), and the declared endpoints. No single key can start a move. The operator surface is `.github/workflows/cloud-production-db-cutover.yml` (`workflow_dispatch` only); the procedure and its failure/retry rules are in `docs/runbooks/production-data-migration-restore.md`.

**Invariants that hold in every environment.** Nothing in the harness ever writes to the source; the destination is rebuilt from the archive on every attempt, so a retry cannot double-write rows; a restore refuses a destination that is not empty; every attempt carries a fresh run id, and the run id is part of every artefact name and of the manifest.
