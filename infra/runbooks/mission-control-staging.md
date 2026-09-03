# Mission Control — Staging Deployment Runbook

**Owner:** Rowan (Staff Engineer)
**Audience:** on-call engineer, Quinn, Tom
**Scope:** `sindustries-mission-control-staging` and `sindustries-tasks-app-staging` Fly apps
**Created:** 2026-09-04
**Source spec:** `brain/tasks/specs/in-progress/mission-control-cloud-deployment.md` (task `dd232b99`)

## Why this runbook exists

The Mission Control cloud deployment is the first end-user-visible surface
in the SIndustries cloud migration that needs a stable URL reachable
without the Mac mini being online. This runbook documents:

- the two Fly apps (and why they are two, not one)
- the DNS assignment + how to validate it
- the deploy procedure (build args, canary, smoke checks)
- the health-check contract
- the revert procedure

Anything not covered here is a gap. Edit this runbook first, then the
fly.toml/Dockerfile, then push a docs PR.

## App inventory

| Fly app                                | Purpose                                                    | Build arg                                                         |
| -------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------- |
| `sindustries-mission-control-staging`  | Mission Control shell (Pulse UI), embeds Tasks via iframe  | `VITE_TASKS_API_BASE_URL`, `VITE_TASKS_APP_URL`                   |
| `sindustries-tasks-app-staging`        | Tasks app SPA, served standalone + iframeable              | `VITE_TASKS_API_BASE_URL`, `VITE_SHELL_ORIGIN`                    |

Both apps live in `infra/cloud/fly/<app>.fly.toml` and
`infra/cloud/docker/<app>.Dockerfile`. The shared SPA nginx config is
`infra/cloud/docker/spa-nginx.conf` (SPA fallback + `/healthz`).

### Why two apps, not one

The iframe architecture decision in `docs/systems/mission-control.md`
is built on independent deploy cadence — folding Tasks into Mission
Control would force coordinated releases for every change to either
side. The Tasks app is also the source of truth for task editing, and
reverting a Mission Control regression should not have to revert a
Tasks-only change at the same time. AC3 calls out "Mission Control
deployment can be health-checked and safely reverted"; two apps give
us per-app revert granularity.

## DNS

| Host                                              | Resolves to                                            | Notes                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `mc-staging.sindustries.dev` (proposed)           | `sindustries-mission-control-staging.fly.dev`           | Public CNAME; Mission Control staging entry point.                                     |
| `tasks-staging.sindustries.dev` (proposed)        | `sindustries-tasks-app-staging.fly.dev`                 | Public CNAME; iframe src target. Reachable directly so the iframe embed survives.       |
| `tasks-api.sindustries.dev` (existing, foundation)| `sindustries-tasks-api-staging.fly.dev`                 | Set by the Cloud Deployment Foundation workstream (task `b2f62c36`). Not in this PR.   |

**Why a real subdomain instead of just `.fly.dev`:** `.fly.dev` URLs
are reachable today, but the spec's non-goal about "production
deployment of Mission Control" implies the staging URL needs to mirror
what a production URL will look like (custom domain + TLS cert managed
by Fly, not the shared `.fly.dev` wildcard cert). Documenting the
subdomain here means the prod cutover spec (task `020f423e`) inherits
the naming pattern without re-deciding it.

**Operational prerequisites for DNS (handover checklist):**

1. The `sindustries.dev` zone is managed at the registrar — confirm
   with Tom where (Cloudflare? Namecheap? something else). Document in
   this runbook once confirmed.
2. `fly certs create mc-staging.sindustries.dev` after the first deploy
   succeeds (Fly issues a Let's Encrypt cert against the DNS A/AAAA
   record; the cert can only be issued once the record is live).
3. `fly certs create tasks-staging.sindustries.dev` after the first
   Tasks app deploy.
4. Validate end-to-end with `curl -I https://mc-staging.sindustries.dev/healthz`
   (expect `200 ok`) and `curl -I https://tasks-staging.sindustries.dev/healthz`.

## Deploy procedure

### Pre-flight

```bash
# Auth — Rowan account; Quinn rotates the shared FLY_API_TOKEN out of
# band once the production cutover workstream lands (task 020f423e).
fly auth whoami   # expect rowanstoffer
```

### Deploy Mission Control

```bash
fly deploy \
  --config infra/cloud/fly/mission-control.fly.toml \
  --build-arg VITE_TASKS_API_BASE_URL=https://sindustries-tasks-api-staging.fly.dev/api/v1 \
  --build-arg VITE_TASKS_APP_URL=https://sindustries-tasks-app-staging.fly.dev
```

### Deploy Tasks app (deploy BEFORE Mission Control if Tasks isn't already up)

```bash
fly deploy \
  --config infra/cloud/fly/tasks-app.fly.toml \
  --build-arg VITE_TASKS_API_BASE_URL=https://sindustries-tasks-api-staging.fly.dev/api/v1 \
  --build-arg VITE_SHELL_ORIGIN=https://sindustries-mission-control-staging.fly.dev
```

