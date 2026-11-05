---
status: draft
task_id: 219fb673-72d9-4d6c-a820-f31481316b37
product_spec: brain/tasks/specs/open/fly-staging-service-consolidation-2026-11-05.md
shipped_pr: null
shipped_date: null
---

# Fly Staging Service Consolidation — tech design

## Product intent (from the brain spec)

The product spec (`brain/tasks/specs/open/fly-staging-service-consolidation-2026-11-05.md`,
approved by Tom) asks for exactly one thing:

> tasks-api, budget-api, auto-post-worker, and content-scheduler-api run as independent
> processes inside a single combined Fly Machine image, instead of each owning its own
> always-on Fly app/Machine — cutting the staging compute footprint from four always-on
> `shared-1x 1GB` machines (~$26.80/mo) to one (~$6.70/mo) with **no change to any
> service's application code**.

Why it exists (quoted): "Fly bills per Machine (VM), not per logical service… carrying the
same pattern into production would put prod compute near or above Tom's $30/mo target
before the database, egress, or any headroom." It must "land and prove stable in staging
before the production cutover work (`production-data-migration-restore.md`,
`production-cloud-cutover-rollback.md`) carries the same decision forward."

The spec's own closing note anticipated the mechanical shape: "one new combined Dockerfile
copying each service's existing build output, a lightweight process supervisor (pm2 or a
simple shell script) starting all four, and one `fly.toml` with multiple `[[services]]`
blocks mapping only the two public-facing internal ports to external traffic."

**This design corrects two assumptions in that note** (see §3.1 and §3.2): Fly's process
groups each get their own Machine, so the consolidation must run as a *single* process group
with an in-container supervisor, and Fly serves one HTTP service per external port, so three
public hostnames cannot each map to their own internal port — one in-app Host router is
required.

---

## 1. Task, branch, worktree, repos

| Item | Value |
| --- | --- |
| Task | `219fb673-72d9-4d6c-a820-f31481316b37` — "💻 Consolidate tasks-api/budget-api/auto-post-worker/content-scheduler-api onto one Fly staging machine" (`taskType: code`, priority high) |
| Owner | Rowan (delivery assignee) |
| Branch | `task-219fb673-fly-staging-consolidation` |
| Worktree | `/Volumes/WD1/worktrees/rowan/task-219fb673-fly-staging-consolidation` |
| Repo | `Stoffer-Industries/sindustries` (canonical checkout stays on clean `main`; all work happens in the worktree) |
| Product spec | `brain/tasks/specs/open/fly-staging-service-consolidation-2026-11-05.md` (workspace repo, not in this repo) |
| Design doc | `docs/specs/fly-staging-service-consolidation-tech-design.md` (this file, on the branch) |
| Scope | Staging only. Production topology is explicitly deferred to `production-cloud-cutover-rollback.md`. |

---

## 2. Current state (baseline)

Four Fly apps in `syd`, each one always-on `shared-cpu-1x` / 1GB Machine, each with its own
image, release, secrets set, deploy workflow, and CI path filter:

| Fly app | Source | Port | Public route | Dockerfile / fly.toml |
| --- | --- | --- | --- | --- |
| `sindustries-tasks-api-staging` | `services/tasks-api/` | 4001 | `tasks-api.staging.sindustries.co.nz` | `infra/cloud/docker/tasks-api.Dockerfile`, `infra/cloud/fly/tasks-api.fly.toml` |
| `sindustries-budget-api-staging` | `services/budget-api/` | 4002 | `budget-api.staging.sindustries.co.nz` | `infra/cloud/docker/budget-api.Dockerfile`, `infra/cloud/fly/budget-api.fly.toml` |
| `sindustries-content-scheduler-api-staging` | `services/content-scheduler-api/` | 4003 | `content-scheduler-api.staging.sindustries.co.nz` | `infra/cloud/docker/content-scheduler-api.Dockerfile`, `infra/cloud/fly/content-scheduler-api.fly.toml` |
| `sindustries-auto-post-worker-staging` | `services/content-scheduler-api/src/workers/autoPostWorkerMain.ts` | — | none (queue-bound) | `infra/cloud/docker/auto-post-worker.Dockerfile`, `infra/cloud/fly/auto-post-worker.fly.toml` |

Facts that constrain the design (all verified in this repo, 2026-11-06):

