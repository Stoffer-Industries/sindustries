# Production hostname blockers — task `5cb4a8fe`

**Status:** The **infrastructure** for production hostnames is implemented, and
the production hostnames are live: every per-surface production hostname
resolves to the deployment the matrix names, presents a valid certificate and
serves traffic. The rows still marked `Pending` below are the
**operator-owned** setup steps Quinn and Tom must complete; each one names
the evidence needed to close it. A row is marked `Closed` only where the
work has landed and the evidence is recorded here or in
[`docs/cloud/production-provisioning-readback.md`](production-provisioning-readback.md).
Until an open row is closed, the production hostnames it covers either fail
DNS, fail TLS, or point at staging infrastructure.

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

For the **deploy procedure** see [Cloud Platform](../systems/cloud-platform.md) § "Deploy procedure (reference)".

**Last full live verification:** 2026-11-13 — see
[§9 — Observed state](#9-observed-state-live-verification-2026-11-13) for
what the DNS, TLS and Vercel control planes actually looked like on that
date, including the places where they disagree with the contract recorded
in sections 1–4.

**Targeted Slice D live re-read:** 2026-11-16 — Neon organization/plan,
project allowlist, production branch, Fly app inventory, Fly-managed Upstash database
inventory, GitHub `production` Environment inventory, Cloudflare DNS, and
production hostname resolution. The findings are recorded in §5 below.

**Production API hostname read-back:** 2026-11-18 — the four Fly-hosted
production surfaces were re-read (CNAME target, TLS certificate and health
response), which closes the four §1 DNS rows and the §2 API TLS row that
still read `Pending`. See
[§9](#9-observed-state-live-verification-2026-11-13).

---

## Blockers (must close before production cutover)

### 1. DNS — apex + per-hostname records

| Surface | Production hostname | Required DNS record | CNAME target (matrix contract) | Owner | Status |
| --- | --- | --- | --- | --- | --- |
| Apex | `sindustries.co.nz` | apex A/ALIAS to Vercel (frontends) or Fly (apis) | — | Quinn | Closed 2026-11-18 — the apex resolves to the Cloudflare-proxied A record and serves the SIndustries site over HTTPS (HTTP 200); the origin behind the proxy is not recorded in this repository |
| Mission Control | `mission-control.sindustries.co.nz` | CNAME → Vercel project `sindustries-mission-control` | `cname.vercel-dns.com` | Quinn | Closed 2026-11-18 — CNAME added, resolves to the matrix CNAME target |
| Tasks app | `tasks.sindustries.co.nz` | CNAME → Vercel project `sindustries-tasks` | `cname.vercel-dns.com` | Quinn | Closed 2026-11-18 — CNAME added, resolves to the matrix CNAME target |
| Tasks API | `tasks-api.sindustries.co.nz` | CNAME → consolidated Fly app `sindustries-platform-production` | `sindustries-platform-production.fly.dev` | Quinn | Closed 2026-11-18 — CNAME resolves to the matrix CNAME target and the hostname serves the production deployment; read-back in §9 |
| Budget API | `budget-api.sindustries.co.nz` | CNAME → consolidated Fly app `sindustries-platform-production` | `sindustries-platform-production.fly.dev` | Quinn | Closed 2026-11-18 — CNAME resolves to the matrix CNAME target and the hostname serves the production deployment; read-back in §9 |
| Content Scheduler API | `content-scheduler-api.sindustries.co.nz` | CNAME → consolidated Fly app `sindustries-platform-production` | `sindustries-platform-production.fly.dev` | Quinn | Closed 2026-11-18 — CNAME resolves to the matrix CNAME target and the hostname serves the production deployment; read-back in §9 |
| Health probe | `health-probe.sindustries.co.nz` | CNAME → Fly app `sindustries-health-probe-production` | `sindustries-health-probe-production.fly.dev` | Quinn | Closed 2026-11-18 — CNAME resolves to the matrix CNAME target and the hostname serves the production probe app; read-back in §9 |
| Auto-post worker | _(none — no public URL)_ | n/a — the worker has no HTTP surface | — | — | Not applicable |

**Notes:**
- The DNS provider was decided and OQ2 is closed: `sindustries.co.nz` is
  delegated to Cloudflare (`melnicoff.ns.cloudflare.com`,
  `tegan.ns.cloudflare.com`, verified live 2026-11-21). The apex record
  strategy is therefore Cloudflare's, not the providers': the apex is a
  Cloudflare-proxied A record, so the proxy fronts the Vercel and Fly
  origins and the origin behind the proxy is not recorded in this
  repository. The per-hostname entries are CNAMEs to the provider host named
  in the **CNAME target** column below, created at the Cloudflare DNS
  provider: `cname.vercel-dns.com` for the two Vercel frontends, and the
  `<app>.fly.dev` host for each Fly app.
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
- **The two production Vercel project names in this table exist as of
  2026-11-18** (task `5044e708`). The Vercel team contains four projects:
  the production `sindustries-mission-control` and `sindustries-tasks`,
  alongside the `sindustries-mission-control-staging` and
  `sindustries-tasks-app-staging` projects, which own the **staging**
  stable hostnames. The environment separation is therefore **per project**,
  not per Vercel environment — see
  [§9 — Observed state](#9-observed-state-live-verification-2026-11-13)
  for the live evidence and Quinn's 2026-11-13 project-model decision.
  The earlier note recording that the production projects did not exist is
  superseded: the two frontend rows above are live production
  instructions, not a "point DNS here" instruction for staging.

### 2. TLS certificates

| Surface | Production hostname | TLS strategy | Owner | Status |
| --- | --- | --- | --- | --- |
| Frontends (Vercel) | mission-control, tasks | Vercel issues the certificate via Let's Encrypt once a deployment carries the custom-domain alias | Quinn (trigger) | Closed 2026-11-18 — the first production deployments landed and both hostnames now present a valid Vercel-provisioned Let's Encrypt certificate (issuer Let's Encrypt CN=YR1; `mission-control.sindustries.co.nz` valid 2026-11-17 → 2027-02-15, `tasks.sindustries.co.nz` valid 2026-11-18 → 2027-02-16) |
| APIs (Fly) | tasks-api, budget-api, content-scheduler-api, health-probe | `fly certs add <hostname>` per Fly app (Let's Encrypt via Fly) | Quinn | Closed 2026-11-18 — each of the four hostnames presents a valid Let's Encrypt certificate whose CN is the stable hostname itself (Let's Encrypt CN=YE2, valid 2026-11-16 → 2027-02-14); read-back in §9 |

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
- Vercel issues the certificate for a custom domain when a deployment carries
  that domain's alias — adding the domain alone is not enough. Observed on
  2026-11-18: both production custom domains were added and reported
  verified, and the first production deployment of each frontend then
  landed, so both hostnames now carry a Vercel-provisioned Let's Encrypt
  certificate. The 1-minute propagation delay after the alias lands is
  the same as staging; deploy workflows already have a 20-attempt smoke loop
  that accommodates the latency (slice 3, AC4 enforcement).
- Fly `fly certs add` issues a Let's Encrypt cert for the hostname. The
  staging smoke loop is the same shape; production uses the same loop in
  the live staging deploy workflows — `deploy-staging-platform.yml` (the
  consolidated platform app) and `deploy-staging-health-probe.yml` (the
  health probe keeps its own app). The production pair
  (`deploy-production-platform.yml`, `deploy-production-health-probe.yml`)
  has since shipped **consolidated**, not cloned per service, in PR #979
  (merged 2026-11-17); see §6.

### 3. Vercel custom domain registration

For each Vercel project, add the production custom domain via the Vercel
dashboard or API. The contract is recorded in
[`infra/cloud/vercel-env-matrix.json`](../../infra/cloud/vercel-env-matrix.json);
the static check enforces the customDomain value matches the matrix.

| Matrix contract project | Custom domain (production) | Custom domain (staging) | Actually bound in Vercel (verified 2026-11-13) | Owner | Status |
| --- | --- | --- | --- | --- | --- |
| `sindustries-mission-control` | `mission-control.sindustries.co.nz` | `mission-control.staging.sindustries.co.nz` | `sindustries-mission-control-staging` (bound 2026-10-23, deployment + certificate verified 2026-11-13) | Quinn | Closed 2026-11-18 — production project created (Vercel project id `prj_ENmOURHrIHcj9YGaHfrS20HXDM1P`) and its production custom domain bound and verified; staging live |
| `sindustries-tasks` | `tasks.sindustries.co.nz` | `tasks.staging.sindustries.co.nz` | `sindustries-tasks-app-staging` (bound 2026-10-23, deployment + certificate verified 2026-11-13) | Quinn | Closed 2026-11-18 — production project created (Vercel project id `prj_yt715KyS0dbricuHwma7lR4Qv8vQ`) and its production custom domain bound and verified; staging live |

**Notes:**
- **Project model (Quinn, 2026-11-13):** the contract names FOUR Vercel
  projects, not two. `sindustries-mission-control` /
  `sindustries-tasks` are the **production** projects (created 2026-11-18);
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
| `sindustries-mission-control` | production (serves production) | `VITE_TASKS_API_BASE_URL` | `https://tasks-api.sindustries.co.nz/api/v1` | Quinn | Closed 2026-11-18 — set in the Vercel project; live-bundle readback confirms the value in the deployed bundle `/assets/index-C9KuN78k.js` with no staging URL present (AC4) |
| `sindustries-mission-control` | production (serves production) | `VITE_CONTENT_SCHEDULER_API_BASE_URL` | `https://content-scheduler-api.sindustries.co.nz/api/v1` | Quinn | Closed 2026-11-18 — set in the Vercel project; live-bundle readback confirms the value in the deployed bundle `/assets/index-C9KuN78k.js` with no staging URL present (AC4) |
| `sindustries-mission-control-staging` | production (serves staging) | `VITE_TASKS_API_BASE_URL` | `https://tasks-api.staging.sindustries.co.nz/api/v1` | Quinn | Set (verified in the live bundle 2026-11-13) |
| `sindustries-mission-control-staging` | production (serves staging) | `VITE_CONTENT_SCHEDULER_API_BASE_URL` | `https://content-scheduler-api.staging.sindustries.co.nz/api/v1` | Quinn | Set (verified in the live bundle 2026-11-13) |
| `sindustries-tasks` | production (serves production) | `VITE_TASKS_API_BASE_URL` | `https://tasks-api.sindustries.co.nz/api/v1` | Quinn | Closed 2026-11-18 — set in the Vercel project; live-bundle readback confirms the value in the deployed bundle `/assets/index-DQBKHpIW.js` with no staging URL present (AC4) |
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
  read-back stamped after the artifact was captured, is refused.
  All five read-backs are recorded in
  `production-provisioning-readback.md`, including Tom's confirmed
  prepaid/capped Fly billing method. The four non-spend read-backs are
  transcribed into the committed operator-evidence record, so a normal
  capture closes those four obligations without a manual flag. The
  `fly.spend-limit-before-public-exposure`
  gate enforces the order the approved design makes a hard gate: while a
  production hostname is published, the consolidated production platform
  app is running, or the production health-probe app is running, an
  artifact with no recorded spend-limit read-back fails.
- The ORDER itself is a second gate, `fly.spend-bound-ordering`: the
  capture records WHEN production became publicly exposed (the Cloudflare
  record's creation time, the production platform app's release creation
  time and the production probe app's release creation time), and the
  bound's read-back time is compared with it. The consolidated production
  platform app is exposure in its own right — every production API
  hostname points at it and it answers on its own `.fly.dev` hostname —
  so it can be publicly reachable before the first DNS record exists.
  Production DNS was published at 2026-11-16T10:12:23Z, the production
  platform app's current release was created at 2026-11-16T10:02:57Z and
  the production probe's current release at 2026-11-16T20:32:20Z, so a
  bound read back after
  that — which is what the approved prepaid/capped control will be — is an
  order violation and fails the gate. The order cannot be un-violated by
  recording, so the closure path is a recorded acceptance of the
  deviation (`flySpendOrderingDeviation`, the same value-free shape, with
  a pointer to the acceptance and the exposed surfaces it covers — every
  production hostname, the production health-probe app AND the
  consolidated production platform app) or a
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
      "readBackAt": "2026-11-17T07:38:00.000Z",
      "scope": "production app scope",
      "control": "prepaid-capped-billing-method",
      "evidenceRef": "docs/cloud/production-provisioning-readback.md",
      "targets": ["sindustries-platform-production"]
    },
    "neonSeparationDenialProof": {
      "recorded": true,
      "readBackAt": "2026-11-16T10:31:58.000Z",
      "scope": "operator read-back authored by Quinn in commit 9c2c2e8d",
      "evidenceRef": "docs/cloud/production-provisioning-readback.md",
      "targets": ["production", "staging", "dev"]
    },
    "productionProbeInterval": {
      "recorded": true,
      "readBackAt": "2026-11-16T10:31:58.000Z",
      "scope": "operator read-back authored by Quinn in commit 9c2c2e8d",
      "evidenceRef": "docs/cloud/production-provisioning-readback.md",
      "targets": ["sindustries-health-probe-production"]
    },
    "productionApiHealthResponses": {
      "recorded": true,
      "readBackAt": "2026-11-16T10:31:58.000Z",
      "scope": "operator read-back authored by Quinn in commit 9c2c2e8d",
      "evidenceRef": "docs/cloud/production-provisioning-readback.md",
      "targets": [
        "tasks-api.sindustries.co.nz",
        "budget-api.sindustries.co.nz",
        "content-scheduler-api.sindustries.co.nz"
      ]
    },
    "dnsResolutionAndTlsReadback": {
      "recorded": true,
      "readBackAt": "2026-11-16T10:31:58.000Z",
      "scope": "operator read-back authored by Quinn in commit 9c2c2e8d",
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
- The production Neon branch carries the three service schemas and one
  write-capable, schema-confined role per schema. Staging and dev credentials
  were both refused against the production endpoint. Tom decided on
  2026-11-18 to remain on Neon Free and accept schema-scoped service-role
  isolation as AC2's connectivity control; the repository records that
  decision and does **not** claim an IP allowlist exists.
- Redis is two separate Fly-managed Upstash Pay-as-you-go add-ons in `syd`:
  `sindustries-staging` and `sindustries-production`. The direct-Upstash
  staging database was retired after staging was repointed and health-checked.
  The manifest's `redisAddon` entries are the source of truth.
  - **Provider-plan decision (resolved 2026-11-18):** the Neon organization
    `Stoffer Industries` reports `plan=free`. Neon makes IP Allow a
    **Scale-plan** feature, so the production account cannot express a
    non-empty allowlist. Tom decided to remain on Free and re-specified
    AC2 around `schema-scoped-service-roles`: one write-capable,
    schema-scoped login role per production schema plus denied staging/dev
    connections. The repository records the accepted control and reports the
    IP-allowlist gates as not applicable, not met.
  - **Abandoned Fly allowlist source:** Fly's shared egress ranges are not
    a fixed allowlist, so the original plan used app-scoped static egress
    pairs. Quinn allocated one pair for each production app on 2026-11-18
    (operator read-back recorded in the task thread, before the plan
    decision was settled). The addresses are no longer required by AC2 and
    are a cleanup candidate if neither app needs app-scoped static egress
    for another purpose. Deallocation remains a separate operator action;
    the provisioning checker does not treat it as an AC2 blocker.
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

Neither environment has one deploy workflow per service. Staging deploys the
consolidated platform app, production follows the same consolidated topology,
and the health probe keeps its own app and its own workflow in both.

The live staging deploy surfaces are `deploy-staging-platform.yml` (the
consolidated platform app, added by PR #920) and
`deploy-staging-health-probe.yml` (the health probe's own app, added by PR
#756); `.github/workflows/ci.yml` calls only these two. The per-service
staging workflows were retired at the 2026-11-07 consolidation (task
`219fb673`): their deploy jobs were removed from `ci.yml` on that date and
their Fly apps were destroyed, so the four files are `workflow_call`-only with
no caller. They stay in the tree until the §5 cleanup in
`docs/runbooks/platform-consolidation-rollback.md` deletes them.
`tests/cloud/scripts/check-deploy-workflow-stable-hostname.mjs` still requires
three of them (tasks-api, budget-api, content-scheduler-api) to exist.

The **production** deploy workflows were not in scope for `5cb4a8fe`; they
shipped with task `fb1240c0` as one consolidated pair, because production
follows the consolidated topology rather than one workflow per service, and
they merged on 2026-11-17. Quinn runs the production deploy by dispatching
those workflows against the production GitHub environment.

The two Vercel frontends are not part of that consolidated Fly topology and
deploy through their own workflow, `deploy-production-vercel-frontends.yml`
(PR #1017, merged 2026-11-18). It declares both `workflow_dispatch` and
`workflow_call`, but nothing in `.github/workflows/` calls it, so each
frontend is deployed by a manual dispatch that selects one surface, and each
dispatch verifies the stable hostname, the TLS certificate and the live
bundle against the production values.

| Workflow | Status | Owner |
| --- | --- | --- |
| `deploy-staging-platform.yml` | Live staging deploy surface — the consolidated platform app (PR #920; stable-hostname migration PR #775) | Rowan |
| `deploy-staging-health-probe.yml` | Live staging deploy surface — the health probe keeps its own app (PR #756; stable-hostname migration PR #775) | Rowan |
| `deploy-staging-tasks-api.yml` | Retired at the 2026-11-07 consolidation — `workflow_call`-only, no caller, Fly app destroyed; retained pending the §5 cleanup | Rowan |
| `deploy-staging-budget-api.yml` | Retired at the 2026-11-07 consolidation — `workflow_call`-only, no caller, Fly app destroyed; retained pending the §5 cleanup | Rowan |
| `deploy-staging-content-scheduler-api.yml` | Retired at the 2026-11-07 consolidation — `workflow_call`-only, no caller, Fly app destroyed; retained pending the §5 cleanup | Rowan |
| `deploy-production-platform.yml` | Merged (PR #979, 2026-11-17) — one consolidated production app, not one app per service | Rowan |
| `deploy-production-health-probe.yml` | Merged (PR #979, 2026-11-17) — the probe keeps its own app and its own gate | Rowan |
| `deploy-production-vercel-frontends.yml` | Live production deploy surface — the manually dispatched Vercel frontend deploy for Mission Control and the Tasks app (PR #1017, 2026-11-18); one surface per dispatch | Rowan |

### 7. Production smoke + cutover (separate task)

| Activity | Owner | Status | Tracking |
| --- | --- | --- | --- |
| Production smoke against stable hostnames (mirroring `cloud-staging-validate.yml`) | Rowan + Quinn | Not started | Separate task |
| Production cutover with rollback verification | Quinn + Tom | Not started | Task `020f423e` (Execute production cloud cutover) |
| Production data migration with verified backup + restore | Quinn + Tom | Not started | Task `f2c23e26` |

The cutover's readiness is machine-checked rather than asserted: `tests/cloud/scripts/check-production-cutover-readiness.mjs` decides, from the redacted production state capture, whether the `production` Environment refuses an unapproved dispatch, whether every cutover DSN secret is registered on it, and whether the production Neon environment serves the three distinct databases the cutover needs (source, empty destination, recovery) — counted as databases, not as endpoint hosts, because a read replica is another address for the same database — and names the owner of each unmet gate. The procedure is in [`docs/runbooks/production-data-migration-restore.md`](../runbooks/production-data-migration-restore.md) §3.

**Verified live state (2026-11-19T18:26Z capture, re-confirmed directly against the GitHub API):** the cutover is **NOT dispatchable**. The capture is schema 13 and the checker exits 1, naming three unmet gates, all owned by Quinn (operator):

| Gate | Live state | What closes it |
| --- | --- | --- |
| `github.production-environment-captured` | **MET** — the `production` Environment was readable | — |
| `github.cutover-dsn-secrets` | **UNMET** — the Environment carries 7 secrets and **none** of the six cutover DSNs | register `TASKS_API_SOURCE_DSN`, `BUDGET_API_SOURCE_DSN`, `TASKS_API_DEST_DSN`, `BUDGET_API_DEST_DSN`, `RECOVERY_TASKS_API_DSN`, `RECOVERY_BUDGET_API_DSN` on the Environment |
| `github.production-approval-gate` | **UNMET** — `protection_rules: []`, `requiredReviewerCount: 0`, `canAdminsBypass: true`, so a dispatch starts unapproved | give the `production` Environment at least one required reviewer and turn off admin bypass |
| `neon.cutover-destination-database` | **MET** — the production Neon environment serves **1** distinct database (`neondb`, the only database on the `production` branch), and the destination is that EXISTING production database: no new permanent production database is created for this cutover. The recovery target is a temporary, isolated database, and its isolation is enforced at dispatch (the drill refuses a recovery DSN that shares a host with the source or the destination) | none for the database count. The recovery target still has to exist as a registered DSN secret pointing at its own endpoint (Quinn, operator) |

The DSN secrets cannot be registered against databases that do not exist, so the third row gates the second: the database capacity has to close before the DSNs can point at real destinations. The `staging` branch still serves its three databases (`neondb`, `sindustries_staging_neondb`, `sindustries_staging_neondb_recovery`) because the drill drops the service SCHEMAS, not the databases — but all three share one endpoint host, so that topology does not transplant to production.

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
| Mission Control / Tasks app (production) | Vercel projects `sindustries-mission-control` / `sindustries-tasks` | **Both projects exist** as of 2026-11-18 — `prj_ENmOURHrIHcj9YGaHfrS20HXDM1P` and `prj_yt715KyS0dbricuHwma7lR4Qv8vQ`, read back from the Vercel API — and each production custom domain is bound and verified. Each project now also carries a production deployment, so both hostnames present a Vercel-provisioned Let's Encrypt certificate | **Closed.** Project, custom domain, DNS, TLS certificate and live bundle are all in place; see the deployment readback below |
| Tasks API / Budget API / Content Scheduler API / Health probe | Fly apps `sindustries-tasks-api` / `sindustries-budget-api` / `sindustries-content-scheduler-api` / `sindustries-health-probe` | All four staging hostnames resolve, present valid Let's Encrypt certificates whose CN/SAN is the stable hostname (valid 2026-11-10 → 2027-02-08), and answer HTTP 200 on their health endpoints — including `content-scheduler-api/api/v1/content-scheduler/auto-post/health` | The API half of AC2's certificate clause and AC5's API clauses are satisfied on the staging hostnames |
| Mission Control / Tasks app (build inputs) | Vercel env matrix supplies `VITE_*` base URLs per environment | The staging `VITE_*` values are set on both live staging projects, and the redeployed bundles carry them: `mission-control.staging.sindustries.co.nz` ships `/assets/index-C22LF23z.js` containing `https://tasks-api.staging.sindustries.co.nz/api/v1` and `https://content-scheduler-api.staging.sindustries.co.nz/api/v1`; `tasks.staging.sindustries.co.nz` ships `/assets/index-Cq7sZnj1.js` containing `https://tasks-api.staging.sindustries.co.nz/api/v1`. The production bundles carry the production values: `mission-control.sindustries.co.nz` ships `/assets/index-C9KuN78k.js` containing both production API base URLs, and `tasks.sindustries.co.nz` ships `/assets/index-DQBKHpIW.js` containing the production Tasks API base URL | **Closed on both sides.** The staging frontends call the stable staging API hostnames and the production frontends call the stable production API hostnames — neither carries the other's URLs. The production live-bundle readback is recorded below |

**Resolved decision — project model (Quinn, 2026-11-13).** The matrix and this
register named two Vercel projects that did not exist; the live staging
deployments sit under different project names. Quinn chose **(b) make the
contract match Vercel**:

- `infra/cloud/hostname-matrix.json` now names the staging projects —
  `sindustries-mission-control-staging` / `sindustries-tasks-app-staging` —
  as `vercelStagingProject`, and keeps `sindustries-mission-control` /
  `sindustries-tasks` as the production-side contract (provisioned
  2026-11-18 under task `5044e708`).
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

#### Production frontend provisioning (observed 2026-11-18)

Task `5044e708` provisioned the two production Vercel projects and their
custom domains. The operator evidence is the `[quinn-operator-evidence]`
comment on that task (2026-11-17T21:43:57Z); the readback below is
independent of it and was taken from the Vercel API and public DNS on
2026-11-18.

| Surface | Contract | Observed 2026-11-18 | Consequence |
| --- | --- | --- | --- |
| Mission Control | Vercel project `sindustries-mission-control` | Project `prj_ENmOURHrIHcj9YGaHfrS20HXDM1P` exists (Vercel API readback), serving root directory apps/mission-control; production custom domain `mission-control.sindustries.co.nz` bound and verified; its CNAME resolves to `cname.vercel-dns.com`; a production deployment carries the custom-domain alias, so a Let's Encrypt certificate is issued | **Closed.** Project, domain, DNS, certificate and live bundle are all in place |
| Tasks app | Vercel project `sindustries-tasks` | Project `prj_yt715KyS0dbricuHwma7lR4Qv8vQ` exists (Vercel API readback), serving root directory apps/tasks; production custom domain `tasks.sindustries.co.nz` bound and verified; its CNAME resolves to `cname.vercel-dns.com`; a production deployment carries the custom-domain alias, so a Let's Encrypt certificate is issued | Same shape as Mission Control |

#### Production frontend deployment (observed 2026-11-18)

The first production deployment of each frontend landed through
`.github/workflows/deploy-production-vercel-frontends.yml`
(`workflow_dispatch`: surface `mission-control` at 2026-11-18T00:56Z,
surface `tasks-app` at 2026-11-18T00:58Z). Both runs are green, and each
run's final step verifies the stable hostname, the TLS certificate and the
live bundle against the production values.

| Surface | Deploy run | TLS certificate | Live bundle |
| --- | --- | --- | --- |
| Mission Control | run 44211890571 — Hostname mission-control.sindustries.co.nz does match certificate | Let's Encrypt CN=YR1, CN=mission-control.sindustries.co.nz, valid 2026-11-17 → 2027-02-15 | `/assets/index-C9KuN78k.js` carries both production API base URLs; no staging URL present |
| Tasks app | run 44212111149 — Hostname tasks.sindustries.co.nz does match certificate | Let's Encrypt CN=YR1, CN=tasks.sindustries.co.nz, valid 2026-11-18 → 2027-02-16 | `/assets/index-DQBKHpIW.js` carries the production Tasks API base URL; no staging URL present |

The live-bundle readback is `tests/cloud/scripts/verify-live-vercel-bundle.mjs`:
it asserts that every expected production value is present in the deployed
bundle and that no staging hostname leaks into it. Both surfaces pass —
`{"surface":"mission-control","url":"https://mission-control.sindustries.co.nz/","assets":1,"expectedValues":2}`
and `{"surface":"tasks-app","url":"https://tasks.sindustries.co.nz/","assets":1,"expectedValues":1}`.

#### Production API hostname read-back (observed 2026-11-18)

The four Fly-hosted production surfaces were re-read on 2026-11-18 — CNAME
target, TLS certificate and health response — which closes the four §1 DNS
rows and the §2 API TLS row that still read `Pending`. The closure evidence
is the operator read-back in
[`docs/cloud/production-provisioning-readback.md`](production-provisioning-readback.md)
§4: resolution read from two independent public resolvers, CNAME targets
read back from Cloudflare, and a certificate whose CN is the stable hostname.
The table below is an independent read-back of the same state.

| Surface | Matrix contract | Observed 2026-11-18 | Consequence |
| --- | --- | --- | --- |
| Tasks API | CNAME → consolidated Fly app `sindustries-platform-production` → `sindustries-platform-production.fly.dev` | CNAME `sindustries-platform-production.fly.dev`; certificate CN `tasks-api.sindustries.co.nz` (Let's Encrypt CN=YE2, valid 2026-11-16 → 2027-02-14); `/health` HTTP 200 | **Closed.** The hostname resolves to the production deployment and serves production traffic |
| Budget API | CNAME → consolidated Fly app `sindustries-platform-production` → `sindustries-platform-production.fly.dev` | CNAME `sindustries-platform-production.fly.dev`; certificate CN `budget-api.sindustries.co.nz` (Let's Encrypt CN=YE2, valid 2026-11-16 → 2027-02-14); `/health` HTTP 200 | **Closed.** Same shape as the Tasks API |
| Content Scheduler API | CNAME → consolidated Fly app `sindustries-platform-production` → `sindustries-platform-production.fly.dev` | CNAME `sindustries-platform-production.fly.dev`; certificate CN `content-scheduler-api.sindustries.co.nz` (Let's Encrypt CN=YE2, valid 2026-11-16 → 2027-02-14); `/health` HTTP 200 | **Closed.** Same shape as the Tasks API |
| Health probe | CNAME → Fly app `sindustries-health-probe-production` → `sindustries-health-probe-production.fly.dev` | CNAME `sindustries-health-probe-production.fly.dev`; certificate CN `health-probe.sindustries.co.nz` (Let's Encrypt CN=YE2, valid 2026-11-16 → 2027-02-14); `/healthz` HTTP 200 | **Closed.** The hostname resolves to the production probe app |
| Apex | `sindustries.co.nz` | Resolves to the Cloudflare-proxied A record; HTTPS serves the SIndustries site (HTTP 200) | **Closed.** The apex resolves to the real deployment; the origin behind the proxy is not recorded in this repository |

Every observed CNAME equals the matrix's `cnameTargets.production` value, and
every certificate's CN is the stable hostname itself, so no production
hostname resolves to a staging deployment.

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

Blocker 9 gated the two frontend rows of blockers 1–3: until the project
model was decided, the frontend hostnames could not be bound to a project
that the matrix names. That gate is closed — the project model was decided
on 2026-11-13 and the production projects were provisioned on 2026-11-18 —
so the two frontend rows of blockers 1–3 are now closed on the evidence
recorded in §9.

---

## Related documents

- [`infra/cloud/hostname-matrix.json`](../../infra/cloud/hostname-matrix.json) — source-of-truth matrix.
- [`infra/cloud/vercel-env-matrix.json`](../../infra/cloud/vercel-env-matrix.json) — Vercel env var contract.
- [`tests/cloud/scripts/check-vercel-env-matrix.mjs`](../../tests/cloud/scripts/check-vercel-env-matrix.mjs) — Vercel env matrix static check.
- [`tests/cloud/scripts/check-production-blockers-register.mjs`](../../tests/cloud/scripts/check-production-blockers-register.mjs) — keeps this register in lockstep with the matrix.
- [`docs/specs/add-stable-app-name-hostnames-tech-design.md`](../specs/add-stable-app-name-hostnames-tech-design.md) — design.
- [`docs/systems/cloud-platform.md`](../systems/cloud-platform.md) — Cloud Platform handover doc.