The `VITE_SHELL_ORIGIN` build arg must match the Mission Control
Fly URL the iframe parent will be served from. If Mission Control is
moved to a custom domain (`mc-staging.sindustries.dev`), re-deploy
Tasks app with that origin baked in.

### Post-deploy smoke checks

```bash
# 1. Healthz — Fly http_check does this every 15s, but verify
#    immediately post-deploy for fast feedback.
curl -fsS https://mc-staging.sindustries.dev/healthz     # expect "ok"
curl -fsS https://tasks-staging.sindustries.dev/healthz # expect "ok"

# 2. Bundle shipped — root index.html must return 200 (not the SPA
#    fallback). A 200 here confirms the dist/ copy worked.
curl -fsS -o /dev/null -w '%{http_code}\n' \
  https://mc-staging.sindustries.dev/index.html      # expect 200
curl -fsS -o /dev/null -w '%{http_code}\n' \
  https://tasks-staging.sindustries.dev/index.html   # expect 200

# 3. Iframe embed — fetch Mission Control HTML and look for the
#    iframe src pointing at the Tasks app URL.
curl -fsS https://mc-staging.sindustries.dev/index.html | grep -o 'src="[^"]*"' | head -3
#    expect src="https://tasks-staging.sindustries.dev/" (or equivalent)

# 4. Tasks API reachability from Mission Control — open the page in
#    a browser, click into the Tasks tab; verify the iframe loads.
#    Manual because the iframe URL is not in any /api endpoint.
```

If any step fails, follow **Revert** below rather than re-deploying
on top of a broken release.

## Health check

`infra/cloud/docker/spa-nginx.conf` exposes `/healthz`, which returns
`200 ok\n` independently of the SPA bundle. Both fly.toml files
configure Fly's `http_check` to hit `/healthz` every 15s with a 2s
timeout and 20s grace period on cold start.

**Why /healthz is independent of /index.html:** the healthcheck should
verify nginx is alive, not that the SPA bundle is intact. If the
dist/ copy failed the container would still serve /healthz but the
page itself would 404; the post-deploy smoke checks catch that.

**Where to look if Fly reports the app unhealthy:**

1. `fly logs -a sindustries-mission-control-staging` — last 200 lines.
2. `fly checks list -a sindustries-mission-control-staging` — recent
   check results; non-200 from /healthz is the signal.
3. SSH in (`fly ssh console -a sindustries-mission-control-staging`)
   and run `curl -i http://localhost:8080/healthz` to confirm nginx
   is serving locally. If local is 200 but external is not, the
   issue is the Fly routing layer (rare; usually a deploy-time
   problem, not a runtime one).

## Revert

Fly keeps every release versioned; revert is one command and is the
documented AC3 path:

```bash
# List recent releases (newest first).
fly releases -a sindustries-mission-control-staging

# Roll back to the previous release. This is instant — Fly swaps the
# active release pointer; no rebuild, no image push.
fly releases rollback <version> -a sindustries-mission-control-staging

# Same for Tasks app if that's what regressed.
fly releases rollback <version> -a sindustries-tasks-app-staging
```

**Why `fly releases rollback` instead of `git revert` + redeploy:**

- Instant (no image rebuild, no push to a registry).
- Atomic at the Fly level — the prior release's container image is
  already cached, so the rollback does not depend on registry
  availability.
- Independent of branch state — works even if the regressing commit
  is on a branch that has been force-pushed or deleted.

After a rollback, post a `[implementer-prs]` follow-up comment on
task `dd232b99` and on the PR that introduced the regression so the
audit trail captures why the rollback was needed.

## Roll-forward

Once the underlying bug is fixed and merged, deploy the new release
the same way as the original deploy (the canary strategy will replace
the rolled-back release on a clean deploy). Don't try to "redeploy
the same SHA" — Fly's release naming already preserves the SHA, and
a forced identical deploy can confuse the canary algorithm. Push the
fix, merge, run the deploy command above.

## What is NOT covered here

- **Authentication / authorisation** — explicitly out of scope per
  the spec's non-goals. The staging URL will be reachable to anyone
  on the internet; do not put private data in the staging Tasks
  instance. Real auth is a separate spec (per `docs/systems/mission-control.md`
  known gaps).
- **Production cutover** — `brain/tasks/specs/in-progress/sindustries-cloud-migration.md`
  + the production cutover workstream (task `020f423e`) handle
  prod-only decisions (custom domain, prod tasks-api URL, prod
  content-scheduler-api URL, prod observability hooks).
- **Backup / restore of the SPA bundles** — the SPA bundles are
  reproducible from `git` + the build args; restoring them is "re-run
  the deploy command". Fly Machine state for the SPA is ephemeral and
  holds no user data.