1. **Every service reads the same env var name for its database.** All three Prisma schemas
   use `url = env("DATABASE_URL")` (`services/{tasks-api,budget-api,content-scheduler-api}/prisma/schema.prisma`).
   `infra/cloud/scripts/bootstrap-staging.sh` strips the per-service prefix and applies
   `DATABASE_URL` to each app, so the *staging* values differ per app (Neon, distinct
   `?schema=` values: `tasks_api`, `budget_api`, `content_scheduler`) while the *variable
   name* does not.
2. **Fly secrets are app-scoped.** All process groups in one app see the same environment
   (Fly's own docs: "secrets are shared across all process groups in a single app").
   Therefore one consolidated app cannot hand three different `DATABASE_URL` values to three
   children through the platform — the differentiation has to happen inside the container.
3. **Every other secret name is already distinct per service** (`TASKS_API_APPROVAL_SERVICE_CREDENTIALS`,
   `BUDGET_API_TOKEN_KEY`, `DEV_SESSION_SECRET`, `AKAHU_*`, `X_*`, `CONTENT_SCHEDULER_*`),
   so only `DATABASE_URL`, `REDIS_URL`, `PORT`, `CORS_ALLOWED_ORIGINS`, `OTEL_SERVICE_NAME`,
   `NODE_ENV`, `CONTENT_SCHEDULER_JOB_ADAPTER`, `ALLOW_PORT_DB_MISMATCH` collide.
4. **`infra/cloud/**` is in every service's CI path filter** (`.github/workflows/ci.yml`
   `tasks_api` / `budget_api` / `content_scheduler_api` / `auto_post_worker` filters), so
   *any* change under `infra/cloud/` currently re-deploys all four apps on merge to `main`.
5. **Three of the four apps carry a `release_command`** running a per-service Prisma
   migration (`npm run prisma:migrate --workspace services/<svc>`); the worker carries none.
   `tasks-api.fly.toml` records that Fly executes `release_command` directly, not through a
   shell, so `cd` and shell builtins are unavailable.
6. **tasks-api asserts its API-port/DB-port pairing** at boot
   (`services/tasks-api/src/server.ts:15-44`), with `ALLOW_PORT_DB_MISMATCH=1` as the
   documented escape hatch. Its `PORT=4001` must not change.
7. **The stable staging hostnames do not currently resolve.** All three service hostnames
   return NXDOMAIN on 1.1.1.1 and 8.8.8.8 (confirmed 2026-11-05, CI run `42001867228`;
   tracked by task `5cb4a8fe`, `attentionOwners: ['Tom']`). The blocker is a Cloudflare
   token with `Zone:DNS:Edit` that Tom owns; the agent token is read-only.

---

## 3. Target state and the platform constraints that shape it

```
                       ┌───────────────────────────────────────────────┐
  tasks-api.staging ──▶│  sindustries-platform-staging (1 Machine)      │
  budget-api.staging ─▶│  ┌─────────────────────────────────────────┐   │
  content-scheduler  ─▶│  │ nginx  :8080  Host+path router          │   │
  .staging            │  ├─────────────────────────────────────────┤   │
                       │  │ supervisor (Node)  :8081  status/health │   │
                       │  │  ├─ tasks-api            127.0.0.1:4001 │   │
                       │  │  ├─ budget-api           127.0.0.1:4002 │   │
                       │  │  ├─ content-scheduler-api 127.0.0.1:4003│   │
                       │  │  └─ auto-post-worker      (no listener)  │   │
                       │  └─────────────────────────────────────────┘   │
                       └───────────────────────────────────────────────┘
```

### 3.1 Fly process groups each get their own Machine — so use one process group

Fly's guide for multiple processes in one app is explicit: process groups "run each
process in its own Machine or group of Machines within the one app", and the guide's own
"maybe you want multiple apps though" section notes that separate apps are the way to
avoid exactly the contention we are trying to create.

If the consolidated app declared four `[processes]` entries, Fly would schedule four
Machines — the current cost, with the current isolation, plus a new shared image. **The
cost saving only exists if all four programs live in one Machine.** So the consolidation
must be a *single* Fly process group whose entrypoint is a supervisor that spawns four
children inside that one Machine. Fly's guide sanctions this pattern ("Just use Bash",
supervisord, or a Procfile manager), with one caveat that matters here: the supervisor must
stay in the foreground, because when the entrypoint exits Fly kills the Machine.

