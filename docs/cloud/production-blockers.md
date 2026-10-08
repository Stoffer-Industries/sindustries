# Production hostname blockers — task `5cb4a8fe`

**Status:** As of slice 5 (Vercel env matrix + production-blockers list), the
**infrastructure** for production hostnames is implemented. The blockers below
are the **operator-owned** setup steps Quinn and Tom must complete before any
production hostname resolves to a real deployment. Until each item is closed
the production `*.sindustries.co.nz` hostnames either fail DNS, fail TLS, or
point at staging infrastructure.

This document is the AC6 evidence register. Slice 5 of the implementation PR
references it; slice 5 marks the task as `[implementer-prs]`-eligible (subject
to the rest of slice 5 — Vercel env matrix + this list) only after each item
is either closed or explicitly accepted as out-of-scope for this task with an
owner named.

For the **source-of-truth matrix** see [`infra/cloud/hostname-matrix.json`](../../infra/cloud/hostname-matrix.json)
and the per-hostname comment block at the top of each `infra/cloud/fly/*.fly.toml`.

For the **Vercel env contract** see [`infra/cloud/vercel-env-matrix.json`](../../infra/cloud/vercel-env-matrix.json)
and the static check `tests/cloud/scripts/check-vercel-env-matrix.mjs` (enforced
on every CI run).

For the **per-service deploy procedure** see [Cloud Platform](../systems/cloud-platform.md).

---

## Blockers (must close before production cutover)

### 1. DNS — apex + per-hostname records

| Surface | Production hostname | Required DNS record | Owner | Status |
| --- | --- | --- | --- | --- |
| Apex | `sindustries.co.nz` | apex A/ALIAS to Vercel (frontends) or Fly (apis) | Quinn | Pending |
| Mission Control | `mission-control.sindustries.co.nz` | CNAME → Vercel project `sindustries-mission-control` | Quinn | Pending |
| Tasks app | `tasks.sindustries.co.nz` | CNAME → Vercel project `sindustries-tasks` | Quinn | Pending |
| Tasks API | `tasks-api.sindustries.co.nz` | CNAME → Fly app `sindustries-tasks-api` | Quinn | Pending |
| Budget API | `budget-api.sindustries.co.nz` | CNAME → Fly app `sindustries-budget-api` | Quinn | Pending |
| Content Scheduler API | `content-scheduler-api.sindustries.co.nz` | CNAME → Fly app `sindustries-content-scheduler-api` | Quinn | Pending |
| Health probe | `health-probe.sindustries.co.nz` | CNAME → Fly app `sindustries-health-probe` | Quinn | Pending |

**Notes:**
- The DNS provider is the open question (tech design OQ2). Once chosen, the
  apex record strategy is provider-specific: Vercel wants `A 76.76.21.21` or
  ALIAS; Fly wants CNAME to `<app>.flycast.net` for the per-app entries.
- The auto-post worker has no production hostname (matrix records
  `production: null`, `publicUrl: false`); no DNS work needed.

### 2. TLS certificates

