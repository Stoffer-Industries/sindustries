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

**Last full live verification:** 2026-11-13 — see
[§9 — Observed state](#9-observed-state-live-verification-2026-11-13) for
what the DNS, TLS and Vercel control planes actually looked like on that
date, including the places where they disagree with the contract recorded
in sections 1–4.

**Targeted Slice D live re-read:** 2026-11-16 — Neon organization/plan,
project allowlist, production branch, Fly app inventory, Fly-managed Upstash database
inventory, GitHub `production` Environment inventory, Cloudflare DNS, and
production hostname resolution. The findings are recorded in §5 below.

---

## Blockers (must close before production cutover)

### 1. DNS — apex + per-hostname records

| Surface | Production hostname | Required DNS record | CNAME target (matrix contract) | Owner | Status |
| --- | --- | --- | --- | --- | --- |
| Apex | `sindustries.co.nz` | apex A/ALIAS to Vercel (frontends) or Fly (apis) | — | Quinn | Pending |
| Mission Control | `mission-control.sindustries.co.nz` | CNAME → Vercel project `sindustries-mission-control` | `cname.vercel-dns.com` | Quinn | Pending |
| Tasks app | `tasks.sindustries.co.nz` | CNAME → Vercel project `sindustries-tasks` | `cname.vercel-dns.com` | Quinn | Pending |
| Tasks API | `tasks-api.sindustries.co.nz` | CNAME → consolidated Fly app `sindustries-platform-production` | `sindustries-platform-production.fly.dev` | Quinn | Pending |
| Budget API | `budget-api.sindustries.co.nz` | CNAME → consolidated Fly app `sindustries-platform-production` | `sindustries-platform-production.fly.dev` | Quinn | Pending |
| Content Scheduler API | `content-scheduler-api.sindustries.co.nz` | CNAME → consolidated Fly app `sindustries-platform-production` | `sindustries-platform-production.fly.dev` | Quinn | Pending |
| Health probe | `health-probe.sindustries.co.nz` | CNAME → Fly app `sindustries-health-probe-production` | `sindustries-health-probe-production.fly.dev` | Quinn | Pending |
| Auto-post worker | _(none — no public URL)_ | n/a — the worker has no HTTP surface | — | — | Not applicable |

**Notes:**
- The DNS provider is the open question (tech design OQ2). Once chosen, the
  apex record strategy is provider-specific: Vercel wants `A 76.76.21.21` or
  ALIAS; Fly wants a CNAME to the app's provider host for the per-app
  entries.
- The **CNAME target** column is the matrix's `cnameTargets.production`
  contract value, not an observed live value: `cname.vercel-dns.com` for the
  two Vercel frontends, and the `<app>.fly.dev` host for each Fly app. The
  static check enforces the column against the matrix, so it cannot drift
  into a provider host the matrix does not name (an earlier revision of
  this table pointed at `<app>.flycast.net`, which the matrix does not
  record). §9 records what the live control planes actually look like.
- The auto-post worker has no production hostname (matrix records
  `production: null`, `publicUrl: false`); no DNS work needed. Its health is
  observed on the content-scheduler-api surface, not on a host of its own.
- **The two production Vercel project names in this table do not exist yet.** The
  Vercel team contains `sindustries-mission-control-staging` and
  `sindustries-tasks-app-staging`, which own the **staging** stable
  hostnames; the `sindustries-mission-control` and `sindustries-tasks`
  projects named here (and in `infra/cloud/hostname-matrix.json`) are the
  production-side contract and are not in the team. The environment
  separation is therefore **per project**, not per Vercel environment —
  see [§9 — Observed state](#9-observed-state-live-verification-2026-11-13)
  for the live evidence and Quinn's 2026-11-13 project-model decision.
  Until the production projects are provisioned, the two frontend rows
  above are a target contract for production, not a "point DNS here"
  instruction for staging.

### 2. TLS certificates

| Surface | Production hostname | TLS strategy | Owner | Status |
| --- | --- | --- | --- | --- |
| Frontends (Vercel) | mission-control, tasks | Vercel auto-provisions via Let's Encrypt once the custom domain is added to the project | Quinn (trigger) | Pending |
| APIs (Fly) | tasks-api, budget-api, content-scheduler-api, health-probe | `fly certs add <hostname>` per Fly app (Let's Encrypt via Fly) | Quinn | Pending |

**Staging TLS state (live, verified 2026-11-13):** the four Fly staging
hostnames present valid Let's Encrypt certificates whose CN and SAN
are exactly the stable hostname (`tasks-api`, `budget-api`,
`content-scheduler-api`, `health-probe` — valid 2026-11-10 → 2027-02-08), and
each of their health endpoints answers HTTP 200. The **two Vercel staging
hostnames now present valid Let's Encrypt certificates as well**:
`mission-control.staging.sindustries.co.nz` (`CN=mission-control.staging.sindustries.co.nz`,
issuer `Let's Encrypt CN=YR1`, valid 2026-11-13 → 2027-02-11) and
`tasks.staging.sindustries.co.nz` (`CN=tasks.staging.sindustries.co.nz`,
issuer `Let's Encrypt CN=YR2`, valid 2026-11-13 → 2027-02-11). The earlier
observation (2026-11-11) that they presented no certificate at all was true
then and is closed now: both staging projects were rebuilt from `main` and
redeployed on 2026-11-13, so a deployment carries the custom-domain alias and
Vercel provisioned a certificate for it. No DNS change was needed. See
[§9](#9-observed-state-live-verification-2026-11-13).

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

| Matrix contract project | Custom domain (production) | Custom domain (staging) | Actually bound in Vercel (verified 2026-11-13) | Owner | Status |
| --- | --- | --- | --- | --- | --- |
| `sindustries-mission-control` | `mission-control.sindustries.co.nz` | `mission-control.staging.sindustries.co.nz` | `sindustries-mission-control-staging` (bound 2026-10-23, deployment + certificate verified 2026-11-13) | Quinn | Staging live; production project not created |
| `sindustries-tasks` | `tasks.sindustries.co.nz` | `tasks.staging.sindustries.co.nz` | `sindustries-tasks-app-staging` (bound 2026-10-23, deployment + certificate verified 2026-11-13) | Quinn | Staging live; production project not created |

**Notes:**
- **Project model (Quinn, 2026-11-13):** the contract names FOUR Vercel
  projects, not two. `sindustries-mission-control` /
  `sindustries-tasks` are the **production** projects (not yet created);
  `sindustries-mission-control-staging` / `sindustries-tasks-app-staging`
  are the **staging** projects that exist today and already hold the
  verified staging custom-domain bindings. The matrix records them as
  `vercelProject` (production) and `vercelStagingProject` (staging), and
  the environment separation is the project itself — each project carries
  exactly one environment, its own production deployment target. There is
  no `preview` target: the staging projects serve their staging hostname
  from their production deployment target, which is why the earlier
  `vercelEnvironments.staging = preview` model did not describe reality.
- There is **no** branch deployment restriction and **no** `preview`
  target: the live staging projects have an empty `branches` list, and
  their staging custom domains are bound to those projects' **production**
  deployment target, which is why the contract records one environment per
  project rather than a `preview` environment. (An earlier revision of this
  note described a `staging`-branch deployment restriction as if it were
  live; it never was, and the contract does not depend on it.)
- **Deployment branch (observed 2026-11-13):** both staging projects build
  from `main`. The `mission-control-vercel` branch named by the older
  `mission-control-vercel-deployment` tech design was never created in the
  repository — it survives only as a design reference — and the deployments
  serving the stable staging hostnames were built from `main` (commit
  7ba14896). `infra/cloud/vercel-env-matrix.json` records `main` as the
  observed branch.
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
| `sindustries-mission-control` | production (serves production) | `VITE_TASKS_API_BASE_URL` | `https://tasks-api.sindustries.co.nz/api/v1` | Quinn | Pending |
| `sindustries-mission-control` | production (serves production) | `VITE_CONTENT_SCHEDULER_API_BASE_URL` | `https://content-scheduler-api.sindustries.co.nz/api/v1` | Quinn | Pending |
| `sindustries-mission-control-staging` | production (serves staging) | `VITE_TASKS_API_BASE_URL` | `https://tasks-api.staging.sindustries.co.nz/api/v1` | Quinn | Set (verified in the live bundle 2026-11-13) |
| `sindustries-mission-control-staging` | production (serves staging) | `VITE_CONTENT_SCHEDULER_API_BASE_URL` | `https://content-scheduler-api.staging.sindustries.co.nz/api/v1` | Quinn | Set (verified in the live bundle 2026-11-13) |
| `sindustries-tasks` | production (serves production) | `VITE_TASKS_API_BASE_URL` | `https://tasks-api.sindustries.co.nz/api/v1` | Quinn | Pending |
| `sindustries-tasks-app-staging` | production (serves staging) | `VITE_TASKS_API_BASE_URL` | `https://tasks-api.staging.sindustries.co.nz/api/v1` | Quinn | Set (verified in the live bundle 2026-11-13) |

**Notes:**
- The **Env** column records the Vercel deployment target, which is
  `production` in all four projects — the staging projects have no
  `preview` target, so their production deployment target serves the
  staging hostname. The parenthetical records which Sindustries
  environment that target serves.
- These values are recorded in the committed Vercel env matrix because
  the **contract** is the engineer's responsibility (which var, which
  surface, which environment). The actual Vercel dashboard entries are
  operator-owned per the credential boundary in [Cloud Platform](../systems/cloud-platform.md#credential-boundary).
- A future task may move the values into a Vercel `vercel-cli` import
  script that Quinn runs; this task only ships the contract.

### 5. Fly secrets + production env vars (current topology)

Production follows the same consolidated topology as staging: tasks-api,
budget-api, content-scheduler-api, and auto-post-worker are children of one
platform app, while health-probe keeps its own environment-specific app. The
app-level values are operator-owned and set via `fly secrets set` per the
credential boundary.

| Fly app | Required secret env vars | Owner | Status |
| --- | --- | --- | --- |
| `sindustries-platform-production` | The 15 app-level values defined by `platform-provision-secrets.mjs`: three database URLs, six Redis URLs, two approval credentials, content-scheduler base URL, and three CORS allow-lists; plus pass-through AKAHU_* and OTEL_* values where enabled | Quinn | Live — release and 15-name inventory read back 2026-11-16 |
| `sindustries-health-probe-production` | HEALTH_PROBE_DATABASES, HEALTH_PROBE_FLY_APPS, HEALTH_PROBE_REDIS, OTEL_* | Quinn | Live — all DB/Redis targets healthy 2026-11-16 |

**Notes:**
- The credential boundary in cloud-platform.md applies unchanged: Quinn owns
  the live values; Rowan ships the environment manifest and provisioning
  contract.
- The five Slice D obligations no machine can prove — the Fly spend-limit
  read-back, the staging/dev Neon denial proof, one successful production
  probe interval, the production API health responses and the DNS
  resolution/TLS read-back — are closed by an OPERATOR READ-BACK recorded
  in the provisioning-state artifact's `operatorEvidence` section
  (`capture-production-provisioning-state.mjs --operator-evidence <file>`).
  The record carries a boolean, a read-back time, a required pointer to the
  read-back and the production surfaces it covered, never a value. The
  spend-bound slot additionally names the CONTROL that bounded production
  spend — `fly-native-spend-limit` or `prepaid-capped-billing-method` (the
  control Tom approved on 2026-11-17, because this account has no native
  Fly spend-limit surface) — and a record with no control or an unknown
  one is refused. A record without an inspectable pointer, or with a
  read-back stamped after the artifact was captured, is refused. The
  Four are recorded in `production-provisioning-readback.md`; the Fly
  spend-bound slot remains open because the approved control is not active
  yet. The
  `fly.spend-limit-before-public-exposure`
  gate enforces the order the approved design makes a hard gate: while a
  production hostname is published or the production health-probe app is
  running, an artifact with no recorded spend-limit read-back fails.
- The ORDER itself is a second gate, `fly.spend-bound-ordering`: the
  capture records WHEN production became publicly exposed (the Cloudflare
  record's creation time and the production probe app's release creation
  time), and the bound's read-back time is compared with it. Production
  DNS was published at 2026-11-16T10:12:23Z and the production probe's
  current release at 2026-11-16T20:32:20Z, so a bound read back after
  that — which is what the approved prepaid/capped control will be — is an
  order violation and fails the gate. The order cannot be un-violated by
  recording, so the closure path is a recorded acceptance of the
  deviation (`flySpendOrderingDeviation`, the same value-free shape, with
  a pointer to the acceptance and the exposed surfaces it covers) or a
  rollback of the exposure. That acceptance is Tom/QA's to give; the
  repository does not record it on anyone's behalf.
- A recorded read-back must also name the production surfaces it covered,
  in `targets`. A boolean on its own proves only that a statement was
  made: a record with the scope "done" would otherwise close the DNS
  read-back while no production hostname resolved at all. The checker
  compares `targets` against the surfaces the repository expects for that
  slot and leaves the obligation open when the record names none of them,
  names only some of them, or names a surface production does not use.
  The app names and hostnames are derived from the environment manifest
  and the hostname matrix; the Neon credential kinds are fixed by the
  Neon contract. The expected sets therefore cannot drift with the
  deployed topology:

  | Slot | `targets` must name |
  | --- | --- |
  | flySpendLimit | `sindustries-platform-production` — the production app scope the spend bound covers |
  | productionProbeInterval | `sindustries-health-probe-production` — the app the interval must be observed on |
  | productionApiHealthResponses | `tasks-api.sindustries.co.nz`, `budget-api.sindustries.co.nz`, `content-scheduler-api.sindustries.co.nz` — the three production APIs, served by `sindustries-platform-production` |
  | dnsResolutionAndTlsReadback | `tasks-api.sindustries.co.nz`, `budget-api.sindustries.co.nz`, `content-scheduler-api.sindustries.co.nz` — served by `sindustries-platform-production` |
  | dnsResolutionAndTlsReadback | `health-probe.sindustries.co.nz` — served by `sindustries-health-probe-production` |
  | neonSeparationDenialProof | `production`, `staging`, `dev` — the production branch and BOTH refused credentials |

  The operator evidence file therefore looks like this (the timestamps and
  pointers are the operator's own). Every `evidenceRef` is a repository-
  relative path to a file that EXISTS in the repository: the pointer is
  resolved against the checkout and a path that names nothing is refused,
  so a slot cannot close on a pointer nobody could open. The read-backs
  for these four slots live in
  `docs/cloud/production-provisioning-readback.md`, which is the file the
  pointers below name.

  ```json
  {
    "flySpendLimit": {
      "recorded": true,
      "readBackAt": "2026-11-16T09:00:00.000Z",
      "scope": "personal organization - production app scope",
      "control": "prepaid-capped-billing-method",
      "evidenceRef": "docs/cloud/production-provisioning-readback.md",
      "targets": ["sindustries-platform-production"]
    },
    "neonSeparationDenialProof": {
      "recorded": true,
      "readBackAt": "2026-11-16T09:10:00.000Z",
      "evidenceRef": "docs/cloud/production-provisioning-readback.md",
      "targets": ["production", "staging", "dev"]
    },
    "productionProbeInterval": {
      "recorded": true,
      "readBackAt": "2026-11-16T09:20:00.000Z",
      "evidenceRef": "docs/cloud/production-provisioning-readback.md",
      "targets": ["sindustries-health-probe-production"]
    },
    "productionApiHealthResponses": {
      "recorded": true,
      "readBackAt": "2026-11-16T09:30:00.000Z",
      "evidenceRef": "docs/cloud/production-provisioning-readback.md",
      "targets": [
        "tasks-api.sindustries.co.nz",
        "budget-api.sindustries.co.nz",
        "content-scheduler-api.sindustries.co.nz"
      ]
    },
    "dnsResolutionAndTlsReadback": {
      "recorded": true,
      "readBackAt": "2026-11-16T09:40:00.000Z",
      "evidenceRef": "docs/cloud/production-provisioning-readback.md",
      "targets": [
        "tasks-api.sindustries.co.nz",
        "budget-api.sindustries.co.nz",
        "content-scheduler-api.sindustries.co.nz",
        "health-probe.sindustries.co.nz"
      ]
    }
  }
  ```
- `platform-provision-secrets.mjs --environment production` derives the
  production app name and the `PRODUCTION_*` secret source names from the
  environment manifest
  (`infra/cloud/platform/platform-environments.mjs`), which is the single
  source of truth for the production topology.
- App creation and the production deploy workflows now exist (task
  `fb1240c0`, PR #979): `bootstrap-production.sh` creates the production
  platform app through the shared bootstrap, and
  `.github/workflows/deploy-production-platform.yml` and
  `.github/workflows/deploy-production-health-probe.yml` deploy it. The
  manifest-to-workflow drift check
  (`tests/cloud/scripts/check-production-deploy-contract.mjs`) binds those
  workflows' app name, gates, rendered Fly config and secret names to the
  manifest, so a workflow cannot drift from the manifest it claims to follow.
- The production environment is live as of 2026-11-16: the consolidated
  platform and health-probe apps are deployed, all four Fly-hosted production
  DNS/TLS surfaces resolve and return 200, and all three schemas plus Redis
  report `up=1`. See `docs/cloud/production-provisioning-readback.md`.
- The production Neon branch now carries the three service schemas and one
  write-capable, schema-confined role per schema. Staging and dev credentials
  were both refused against the production endpoint. The IP allowlist remains
  unavailable on the current Free plan and is explicitly deferred by Tom;
  that remaining limitation is recorded in the read-back rather than hidden.
- Redis is two separate Fly-managed Upstash Pay-as-you-go add-ons in `syd`:
  `sindustries-staging` and `sindustries-production`. The direct-Upstash
  staging database was retired after staging was repointed and health-checked.
  The manifest's `redisAddon` entries are the source of truth.
  - **Provider-plan blocker (re-read 2026-11-16):** the Neon organization
    `Stoffer Industries` reports `plan=free`. Neon currently makes IP Allow
    a **Scale-plan** feature, while protected branches are available only
    on paid plans (Launch supports up to two protected branches per
    project; Scale up to five). The production branch still reports
    `protected=false`, `allowed_ips.ips=[]`,
    `protected_branches_only=false`, and
    `block_public_connections=false`. AC2 therefore cannot be truthfully
    closed until the account owner approves a plan/mechanism change. The
    repository does not silently substitute role-only isolation for the
    approved network restriction.
  - **Fly allowlist source:** Fly's shared egress ranges are not a fixed
    allowlist. The production platform and health probe each need an
    app-scoped static egress pair in `syd`
    (`fly ips allocate-egress --app <app> --region syd`); each IPv4 is
    currently $3.60/month and each pair supports up to 64 Machines. Those
    app-owned addresses are the allowlist inputs once Neon supports IP
    Allow on the selected plan.
  - **How to read the provider:** the live Neon API base is
    `https://console.neon.tech/api/v2` — `api.neon.tech` has no address
    records at all, so a request to it fails at DNS and looks like a
    provider outage. The API also requires an `org_id`
    (`org-dry-grass-92330972`, "Stoffer Industries"), which
    `GET /users/me/organizations` returns; `/projects` without it answers
    `org_id is required`. From an agent shell the read must bypass the
    egress proxy (`urllib` `build_opener(ProxyHandler({}))`, `curl
    --noproxy '*'`): Python 3.14 rejects the proxy's MITM leaf under
    `VERIFY_X509_STRICT`, while curl and Node succeed.
  - **Executable read-back (task `fb1240c0`, added 2026-11-16):** the facts
    in this section are readable in one command instead of by hand —
    `node infra/cloud/scripts/capture-production-provisioning-state.mjs
    --out <state-file>` captures the Neon, Fly (including its managed
    Upstash add-on), GitHub `production` Environment and Cloudflare state as a redacted artifact (names, flags and
    counts only), and `node
    tests/cloud/scripts/check-production-provisioning-state.mjs <state-file>`
    decides, per Slice D gate, whether the step is met and names the owner
    of the step that is not. A provider that cannot be read is an OPEN gate,
    not a skipped one, so a green run means the state was read — not that
    the state was never looked at.

### 6. Production deploy workflows (task `fb1240c0`)

This task ships the **staging** deploy workflow migration to the stable
hostname (slice 3, PR #775, merged 2026-10-08T10:28:43Z). The
**production** deploy workflows are not in scope for `5cb4a8fe`; they ship
with task `fb1240c0` as one consolidated pair, because production follows
the consolidated topology rather than one workflow per service. Quinn runs
the production deploy by dispatching those workflows against the production
GitHub environment.

| Workflow | Status | Owner |
| --- | --- | --- |
| `deploy-staging-tasks-api.yml` | Merged (PR #775) | Rowan |
| `deploy-staging-budget-api.yml` | Merged (PR #775) | Rowan |
| `deploy-staging-content-scheduler-api.yml` | Merged (PR #775) | Rowan |
| `deploy-staging-health-probe.yml` | Merged (PR #775) | Rowan |
| `deploy-production-platform.yml` | Shipped by task `fb1240c0` (PR #979, unmerged) — one consolidated production app, not one app per service | Rowan |
| `deploy-production-health-probe.yml` | Shipped by task `fb1240c0` (PR #979, unmerged) — the probe keeps its own app and its own gate | Rowan |

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
- `tests/cloud/scripts/check-production-blockers-register.mjs` — this
  register (the AC6 evidence artifact) stays in lockstep with the matrix:
  every surface with a production hostname has a row here, and the row
  carries the matrix's exact project/app identifier. Without it, a rename
  in the matrix could leave this file pointing an operator at a project
  that does not exist — which is exactly what happened, see §9.

Quinn does not need to remember "don't paste staging credentials into
production"; the static checks make it a CI failure, not a runtime one.

### 9. Observed state (live verification, 2026-11-13)

Everything below was read from the live control planes on 2026-11-13 (the
Vercel team, DNS, and direct TLS to each staging hostname). It is recorded
here because it contradicts parts of the contract above, and an operator
acting on the contract alone would hit a wall.

| Surface | Matrix contract | Observed 2026-11-13 | Consequence |
| --- | --- | --- | --- |
| Mission Control | Vercel project `sindustries-mission-control` (production), staging project `sindustries-mission-control-staging` | Project `sindustries-mission-control-staging` exists, holds the verified binding for `mission-control.staging.sindustries.co.nz` (bound + verified 2026-10-23T16:44Z), and now serves a deployment that carries the custom-domain alias — built from `main`, commit 7ba14896. The staging hostname presents a valid Let's Encrypt certificate (`CN=mission-control.staging.sindustries.co.nz`, issuer `Let's Encrypt CN=YR1`, valid 2026-11-13 → 2027-02-11) | **Closed.** The staging hostname resolves, serves a valid certificate and serves the rebuilt bundle. The 2026-11-11 gap — no deployment carrying the alias, no certificate — no longer holds |
| Tasks app | Vercel project `sindustries-tasks` (production), staging project `sindustries-tasks-app-staging` | Project `sindustries-tasks-app-staging` exists, holds the verified binding for `tasks.staging.sindustries.co.nz` (bound + verified 2026-10-23T16:44Z), and now serves a deployment that carries the custom-domain alias — built from `main`, commit 7ba14896. The staging hostname presents a valid Let's Encrypt certificate (`CN=tasks.staging.sindustries.co.nz`, issuer `Let's Encrypt CN=YR2`, valid 2026-11-13 → 2027-02-11) | **Closed.** Same shape as Mission Control |
| Mission Control / Tasks app (production) | Vercel projects `sindustries-mission-control` / `sindustries-tasks` | **Neither project exists** in the Vercel team, and there is no production Vercel project for either frontend | The production frontend hostnames have nothing to bind to yet |
| Tasks API / Budget API / Content Scheduler API / Health probe | Fly apps `sindustries-tasks-api` / `sindustries-budget-api` / `sindustries-content-scheduler-api` / `sindustries-health-probe` | All four staging hostnames resolve, present valid Let's Encrypt certificates whose CN/SAN is the stable hostname (valid 2026-11-10 → 2027-02-08), and answer HTTP 200 on their health endpoints — including `content-scheduler-api/api/v1/content-scheduler/auto-post/health` | The API half of AC2's certificate clause and AC5's API clauses are satisfied on the staging hostnames |
| Mission Control / Tasks app (build inputs) | Vercel env matrix supplies `VITE_*` base URLs per environment | The staging `VITE_*` values are set on both live staging projects, and the redeployed bundles carry them: `mission-control.staging.sindustries.co.nz` ships `/assets/index-C22LF23z.js` containing `https://tasks-api.staging.sindustries.co.nz/api/v1` and `https://content-scheduler-api.staging.sindustries.co.nz/api/v1`; `tasks.staging.sindustries.co.nz` ships `/assets/index-Cq7sZnj1.js` containing `https://tasks-api.staging.sindustries.co.nz/api/v1` | **Closed on the staging side.** The frontends call the stable staging API hostnames, not the provider-fallback siblings. The production projects still carry no values because they do not exist yet |

**Resolved decision — project model (Quinn, 2026-11-13).** The matrix and this
register named two Vercel projects that do not exist; the live staging
deployments sit under different project names. Quinn chose **(b) make the
contract match Vercel**:

- `infra/cloud/hostname-matrix.json` now names the staging projects —
  `sindustries-mission-control-staging` / `sindustries-tasks-app-staging` —
  as `vercelStagingProject`, and keeps `sindustries-mission-control` /
  `sindustries-tasks` as the production-side contract (unclaimed; to be
  provisioned by task `fb1240c0`).
- `infra/cloud/vercel-env-matrix.json` carries all four projects, each
  with exactly ONE environment — its own production deployment target —
  plus a `servesEnvironment` field that records whether that target
  serves the staging or the production hostname.
- The environment separation is modelled **per project**, not per
  `vercelEnvironments`: the two stable hostnames of a surface live in
  different projects, so no project needs a `preview` target.

Rationale: `sindustries-mission-control-staging` /
`sindustries-tasks-app-staging` already hold verified custom-domain
bindings since 2026-10-23T16:44Z. Migrating to the contract's old names
(both 404) would mean creating two new projects and re-binding two
working domains for no safety or clarity gain.

**Operator action — closed on the staging side (2026-11-13).** The
deployments that attach the custom-domain alias and provision the
certificate have landed: both staging projects were rebuilt from `main` and
redeployed, and both staging hostnames now serve a valid Let's Encrypt
certificate. No DNS record for the staging hostnames changed: they already
CNAME to `cname.vercel-dns.com` and resolve. The `mission-control-vercel`
branch named by `docs/specs/mission-control-vercel-deployment-tech-design.md`
was never created in the repository — the deployments were built from
`main` — so that design's branch is a historical reference, not an
operator step.

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

Blocker 9 is the one that gates the two frontend rows of blockers 1–3:
until the project model is decided, the frontend hostnames cannot be
bound to a project that the matrix names, so those rows cannot close.

---

## Related documents

- [`infra/cloud/hostname-matrix.json`](../../infra/cloud/hostname-matrix.json) — source-of-truth matrix.
- [`infra/cloud/vercel-env-matrix.json`](../../infra/cloud/vercel-env-matrix.json) — Vercel env var contract.
- [`tests/cloud/scripts/check-vercel-env-matrix.mjs`](../../tests/cloud/scripts/check-vercel-env-matrix.mjs) — Vercel env matrix static check.
- [`tests/cloud/scripts/check-production-blockers-register.mjs`](../../tests/cloud/scripts/check-production-blockers-register.mjs) — keeps this register in lockstep with the matrix.
- [`docs/specs/add-stable-app-name-hostnames-tech-design.md`](../specs/add-stable-app-name-hostnames-tech-design.md) — design.
- [`docs/systems/cloud-platform.md`](../systems/cloud-platform.md) — Cloud Platform handover doc.