### 3.2 One app cannot serve three hostnames on 443 without an in-app router

Fly's `[[services]]` blocks each declare an `internal_port` and the external `ports` they
answer on. External port 443 can only be claimed once by an app; a second service on the
same app would need a different external port, and consumers of these services use plain
`https://<host>/...` URLs on 443. The spec's "one `fly.toml` with multiple `[[services]]`
blocks mapping only the two public-facing internal ports to external traffic" therefore
does not work as written.

The workable shape is one `[[services]]` block on 443 → one internal port → an in-container
router that dispatches on the `Host` header to 4001/4002/4003. That router is ordinary
infra (nginx), needs no application-code change, and keeps the public URLs identical to
today, which is what AC2 requires ("remain reachable on their existing routes").

The router also needs a **path-prefix** fallback for the provider hostname
(`sindustries-platform-staging.fly.dev`) because the stable hostnames do not resolve yet
(§2 fact 7): `/tasks-api/*`, `/budget-api/*`, `/content-scheduler-api/*` on the single
provider hostname. That keeps staging usable while the DNS blocker is open, and it means
the consolidation does not have to wait on Tom's Cloudflare token to be built and tested.

### 3.3 Per-service environment inside one Machine

Because Fly secrets are app-scoped (§2 fact 2), the supervisor builds each child's
environment from app-level secrets:

- app-level secret `PLATFORM_TASKS_API_DATABASE_URL` → child env `DATABASE_URL` for tasks-api;
- likewise `PLATFORM_BUDGET_API_DATABASE_URL`, `PLATFORM_CONTENT_SCHEDULER_API_DATABASE_URL`,
  `PLATFORM_REDIS_URL` (one Upstash instance — `REDIS_URL` is already shared by the
  content-scheduler API and the worker today), `PLATFORM_CONTENT_SCHEDULER_REDIS_URL`;
- every non-colliding secret (`TASKS_API_*`, `BUDGET_API_*`, `AKAHU_*`, `X_*`,
  `CONTENT_SCHEDULER_API_*`) is passed through unchanged, so the four services read the
  same names they read today;
- per-child overrides: `PORT` (4001/4002/4003), `OTEL_SERVICE_NAME`
  (`tasks-api` / `budget-api` / `content-scheduler-api` / `auto-post-worker`),
  `CORS_ALLOWED_ORIGINS` (unchanged values, moved from each app's `[env]` into the
  supervisor's per-child map), `NODE_ENV=production`, `CONTENT_SCHEDULER_JOB_ADAPTER=bullmq`,
  `ALLOW_PORT_DB_MISMATCH=1` (tasks-api only).

This keeps every service's **application code and its env var names** untouched — the
services still read `DATABASE_URL`, still read `PORT`, still read `REDIS_URL`. Only the
value that lands in each child's environment changes shape (from "the app's own secret" to
"the supervisor's mapping of an app-level secret").

### 3.4 Migrations: one release command, three migrations

The consolidated app has one `release_command`. Fly runs it directly (not via a shell), so
the chain must live in an npm script, which *is* run through a shell:

```
release_command = 'npm run prisma:migrate:platform'
```

with a root `package.json` script chaining the three existing per-service scripts
(`npm run prisma:migrate --workspace services/tasks-api` etc.) in sequence. The three
databases/schemas are independent, so ordering is a convention, not a correctness
requirement; tasks-api first matches today's deploy order. The worker's app has no
migration today and gains none.

### 3.5 Observability: same metric contract, one app

`health-probe` is a separate app and is **not** part of this consolidation. Its HTTP
targets are configured by env (`parseHttpTargets` in
`infra/cloud/observability/health-probe/src/probe.ts` parses `app=url` pairs, comma
separated) and the `app=` prefix becomes the metric label. The labels are therefore
operator-supplied strings, not Fly app names: keeping `tasks-api=…`,
`budget-api=…`, `content-scheduler-api=…` preserves the metric contract exactly (AC3) even
though all three URLs now point at one Fly app. The probe's own secret values must be
re-pointed at the stable hostnames once DNS lands — an operator step on the probe app,
not a code change.

`OTEL_SERVICE_NAME` stays distinct per child (§3.3), so traces, logs, and dashboards keep
distinguishing the four services even though their logs now interleave in one Fly app.