| Surface | Production hostname | TLS strategy | Owner | Status |
| --- | --- | --- | --- | --- |
| Frontends (Vercel) | mission-control, tasks | Vercel auto-provisions via Let's Encrypt once the custom domain is added to the project | Quinn (trigger) | Pending |
| APIs (Fly) | tasks-api, budget-api, content-scheduler-api, health-probe | `fly certs add <hostname>` per Fly app (Let's Encrypt via Fly) | Quinn | Pending |

**Notes:**
- Vercel auto-provisions TLS when the custom domain is added. The 1-minute
  propagation delay is the same as staging; deploy workflows already
  20-attempt smoke loop accommodates the latency (slice 3, AC4 enforcement).
- Fly `fly certs add` issues a Let's Encrypt cert for the hostname. The
  staging smoke loop is the same shape; production uses the same loop in
  `deploy-staging-*.yml` workflow files (these will be cloned as
  `deploy-production-*.yml` for the production rollout, but that is a
  separate task — this task only ships the contract, not the production
  deploy workflows).

### 3. Vercel custom domain registration

For each Vercel project, add the production custom domain via the Vercel
dashboard or API. The contract is recorded in
[`infra/cloud/vercel-env-matrix.json`](../../infra/cloud/vercel-env-matrix.json);
the static check enforces the customDomain value matches the matrix.

| Vercel project | Custom domain (production) | Custom domain (preview → staging) | Owner | Status |
| --- | --- | --- | --- | --- |
| `sindustries-mission-control` | `mission-control.sindustries.co.nz` | `mission-control.staging.sindustries.co.nz` | Quinn | Pending |
| `sindustries-tasks` | `tasks.sindustries.co.nz` | `tasks.staging.sindustries.co.nz` | Quinn | Pending |

**Notes:**
- Vercel Preview deployments are mapped to staging via a branch deployment
  restriction (`staging` branch only). The `staging` Vercel URL is then
  the preview deployment behind the staging custom domain above.
- The `gymtrack` and `website` Vercel projects are out of scope for this
  task (matrix `outOfScope[]`); GymTrack is owned by the Clerk cutover
  (task `bb09eaed`), website is a separate task.

### 4. Vercel env var provisioning

For each Vercel project + environment, set the VITE_* env vars recorded in
[`infra/cloud/vercel-env-matrix.json`](../../infra/cloud/vercel-env-matrix.json).
The static check enforces the committed **value contract** matches the
matrix; Quinn sets the actual values in the Vercel dashboard.

| Vercel project | Env | Env var | Value | Owner | Status |
| --- | --- | --- | --- | --- | --- |
| `sindustries-mission-control` | production | `VITE_TASKS_API_BASE_URL` | `https://tasks-api.sindustries.co.nz/api/v1` | Quinn | Pending |
| `sindustries-mission-control` | production | `VITE_CONTENT_SCHEDULER_API_BASE_URL` | `https://content-scheduler-api.sindustries.co.nz/api/v1` | Quinn | Pending |
| `sindustries-mission-control` | preview | `VITE_TASKS_API_BASE_URL` | `https://tasks-api.staging.sindustries.co.nz/api/v1` | Quinn | Pending |
| `sindustries-mission-control` | preview | `VITE_CONTENT_SCHEDULER_API_BASE_URL` | `https://content-scheduler-api.staging.sindustries.co.nz/api/v1` | Quinn | Pending |
| `sindustries-tasks` | production | `VITE_TASKS_API_BASE_URL` | `https://tasks-api.sindustries.co.nz/api/v1` | Quinn | Pending |
| `sindustries-tasks` | preview | `VITE_TASKS_API_BASE_URL` | `https://tasks-api.staging.sindustries.co.nz/api/v1` | Quinn | Pending |

**Notes:**
- These values are recorded in the committed Vercel env matrix because
  the **contract** is the engineer's responsibility (which var, which
  surface, which environment). The actual Vercel dashboard entries are
  operator-owned per the credential boundary in [Cloud Platform](../systems/cloud-platform.md#credential-boundary).
- A future task may move the values into a Vercel `vercel-cli` import
  script that Quinn runs; this task only ships the contract.

### 5. Fly secrets + production env vars (per service)

The per-service fly.toml `[env]` blocks already declare the production
hostnames for the CORS half (slices 1+2) and the smoke URL (slice 3). The
**secret** env vars (DATABASE_URL, REDIS_URL, OTEL_*, etc.) are
operator-owned and set via `fly secrets set` per the credential boundary.

| Fly app | Required secret env vars | Owner | Status |
| --- | --- | --- | --- |
| `sindustries-tasks-api` | DATABASE_URL, REDIS_URL, OTEL_*, tasks-api service-token | Quinn | Pending (staging done) |
| `sindustries-budget-api` | DATABASE_URL, REDIS_URL, AKAHU_*, OTEL_* | Quinn | Pending (staging done) |
| `sindustries-content-scheduler-api` | DATABASE_URL, CONTENT_SCHEDULER_REDIS_URL, OTEL_* | Quinn | Pending (staging done) |
| `sindustries-health-probe` | OTEL_* | Quinn | Pending (staging done) |
| `sindustries-auto-post-worker` | DATABASE_URL, CONTENT_SCHEDULER_REDIS_URL, OTEL_* | Quinn | Pending (staging done) |

**Notes:**
- The credential boundary in cloud-platform.md applies unchanged: Quinn
  owns the live values via `fly secrets set`; Rowan ships only env-var
  names in the committed fly.toml `[env]` blocks.
- The bootstrap script `infra/cloud/scripts/bootstrap-staging.sh` will
  be cloned to `bootstrap-production.sh` for production rollout; that
  is a separate task.

### 6. Production deploy workflows (separate task)

This task ships the **staging** deploy workflow migration to the stable
hostname (slice 3, PR #775, merged 2026-10-08T10:28:43Z). The
**production** deploy workflows (`deploy-production-tasks-api.yml` etc.)
are a separate task — not in scope for `5cb4a8fe`. Quinn runs the
production deploy by dispatching the same pattern against the production
GitHub environment.

| Workflow | Status | Owner |
| --- | --- | --- |
| `deploy-staging-tasks-api.yml` | Merged (PR #775) | Rowan |
| `deploy-staging-budget-api.yml` | Merged (PR #775) | Rowan |
| `deploy-staging-content-scheduler-api.yml` | Merged (PR #775) | Rowan |
| `deploy-staging-health-probe.yml` | Merged (PR #775) | Rowan |
| `deploy-production-tasks-api.yml` | Out of scope for this task | Separate task |
| `deploy-production-budget-api.yml` | Out of scope for this task | Separate task |
| `deploy-production-content-scheduler-api.yml` | Out of scope for this task | Separate task |
| `deploy-production-health-probe.yml` | Out of scope for this task | Separate task |

### 7. Production smoke + cutover (separate task)

| Activity | Owner | Status | Tracking |
| --- | --- | --- | --- |
| Production smoke against stable hostnames (mirroring `cloud-staging-validate.yml`) | Rowan + Quinn | Not started | Separate task |
| Production cutover with rollback verification | Quinn + Tom | Not started | Task `020f423e` (Execute production cloud cutover) |
| Production data migration with verified backup + restore | Quinn + Tom | Not started | Task `f2c23e26` |

### 8. Cross-environment safety net (AC6 requirement)

AC6 requires: "Production hostname configuration is verified without
deploying staging credentials or pointing any staging URL at production
data". The contract is enforced by the static checks, not by Quinn's
manual procedure. Specifically:

- `tests/cloud/scripts/check-stable-url-fallbacks.mjs` (AC4) — every
  in-scope `*.fly.dev` / `*.vercel.app` reference carries a
  `stable-fallback` or `documented-migration` annotation, so a future
  copy-paste of a staging URL into a production fly.toml is at minimum
  tagged for review.
- `tests/cloud/scripts/check-vercel-env-matrix.mjs` (this slice) — the
  production env var values are recorded against the production matrix
  row, not the staging row; a staging URL accidentally pasted into a
  production Vercel environment fails the cross-env drift check at
  compile time.
- `tests/cloud/scripts/check-cors-origin-matrix.mjs` (slice 2) — the
  CORS half enforces a staging fly.toml never references a production
  hostname and vice versa.
- `tests/cloud/scripts/check-deploy-workflow-stable-hostname.mjs` (slice
  3) — the deploy workflow smoke URLs are derived from the matrix.

Quinn does not need to remember "don't paste staging credentials into
production"; the static checks make it a CI failure, not a runtime one.

---

## Closing the blockers

For each row above, the owner marks the row `Closed` once the
corresponding work lands. The evidence pointers (DNS screenshot, Vercel
custom-domain screenshot, `fly certs list` output, etc.) attach to the
matching AC in the task description so Tom's `qa_agent` review can read
back the closure from the task comment, not from Quinn's memory.

When all of blockers 1–5 are closed and the cross-environment safety
net (blocker 8) has at least one CI run on `main` against a green
production deploy, the task is `[implementer-prs]`-eligible and Tom's
structured `qa_agent` review can proceed. Blockers 6 and 7 are out of
scope for this task and tracked separately.

---

## Related documents

- [`infra/cloud/hostname-matrix.json`](../../infra/cloud/hostname-matrix.json) — source-of-truth matrix.
- [`infra/cloud/vercel-env-matrix.json`](../../infra/cloud/vercel-env-matrix.json) — Vercel env var contract.
- [`tests/cloud/scripts/check-vercel-env-matrix.mjs`](../../tests/cloud/scripts/check-vercel-env-matrix.mjs) — Vercel env matrix static check.
- [`docs/specs/add-stable-app-name-hostnames-tech-design.md`](../specs/add-stable-app-name-hostnames-tech-design.md) — design.
- [`docs/systems/cloud-platform.md`](../systems/cloud-platform.md) — Cloud Platform handover doc.
