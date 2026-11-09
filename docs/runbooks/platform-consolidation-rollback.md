# Platform consolidation — cutover and backout runbook

Task `219fb673` — consolidate tasks-api, budget-api, auto-post-worker and
content-scheduler-api onto one Fly staging Machine.

This runbook is the operator-facing half of the consolidation. The design is
`docs/specs/fly-staging-service-consolidation-tech-design.md` (approved by
Quinn, 2026-11-05). The system-level description is
`docs/systems/cloud-platform.md` §"Shared-fate topology (staging)".

> **Status: the app-level cutover was executed on 2026-11-07; the DNS
> steps did not run.** Section 3 records the sequence as it was run, except
> for steps 3, 4 and 7 — moving the CNAMEs, verifying on the stable
> hostnames and re-pointing the health probe — which did not run and remain
> blocked on task `5cb4a8fe`. Traffic today reaches the platform only via
> the `*.fly.dev` fallback hostnames; the stable
> `*.staging.sindustries.co.nz` records do not resolve. The four
> per-service staging Fly apps
> (`sindustries-tasks-api-staging`, `sindustries-budget-api-staging`,
> `sindustries-content-scheduler-api-staging`,
> `sindustries-auto-post-worker-staging`) were **destroyed ahead of the
> cutover**, so the per-app backout that section 3 planned for no longer
> exists. Verified 2026-11-10: `flyctl apps list` shows only
> `sindustries-platform-staging` and `sindustries-health-probe-staging`, and
> the four retired `*.fly.dev` hosts still resolve to Fly's proxy but answer
> HTTP 502 because no app is behind them. Section 4 states the backout that
> exists now.

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
   step 1 below is the order that avoids that: the old worker is scaled to
   zero BEFORE the platform is deployed.

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

## 3. Cutover sequence (executed 2026-11-07 at the app level; steps 3, 4 and 7 not run)

Run in this order. Each step is verifiable before the next one starts.

**The invariant: the old auto-post worker is scaled to zero BEFORE the
platform is deployed.** The platform's auto-post worker is a SECOND
consumer of the same BullMQ queue as `sindustries-auto-post-worker-staging`,
and two consumers process every scheduled post twice. Step 1 stops the old
consumer; step 2 starts the new one. The deploy itself is opt-in
(`STAGING_PLATFORM_DEPLOY_ENABLED`), and the opt-in is flipped only after
step 1 is done and verified — so the order cannot be inverted by accident.

### Step 1 — stop the old queue consumer (scale to zero, NOT down)

```
fly scale count worker=0 --app sindustries-auto-post-worker-staging --yes
```