### 3.6 Deployment coupling (the cost of consolidation)

Today, a change under `services/tasks-api/**` deploys only tasks-api; under `infra/cloud/**`
it deploys all four (§2 fact 4). After consolidation, **any** of those changes redeploys the
whole platform, because there is one app and one image. That is inherent to the model and
must be documented (AC5) rather than engineered away: the mitigation is the `canary`
strategy (a new Machine comes up beside the old release and Fly promotes it only when
healthy) plus `fly releases rollback`.

---

## 4. Acceptance-criteria design

### AC1 — four services as separate processes in one Fly app/Machine, application code unmodified

Design: one image (`infra/cloud/docker/platform.Dockerfile`) built from the repo root,
installing the three service workspaces plus `packages/otel-node` and `packages/budget-domain`
in one `npm ci`; one entrypoint (the supervisor) spawning four children with per-child
env (§3.3). The four services' source trees, entrypoints, Prisma schemas, and package
scripts are untouched. The only new code is infra: the supervisor, the nginx config, and a
root npm script for the migration chain.

*No service code changes.* The service workspaces are copied verbatim into the image; the
Dockerfile is a union of the four existing ones.

### AC2 — public routes preserved; internal-only services not publicly exposed

- `tasks-api.staging.sindustries.co.nz` → 4001, `budget-api.staging.sindustries.co.nz` → 4002,
  `content-scheduler-api.staging.sindustries.co.nz` → 4003, all via the Host router.
- `auto-post-worker` has **no listener and no route** — it is queue-bound, exactly as today
  (`infra/cloud/hostname-matrix.json` records `publicUrl: false` for it).

**Correction to the product spec required for approval.** AC2 says "internal-only services
(auto-post-worker, content-scheduler-api) are not publicly exposed". content-scheduler-api
**is** publicly exposed today — it has its own `[http_service]`, its own Fly app, its own
stable hostname in `infra/cloud/hostname-matrix.json`, and `mission-control` calls it
browser-side (`CORS_ALLOWED_ORIGINS` includes the mission-control staging origin). Making
it internal would break a live consumer and would need an application-code change (the
browser cannot reach a private Fly service), which AC1 forbids.

Recommended reading for approval: AC2 means "no service gains public exposure; the
auto-post worker remains internal, and content-scheduler-api keeps exactly the exposure it
has today (one stable hostname)". This is a wording correction to the spec, not a scope
change — see §9 Q1, which needs Quinn's confirmation.

### AC3 — health-probe checks keep passing, no metric-contract change

See §3.5: the probe's target labels stay the logical service names, its code is unchanged,
and its URLs move from `*.fly.dev` to the stable hostnames (already the intended target per
`infra/cloud/hostname-matrix.json`; the probe is currently pointed at the provider URLs
because the stable hostnames do not resolve).

### AC4 — demonstrably cheaper

Method (the AC's own): capture the before and after from the Fly API/dashboard, not from
the spec's prose numbers.

- **Before:** `fly machine list --app <each of the four apps>` (count, size, region) plus
  the org's billing view, captured as task evidence before the cutover.
- **After:** the same capture for the consolidated app.
- **Sizing caveat:** the spec's baseline is "four `shared-1x` 1GB machines ≈ $26.80/mo →
  one ≈ $6.70/mo", i.e. ~$6.70 per 1GB machine. The consolidated Machine runs four Node
  processes plus nginx plus the supervisor, so **1GB is not a safe size**: four Node
  runtimes plus a router will not fit comfortably in 1GB, and the spec's own $6.70 target
  silently assumes they do. The design proposes **`shared-cpu-1x` / 2GB** as the starting
  point, to be adjusted by measuring RSS at boot (the supervisor's status endpoint reports
  per-child RSS). A 2GB consolidated machine is still materially cheaper than four 1GB
  machines, but the number must be **measured against Fly's live price sheet at
  implementation time** — the price sheet in the repo's era and the one scraped during
  this design pass do not obviously reconcile with $6.70/machine, so the spec's baseline
  figure should be re-derived from the Fly billing API rather than quoted.
- Evidence for AC4 goes in the implementation PR body (before/after machine lists and the
  computed monthly figure).

### AC5 — shared fate documented where an operator will find it

Places an operator actually looks, in this order:

1. `docs/systems/cloud-platform.md` — "Services" table, "Cost model", "Deploy procedure",
   and a new **"Shared-fate topology (staging)"** subsection stating: one Machine, one
   crash domain, one deploy restarts all four services, per-service scaling is impossible,
   and rollback is app-wide (`fly releases rollback`) with DNS reverted separately.
2. `infra/cloud/README.md` — the staging service table (it still lists four apps).
3. `docs/runbooks/` — a `platform-consolidation-rollback.md` runbook for the cutover and
   the backout (the repo currently has `staging-database-migration-restore.md` and
   `hosted-observability-ops.md`; there is no cloud-deploy rollback runbook yet, so this
   task adds one).
4. The nginx config header and the supervisor's `--help` output (read by whoever runs it
   next).

