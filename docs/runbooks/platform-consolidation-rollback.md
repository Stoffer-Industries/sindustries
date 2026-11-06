# Platform consolidation — cutover and backout runbook

Task `219fb673` — consolidate tasks-api, budget-api, auto-post-worker and
content-scheduler-api onto one Fly staging Machine.

This runbook is the operator-facing half of the consolidation. The design is
`docs/specs/fly-staging-service-consolidation-tech-design.md` (approved by
Quinn, 2026-11-05). The system-level description is
`docs/systems/cloud-platform.md` §"Shared-fate topology (staging)".

---

## 1. What changes

| Before | After |
| --- | --- |
| `sindustries-tasks-api-staging` — 1 Machine | `sindustries-platform-staging` — 1 Machine |
| `sindustries-budget-api-staging` — 1 Machine | ├─ tasks-api — 127.0.0.1:4001 |
| `sindustries-content-scheduler-api-staging` — 1 Machine | ├─ budget-api — 127.0.0.1:4002 |
| `sindustries-auto-post-worker-staging` — 1 Machine | ├─ content-scheduler-api — 127.0.0.1:4003 |
| | ├─ auto-post-worker — queue-bound, no listener |
| | └─ nginx router — 0.0.0.0:8080 (Fly 443 → 8080) |

**Shared fate.** One Machine means one crash domain. A deploy restarts all
four services. Per-service scaling is impossible. Rollback is app-wide.
This is the deliberate trade the consolidation makes — the four-machine
staging footprint is replaced by one.

---

## 2. Prerequisites (all external to this repo)

1. **Fly app + secrets — provisioned by CI.** The consolidated app
   `sindustries-platform-staging` and its twelve app-level `PLATFORM_*`
   secrets are created by `.github/workflows/deploy-staging-platform.yml`,
   which maps the staging GitHub environment secrets onto the platform
   names (`infra/cloud/platform/platform-provision-secrets.mjs`). The app
   is created if it does not exist, and the secrets are registered with it,
   so the app is never deployable without them. The mapping table and the
   source of record are documented in `docs/systems/cloud-platform.md`
   §"Platform secret provisioning".

   The deploy itself is **opt-in**: set the staging environment variable
   `STAGING_PLATFORM_DEPLOY_ENABLED=true` to enable it. It is off by
   default because the platform's auto-post worker would otherwise start
   consuming the BullMQ queue while the old worker app is still running —
   step 2 below is the order that avoids that.

2. **Remaining per-service secrets.** Every other per-service secret
   (`TASKS_API_*`, `BUDGET_API_*`, `AKAHU_*`, `X_*`, `CONTENT_SCHEDULER_API_*`,
   `DEV_SESSION_SECRET`, …) is inherited by every child through the app
   environment. The live staging apps carry only two of them — the two
   approval-service credentials — and the rest are unset, so staging runs
   on the code defaults today. The provisioning step registers exactly
   those two and nothing else, so the platform matches the live apps
   rather than the wider env-example contract.
3. **DNS.** The three stable hostnames must resolve to the platform app's
   `*.fly.dev` name, and each needs a certificate:

   ```
   fly certs add tasks-api.staging.sindustries.co.nz            --app sindustries-platform-staging
   fly certs add budget-api.staging.sindustries.co.nz           --app sindustries-platform-staging
   fly certs add content-scheduler-api.staging.sindustries.co.nz --app sindustries-platform-staging
   ```

   **This is blocked today.** It needs a Cloudflare token with
   `Zone:DNS:Edit` on `sindustries.co.nz` (zone id
   `0f39d3030163fed274d76185b71b21d4`), which only Tom holds — the token on
   this machine is read-only. Tracked by task `5cb4a8fe`, with Tom at
   `attentionOwners[0]`.

   Until DNS lands, the platform is still fully usable through the
   provider hostname's path-prefix routes:

   ```
   https://sindustries-platform-staging.fly.dev/tasks-api/health
   https://sindustries-platform-staging.fly.dev/budget-api/health
   https://sindustries-platform-staging.fly.dev/content-scheduler-api/health
   ```

---

## 3. Cutover sequence

Run in this order. Each step is verifiable before the next one starts.

### Step 1 — deploy the platform app (no traffic yet)

```
infra/cloud/bin/deploy platform
```

The app comes up on its provider hostname; the three stable hostnames still
point at the old apps, so nothing user-visible changes. Verify:

```
curl -fsS https://sindustries-platform-staging.fly.dev/tasks-api/health
curl -fsS https://sindustries-platform-staging.fly.dev/budget-api/health
curl -fsS https://sindustries-platform-staging.fly.dev/content-scheduler-api/health
curl -fsS https://sindustries-platform-staging.fly.dev/__status
```

`/__status` returns the supervisor's view: each child's pid, state,
restart count, last exit code, RSS and heartbeat.

### Step 2 — scale the old apps to zero (NOT down)

```
fly scale count 0 --app sindustries-auto-post-worker-staging
fly scale count 0 --app sindustries-content-scheduler-api-staging
fly scale count 0 --app sindustries-budget-api-staging
fly scale count 0 --app sindustries-tasks-api-staging
```

**Scale to zero; do not delete the apps.** They are the fast backout path.

**Order matters:** the auto-post worker must be stopped before the
consolidated app starts consuming the queue. Scaling all four to zero at
the same time creates a brief window where neither the old worker nor the
new one is running — acceptable for staging, but do it deliberately.

### Step 3 — move the CNAMEs