The process group is named, because `fly scale count 0 --app <app>` without
one defaults to a group called `app` and fails on an app whose group is
named differently ("Attempting to scale unknown process groups [app] but
valid names are [worker]"). `--yes` is required outside an interactive
terminal.

Verify that no Machine is left running:

```
fly machine list --app sindustries-auto-post-worker-staging
```

**Scale to zero; do not delete the app.** It was the fast backout path — the
app was destroyed ahead of the cutover, so that path no longer exists (see
section 4).

### Step 2 — deploy the platform app through the gated CI path

The platform is deployed by `.github/workflows/deploy-staging-platform.yml`:
the workflow provisions the app and its twelve secrets, and deploys only
when the staging environment variable `STAGING_PLATFORM_DEPLOY_ENABLED` is
`true`. That variable is the single opt-in for the cutover — flip it in the
staging GitHub environment, then re-run the deploy workflow.

The operator path `infra/cloud/bin/deploy platform` is gated by the same
variable, so it cannot be used to bypass this order, but it is not the
documented route: the CI path is the one that provisions the app's secrets
before the deploy.

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

### Step 5 — record the cost evidence (AC4)

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

### Step 6 — scale the remaining old apps to zero (NOT down)

```
fly scale count content-scheduler-api=0 --app sindustries-content-scheduler-api-staging --yes
fly scale count app=0 --app sindustries-budget-api-staging --yes
fly scale count app=0 --app sindustries-tasks-api-staging --yes
```

The three apps were destroyed ahead of the cutover rather than scaled to
zero, and because the CNAMEs never moved there was no traffic to hand
over. The auto-post worker was scaled in step 1, before the platform was
deployed.

**Scale to zero; do not delete the apps.** They were the fast backout path —
the apps were destroyed ahead of the cutover, so that path no longer exists
(see section 4).

### Step 7 — re-point the health probe

The probe's metric labels stay `tasks-api`, `budget-api`,
`content-scheduler-api` — they are operator-supplied strings, not Fly app
names, so the metric contract does not change. Only the probe's **target
URLs** move to the stable hostnames. Quinn owns the probe's secrets.

---

## 4. Backout

Two different failures need two different responses.

> **The per-app backout no longer exists.** The four per-service staging apps
> were destroyed ahead of the 2026-11-07 cutover (verified 2026-11-10:
> `flyctl apps list` shows only `sindustries-platform-staging` and
> `sindustries-health-probe-staging`). The "the platform app itself must go"
> procedure below therefore has **no per-app fallback**: there is nothing to
> move the DNS back to and nothing to scale back up. Restoring per-service
> hosting is a forward remediation — re-create the apps and redeploy them —
> not a backout, and it is not covered by this runbook. The stable staging
> hostnames are not created either (the operator-owned DNS step in task
> `5cb4a8fe` is still open), so there is no traffic to move back.

### The image is bad (inside the platform app)

```
fly releases rollback --app sindustries-platform-staging
```

This rolls the platform app back one release. It does **not** move traffic
— the stable hostnames still point at the platform app.

### The platform app itself must go

1. ~~Point the three CNAMEs back at the old apps~~ — **not available.** The old
   apps were destroyed on 2026-11-07, so there is no app to point a CNAME at,
   and the stable hostnames do not resolve yet either (task `5cb4a8fe`,
   operator-owned DNS step).

2. ~~Scale the old apps back up~~ — **not available.** `fly scale count`
   against a destroyed app fails. Re-creating and redeploying the four
   per-service apps is a forward change, not a backout.

3. Take the platform app down. **Which command you use depends on whether
   the app has ever had a successful release**, because `fly scale count`
   refuses to run on an app with no complete release:

   ```
   fly releases --app sindustries-platform-staging
   ```

   - **The app HAS a complete release** (the platform deployed successfully
     and you are backing out a bad image):

     ```
     fly scale count platform=0 --app sindustries-platform-staging --yes
     ```

   - **The app has NO complete release** (every release FAILED — this is the
     state after the first cutover attempt failed, and it is exactly when a
     backout is most urgent). `fly scale count` exits with
     `Error: this app has no complete releases. Run 'fly deploy' to create
     one and rerun this command`, so it cannot be used. Destroy the Machines
     instead:

     ```
     fly machine list --app sindustries-platform-staging
     fly machine destroy <machine-id> --app sindustries-platform-staging --force
     ```

     Repeat for every Machine the list returns.

   **Do not use `fly machine stop` to take the platform app down.** The
   platform's deployed `http_service` sets `min_machines_running = 1` and
   `auto_start_machines = true`, so Fly's autoscaler starts a stopped Machine
   again within roughly half a minute. A stopped Machine is not a backout;
   only `fly scale count` (against a released app) or destroying the Machines
   holds.

   Verify the app is actually down, and verify it again a minute later —
   a Machine that has just been stopped may still be running when you first
   look:

   ```
   fly machine list --app sindustries-platform-staging
   ```

   The expected result is `No machines are available on this app
   sindustries-platform-staging`.

**The old apps are gone.** They were destroyed ahead of the 2026-11-07 cutover,
so there is no per-app backout left to keep alive. The backout inside the
platform app is `fly releases rollback --app sindustries-platform-staging`.

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