---

## 5. Ownership boundary — where does this thing live?

Per the tech-design skill's ownership check: the natural source of truth for this change is
**the workflow/cron/deploy boundary** (Fly packaging + CI wiring), not UI state, not an
API resource, not a shared application package.

- **Owned by the deploy surface:** `infra/cloud/**` (Dockerfile, fly.toml, nginx config,
  supervisor, env contract), `.github/workflows/**` (one deploy workflow + path filters),
  `infra/cloud/bin/{deploy,status,rollback}` (service→app mapping) and their shell tests.
- **Not owned by any service:** no service code, no service env var names, no Prisma
  schema, no API route, no DB table changes. The four services are consumers of the
  packaging, not authors of it.
- **Interim vs durable:** there is no interim shim here. The durable shape (one app, one
  image, one supervisor, one router) is about as easy to build as any interim arrangement
  would be, and a shim (e.g. keeping four apps and adding a fifth aggregator) would create
  a second source of truth for "where does staging run" — exactly the duplication the
  posture in `SOUL.md` warns against. One shape only.
- **Boundary with `.openclaw`:** the operator-facing surfaces (Fly app creation, secret
  registration, DNS CNAMEs, `fly certs add`) stay outside this repo. `infra/cloud/**` and
  `.github/workflows/**` are Rowan's; Fly/Neon/Upstash/DNS credentials are Quinn's; the
  Cloudflare `Zone:DNS:Edit` token is Tom's.

---

## 6. Implementation plan (file/module scope)

### 6.1 New files

| File | Purpose |
| --- | --- |
| `infra/cloud/docker/platform.Dockerfile` | Combined image: repo-root context, `npm ci` for the three services + `packages/otel-node` + `packages/budget-domain`, `prisma generate` for the three schemas, `nginx` + supervisor entrypoint. |
| `infra/cloud/docker/platform-supervisor.mjs` | Node supervisor (no new runtime deps): spawns the four children with per-child env, restarts crashed children with backoff, forwards SIGTERM/SIGINT, serves `127.0.0.1:8081/status` (per-child pid/state/restarts/exit code/RSS + worker heartbeat). |
| `infra/cloud/docker/platform-nginx.conf` | Host-header routing to 4001/4002/4003, path-prefix routing on the provider hostname, `/__status` proxy to the supervisor, access/error logs to stdout. |
| `infra/cloud/fly/platform.fly.toml` | New app spec: `app = 'sindustries-platform-staging'`, one `[[services]]` on 443 → 8080, `http_check` on `/__status`, `release_command = 'npm run prisma:migrate:platform'`, `[[vm]]` 2GB shared-cpu-1x, `strategy = 'canary'`. |
| `.github/workflows/deploy-staging-platform.yml` | One reusable deploy workflow replacing the four: validate config, deploy canary, then smoke-check **each** of the three stable hostnames (`/health`) plus the provider-hostname path routes, plus the worker startup log line. |
| `docs/runbooks/platform-consolidation-rollback.md` | Cutover sequence, backout sequence, and the shared-fate warning (AC5). |

### 6.2 Modified files