Point `tasks-api`, `budget-api` and `content-scheduler-api` CNAMEs at
`sindustries-platform-staging.fly.dev`. This is the Cloudflare step that is
blocked on Tom's token.

### Step 4 — verify on the stable hostnames

```
curl -fsS https://tasks-api.staging.sindustries.co.nz/health
curl -fsS https://budget-api.staging.sindustries.co.nz/health
curl -fsS https://content-scheduler-api.staging.sindustries.co.nz/health
```

### Step 5 — re-point the health probe

The probe's metric labels stay `tasks-api`, `budget-api`,
`content-scheduler-api` — they are operator-supplied strings, not Fly app
names, so the metric contract does not change. Only the probe's **target
URLs** move to the stable hostnames. Quinn owns the probe's secrets.

### Step 6 — record the cost evidence (AC4)

Before scaling the old apps down, capture the baseline:

```
for app in sindustries-tasks-api-staging sindustries-budget-api-staging \
           sindustries-content-scheduler-api-staging sindustries-auto-post-worker-staging; do
  fly machine list --app "$app"
done
```

After the platform is up:

```
fly machine list --app sindustries-platform-staging
```

Attach both to the task. Re-derive the monthly figure from Fly's live
billing API — **do not quote the task spec's $26.80 → $6.70 figures**;
those assumed four 1GB machines' worth of headroom fits in one 1GB
Machine, and the consolidated Machine is sized at 2GB.

---

## 4. Backout

Two different failures need two different responses.

### The image is bad (inside the platform app)

```
fly releases rollback --app sindustries-platform-staging
```

This rolls the platform app back one release. It does **not** move traffic
— the stable hostnames still point at the platform app.

### The platform app itself must go

1. Point the three CNAMEs back at the old apps:
   - `tasks-api.staging.sindustries.co.nz` → `sindustries-tasks-api-staging.fly.dev`
   - `budget-api.staging.sindustries.co.nz` → `sindustries-budget-api-staging.fly.dev`
   - `content-scheduler-api.staging.sindustries.co.nz` → `sindustries-content-scheduler-api-staging.fly.dev`

   DNS only; ~minutes of TTL.

2. Scale the old apps back up:

   ```
   fly scale count 1 --app sindustries-tasks-api-staging
   fly scale count 1 --app sindustries-budget-api-staging
   fly scale count 1 --app sindustries-content-scheduler-api-staging
   fly scale count 1 --app sindustries-auto-post-worker-staging
   ```

3. Scale the platform app to zero:

   ```
   fly scale count 0 --app sindustries-platform-staging
   ```

**Keep the old apps deployable for the duration of the soak.** They are the
backout, and they are cheap to keep around for a staging environment.

---

## 5. Cutover checklist

Everything in this list is a step that must be removed or flipped once the
cutover has happened — they are transitional guards, not permanent
configuration.

- [ ] **Remove the app-existence guard** in
      `.github/workflows/deploy-staging-platform.yml` (the
      "Check that the platform app is provisioned" step). It exists only so
      CI does not fail before the app exists; after cutover the app must
      always exist, and a missing app should fail the deploy loudly.
- [ ] **Remove the four per-service path filters** from the `changes` job in
      `.github/workflows/ci.yml` (`tasks_api`, `budget_api`,
      `content_scheduler_api`, `auto_post_worker`) and replace them with the
      single `platform` filter. The four are kept until the cutover lands
      because a filter change on `main` redeploys.
- [ ] **Remove the four per-service deploy jobs** from `.github/workflows/ci.yml`
      (`deploy-tasks-api-staging`, `deploy-budget-api-staging`,
      `deploy-content-scheduler-api-staging`, `deploy-auto-post-worker-staging`).
- [ ] **Update `infra/cloud/hostname-matrix.json`** so the three API
      surfaces' `flyApp` records the consolidated app. This is deliberately
      NOT done in the implementation PR: the matrix records which app
      *serves* each hostname, and that only becomes true when the CNAMEs
      move. Changing it earlier would make the source of truth lie about
      live traffic.
- [ ] **Delete the four per-service `infra/cloud/fly/*.fly.toml` files and
      the four per-service Dockerfiles** once nothing references them.
- [ ] **Delete the four per-service deploy workflows**
      (`.github/workflows/deploy-staging-{tasks-api,budget-api,content-scheduler-api,auto-post-worker}.yml`).
      The static check `tests/cloud/scripts/check-deploy-workflow-stable-hostname.mjs`
      requires them to exist — update that check in the same change.
- [ ] **Remove the `platform` app's own `PLATFORM_*` secret indirection** if
      the three Redis instances turn out to be identical (one-line change in
      `infra/cloud/platform/platform-services.mjs` plus a secret rename).

---

## 6. Where things live

| Thing | Path |
| --- | --- |
| Supervisor (entrypoint) | `infra/cloud/platform/platform-supervisor.mjs` |
| Service registry + env mapping | `infra/cloud/platform/platform-services.mjs` |
| Router config | `infra/cloud/platform/nginx.conf` |
| Migration chain | `infra/cloud/platform/platform-migrate.mjs` |
| Image | `infra/cloud/docker/platform.Dockerfile` |
| Fly app spec | `infra/cloud/fly/platform.fly.toml` |
| Deploy workflow | `.github/workflows/deploy-staging-platform.yml` |
| Secrets contract | `infra/cloud/env/platform.env.example` |
| Supervisor unit tests | `infra/cloud/platform/tests/platform-supervisor.test.mjs` |
| Design | `docs/specs/fly-staging-service-consolidation-tech-design.md` |
| System doc | `docs/systems/cloud-platform.md` |