| File | Change |
| --- | --- |
| `.github/workflows/ci.yml` | Replace the four service path filters with one `platform` filter (`services/tasks-api/**`, `services/budget-api/**`, `services/content-scheduler-api/**`, `packages/otel-node/**`, `packages/budget-domain/**`, `infra/cloud/**`, the new workflow file, lockfile). Keep the four filters until the cutover lands, then remove them — a filter change on `main` redeploys. |
| `package.json` (root) | Add `prisma:migrate:platform` chaining the three workspace migrations. |
| `infra/cloud/bin/deploy`, `infra/cloud/bin/status`, `infra/cloud/bin/rollback` | Service→app/config/health-URL maps point at the consolidated app; the worker keeps its log-line smoke check. |
| `infra/cloud/bin/tests/{deploy,status,rollback}.test.sh` | Update the expected app names and config paths (these are the contract tests for the above). |
| `infra/cloud/hostname-matrix.json` | The three API surfaces' `flyApp` become the consolidated app; the `auto-post-worker` row keeps `publicUrl: false`. The matrix's own validators (`tests/cloud/scripts/check-stable-hostname-matrix.mjs`, `check-stable-url-fallbacks.mjs`, `check-deploy-workflow-stable-hostname.mjs`, `check-cors-origin-matrix.mjs`) must pass after the change. |
| `infra/cloud/observability/failure-inject.sh` | `APP_OVERRIDE` default now targets the consolidated app. |
| `infra/cloud/README.md` | Service table → one app, four processes; ownership table unchanged. |
| `docs/systems/cloud-platform.md` | Topology, cost model, shared-fate subsection (AC5). |
| `infra/cloud/env/*.env.example` | New app-level secret names (`PLATFORM_*`); the per-service examples stay as the *source* contract for the mapping. |

### 6.3 Explicitly not changed

`services/tasks-api/**`, `services/budget-api/**`, `services/content-scheduler-api/**`,
`apps/**`, `packages/**`, every Prisma schema, every API route, the `health-probe` app.

---

## 7. Test plan and AC verification matrix

| AC | Verification | Layer | Notes |
| --- | --- | --- | --- |
| AC1 | `fly machine list --app sindustries-platform-staging` shows **one** Machine; `fly status` shows one process group; the supervisor's `/status` shows four children with the expected commands; `fly logs` shows each child's structured startup line. | integration (live staging) + unit for the supervisor | Supervisor unit tests: child env mapping, restart-on-exit with backoff, SIGTERM propagation, status payload shape. No E2E browser test is applicable (no user-visible app flow changes). |
| AC2 | `curl -fsS https://tasks-api.staging.sindustries.co.nz/health` → 200; same for `budget-api` and `content-scheduler-api`; `curl -fsS https://sindustries-platform-staging.fly.dev/tasks-api/health` → 200; the auto-post worker has **no** route: `curl` against any worker path returns 404/502 and the worker appears in `/status` as a child with no listener. | integration (live staging) | Provider-hostname path routes are the interim proof while DNS is blocked. |
| AC3 | `health-probe` emits the same metric names/labels as before (target labels `tasks-api`, `budget-api`, `content-scheduler-api`); probe's own unit tests unchanged and green; a live probe pass shows all three HTTP targets healthy. | unit (existing probe tests) + integration (live probe) | The probe's *secrets* are re-pointed by Quinn; the probe's code and metric contract are untouched, which is what AC3 asks. |
| AC4 | Before/after `fly machine list` captures attached to the task; computed monthly figure; assert consolidated monthly cost < four-machine monthly cost. | integration (live Fly API) | Baseline re-derived from the live billing API, not from the spec's prose (§4 AC4). |
| AC5 | `docs/systems/cloud-platform.md` contains the shared-fate subsection; `infra/cloud/README.md` points at it; the runbook states the cutover + backout; a reviewer other than the author confirms each of the four claims is stated where an operator would look. | manual review | No user-visible app flow changes → no app `SPEC.md` change needed; `docs/systems/` is the right surface per `docs/CONVENTIONS.md` consolidation bias. |

Test command surface (existing, unchanged): `npm test --workspace services/tasks-api`,
`npm test --workspace services/budget-api`, `npm test --workspace services/content-scheduler-api`,
plus the `infra/cloud` contract-test job for the `bin/` script changes.

---

## 8. Cutover and backout (staging)

**Prerequisites (all external, all owned outside this repo):**

1. Quinn/Tom create the Fly app `sindustries-platform-staging` and register the app-level
   secrets (`PLATFORM_*`) — `infra/cloud/scripts/bootstrap-staging.sh` gains a fifth
   service entry.
2. DNS: the three stable hostnames must resolve to the consolidated app's
   `*.fly.dev` name, and `fly certs add <hostname> --app sindustries-platform-staging`
   per hostname. **Blocked today** on Tom's Cloudflare `Zone:DNS:Edit` token (task
   `5cb4a8fe`). The interim provider-hostname path routes let the build and most of the
   verification proceed without it.
3. The `content-scheduler` BullMQ queue and its worker must not be double-running: the
   old worker app must be scaled to zero **before** the consolidated app starts its
   worker child, and the old apps must be scaled to zero before the CNAMEs move.

**Sequence:** deploy the consolidated app (canary) → verify all three services via the
provider-hostname path routes → re-point the three CNAMEs → verify via the stable
hostnames → re-point health-probe's targets → scale the four old apps to zero (do not
delete: they are the fast backout) → record the AC4 before/after.

**Backout:** point the CNAMEs back at the old apps (DNS, ~minutes of TTL) and scale the
consolidated app to zero. `fly releases rollback <version>` handles a bad image inside the
new app only. The old apps must stay deployable for the duration of the soak.

---

## 9. Open questions and risks

**Q1 (needs Quinn's answer, blocks approval):** AC2's wording treats content-scheduler-api
as internal-only, but it is publicly exposed today and `mission-control` calls it from the
browser. Recommended: keep its current exposure (one stable hostname), and treat AC2 as
"no new public exposure; the auto-post worker stays internal". If AC2 is meant literally,
the task's scope changes materially (browser clients cannot reach a private Fly service,
so it would need either a public edge in front of it or a code change in mission-control).

**Q2 (needs Quinn's answer):** are the three staging `DATABASE_URL` values the *same* Neon
database with different `?schema=` values, or three separate databases? The design works
either way (the supervisor maps a `PLATFORM_*_DATABASE_URL` per child), but the answer
changes how the secret names read and whether one `PLATFORM_REDIS_URL` is right or
per-service Redis URLs are needed. Not a blocker for the design; a blocker for the
bootstrap script.

**Q3 (needs Tom/Quinn):** the `Zone:DNS:Edit` Cloudflare token. Without it the cutover
cannot move the CNAMEs, so the consolidation can be built and verified on the provider
hostname but not fully landed on the stable routes.

**Risks:**

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Memory: 4 Node processes + nginx + supervisor do not fit in 1GB | High | Start at 2GB; the supervisor reports per-child RSS; AC4 is re-measured at the chosen size. A 2GB machine is still well under four 1GB machines. |
| Blast radius: one crash/leak takes down all four services; one deploy restarts all four | High | Accepted for staging by this task; `canary` + app-wide rollback; documented under AC5; production re-decided in `production-cloud-cutover-rollback.md`. |
| Boot time: `prisma generate` for three schemas + four Node startups may exceed the Fly `http_check` grace period | Medium | Generate Prisma clients at image build time (as `auto-post-worker.Dockerfile` already does) rather than at boot; raise `grace_period` in the new `fly.toml`. |
| Release command ordering: `release_command` is not a shell | Low | Chain the three migrations in a root npm script (§3.4). |
| Deploy coupling: any `infra/cloud/**` or service change now redeploys everything | Medium | Inherent to the model; documented; `canary` keeps the blast radius to one release. |
| Log interleaving: `fly logs` no longer separates the four services | Medium | `OTEL_SERVICE_NAME` stays distinct per child; operators filter by service name; documented in the runbook. |
| Stale branch/worktree from a previous pass could be mistaken for completed work | Low | Dedupe guard: diff the existing branch against `origin/main` before reusing it (this design's own branch was found at an old commit with zero unique commits and was reset to `origin/main`). |

---

## 10. Related documents

- `brain/tasks/specs/open/fly-staging-service-consolidation-2026-11-05.md` — product spec
- `brain/tasks/specs/open/production-data-migration-restore.md`,
  `brain/tasks/specs/open/production-cloud-cutover-rollback.md` — the production decisions this staging result feeds
- `docs/specs/cloud-deployment-foundation-tech-design.md` — the original one-app-per-service decision this task revisits
- `docs/specs/add-stable-app-name-hostnames-tech-design.md` — the hostname matrix contract
- `docs/systems/cloud-platform.md` — the durable platform doc (AC5 lives here)
- `infra/cloud/hostname-matrix.json` — authoritative hostname/app mapping
- Task `5cb4a8fe` — the open DNS/certificate blocker that gates the final cutover
