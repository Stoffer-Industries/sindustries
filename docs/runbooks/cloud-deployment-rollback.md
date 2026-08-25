# Runbook — Cloud deployment rollback

**Owner:** Rowan (engineering); Quinn runs the rollback operations
**Triggers:** Failed `/health` smoke check after deploy, Fly `http_check` failures, worker boot-log line missing, an outage of the staging services, or a regression surfaced in monitoring within the first hour of a release.
**Related:** task `b2f62c36` (Establish cloud deployment foundation), [`docs/systems/cloud-platform.md`](../systems/cloud-platform.md), [`infra/cloud/README.md`](../../infra/cloud/README.md), `infra/cloud/fly/{tasks-api,budget-api,auto-post-worker}.fly.toml`, `.github/workflows/deploy-staging-*.yml`.

## Why this exists

Every `fly deploy` to staging creates a **release version** that Fly keeps in a rolling history (default 50 versions per app). `fly releases rollback <version>` re-points the app to a previous release's image and redeploys it. This runbook captures *what counts as known-good*, *how to detect a bad release*, *how to roll back*, and *what rollback does not fix* — so an operator does not have to reverse-engineer Fly's release semantics during an incident.

The deploy pipeline uses `--strategy canary` for all three Fly apps (see each `infra/cloud/fly/*.fly.toml`). Canary brings up the new release alongside the old, then promotes once the new release is stable. If the smoke check (curl `/health` for HTTP services, log-line grep for the worker) fails inside the canary window, Fly does NOT auto-rollback — the deploy job exits non-zero and the bad release stays in the history for an operator to investigate.

## Pre-flight

1. **Confirm the bad release is the most recent one.** `fly releases --app <app>` lists the last N releases. The most recent is almost always the suspect — unless you've already started investigating and someone else has rolled forward.
2. **Identify the previous known-good version.** Note its release number (e.g. `v42`). This is what you'll roll back to.
3. **Check whether the bad release introduced a schema migration.** `git log --oneline origin/main -- services/<svc>/prisma/migrations/` shows migrations merged since the previous release. If a `prisma migrate deploy` ran on the canary (it does — `release_command` in the `fly.toml`), the new schema is already applied to Neon; rolling back the Fly image does NOT roll back the DB schema. See "What rollback does not fix" below.
4. **Have the previous release version written down** before you run any command. Operate from a checklist, not from memory.

## What counts as "known-good"

A Fly release for one of our apps is **known-good** if all of the following held simultaneously at the end of its deploy window:

- All GitHub Actions checks green at the commit that produced the release image.
- The post-deploy smoke check passed on the first attempt (no retries).
- For HTTP services (`tasks-api`, `budget-api`): the Fly `http_check` against `/health` was passing for **at least 5 minutes** after the canary promote. This rules out slow-startup regressions (Prisma cold start, Neon pool warmup).
- For the worker (`auto-post-worker`): the `[content-scheduler-worker] starting (adapter=bullmq)` log line is present in `fly logs --app <app>` AND the BullMQ worker is processing jobs (a synthetic enqueue round-trips within 60 seconds).
- No incident was filed against the service in the first hour after deploy.

If any of these failed, the release is **suspect** and you should not roll forward to it.

## How to detect a bad release

Three signals, in increasing severity:

### 1. Smoke check failure (deploy job red)

The deploy workflow's smoke check step exits non-zero. The new release is in the history but the workflow did not promote it past validation. Action: **investigate first, do not auto-rollback.** The previous release is still serving traffic.

```sh
# See the deploy job log
gh run view <run-id> --repo Stoffer-Industries/sindustries --log

# Inspect the new release's logs
flyctl logs --app <app>
```

Common causes:

- Missing or rotated env var (Quinn-only secret; fix is `fly secrets set`).
- Prisma schema drift between app and DB (run `npx prisma migrate deploy` via `fly ssh console`).
- Build failure (Dockerfile path mismatch, pnpm workspace drift) — check the build log inside the deploy job.

### 2. `http_check` failures (Fly auto-removes from load balancer)

For HTTP services, the Fly `http_check` against `/health` runs on a 15s interval. After 5 consecutive failures (configurable in the `fly.toml`), Fly removes the machine from the load balancer. The service is effectively down without explicit rollback. Action: **rollback immediately** — the previous release is still serving but traffic has shifted.

### 3. Application-level incident

Errors in `fly logs --app <app>` (uncaught exceptions, repeated Prisma connection errors, 5xx surge in HTTP access logs), or a user-reported regression within an hour of deploy. Action: **rollback** if the previous release was known-good, otherwise investigate first.

## Rollback procedure

### Step 1 — Confirm the target release

```sh
flyctl releases --app sindustries-tasks-api-staging
```

Pick the previous release number (e.g. `v42`). If the most recent release is itself a rollback attempt that failed, keep going back until you find a release you can defend as known-good.

### Step 2 — Roll back the Fly image

```sh
flyctl releases rollback --app sindustries-tasks-api-staging v42
```

Fly re-points the app to the release `v42` image and redeploys it. The process takes 30–90 seconds. The new "current" release becomes `v(N+1)` where `N` was the bad one — Fly records the rollback as a fresh release for audit clarity.

Repeat per affected app:

```sh
flyctl releases rollback --app sindustries-budget-api-staging v17
flyctl releases rollback --app sindustries-auto-post-worker-staging v8
```

### Step 3 — Verify

For HTTP services:

```sh
# Repeat 10x with a 5s sleep — Fly http_check needs ~75s to confirm liveness.
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl --fail --silent --show-error --max-time 10 \
    "https://sindustries-tasks-api-staging.fly.dev/health" || echo "fail"
  sleep 5
done
```

All 10 attempts should succeed. The Fly `http_check` will also report green within ~90s.

For the worker:

```sh
flyctl logs --app sindustries-auto-post-worker-staging --no-tail \
  | grep '\[content-scheduler-worker\] starting (adapter=bullmq)'
```

The boot line should be present, and a synthetic enqueue round-trip should complete within 60s.

### Step 4 — File the incident

Even if the rollback fixed the immediate symptom, the bad release is still in the history and the underlying regression is still in the tree. Open a follow-up task describing:

- The release version that was rolled back.
- The signal that triggered the rollback (smoke failure / `http_check` / incident).
- The diff between the bad release and the known-good release.
- Whether the regression needs a fix-forward PR, an OpenClaw config change, or a `fly secrets set` adjustment.

Tag the task with the affected service + a regression root cause label so factory-retro can pick it up.

### Step 5 — Communicate

Post in `#sindustries-eng` (or your equivalent operator channel):

- Which app(s) rolled back, from which version to which version.
- The signal that triggered the rollback.
- ETA for the follow-up fix-forward PR.

If the rollback changed user-visible behaviour (an API surface was on the rolled-back release that isn't on the current release), notify Tom — he's the product owner for the API surface.

## What rollback does NOT fix

Rollback re-points the Fly image. It does **not**:

1. **Roll back DB schema migrations.** `npx prisma migrate deploy` runs in the `release_command` of the bad release, so a destructive migration is already applied to Neon. Fix-forward only — or restore the database from a point-in-time backup (Neon supports this; ask Quinn). For non-destructive additive migrations (new column, new table), rollback is safe.
2. **Roll back env var changes.** If the bad release depended on a `fly secrets set` change Quinn made earlier (e.g. a new `CONTENT_SCHEDULER_*` URL), the previous release may fail to boot without it. `fly secrets unset` or revert the secret to its previous value.
3. **Roll back BullMQ queue state.** If the bad release enqueued bad jobs, they remain in the Upstash queue. Drain them or let them expire per the BullMQ retry policy (default: 3 retries with exponential backoff).
4. **Roll back content published to Twitter/X.** If the bad release was the auto-post-worker and it shipped a bad tweet, the tweet is live. Fix the worker; do not try to roll back the queue side-effect.
5. **Undo a canary that already promoted.** Canary promotes automatically once the new machine is healthy for a window. If the bad release promoted before its error pattern surfaced, traffic has already shifted. Roll back ASAP per the procedure above.

## Known-good rollback pattern

For services with a database-backed `release_command` (tasks-api, budget-api), the safe rollback pattern is:

1. Roll back the Fly image first.
2. Confirm the previous release boots cleanly with the current schema.
3. If the previous release depends on a schema it didn't have, fix-forward with a new migration that brings the schema back in sync with the rolled-back code. Do not try to roll back the schema alone — the rolled-back code may not boot against the new schema.

For services without a `release_command` (auto-post-worker), rollback is simpler: the Fly image is the only thing in play.

## When NOT to roll back

- **Mid-incident, before you understand the cause.** Rollback is a hammer; sometimes the right move is forward-fix (e.g. a missing env var, a config typo). Roll back only if you have a known-good target.
- **When the previous release is also broken.** Pick a known-good target further back in `fly releases --app <app>`, or fix-forward.
- **When the bad release is the only one you've ever shipped.** Fly starts tracking releases from your first deploy. If this is the inaugural release, rollback is a no-op — investigate instead.

## Related documents

- [`docs/systems/cloud-platform.md`](../systems/cloud-platform.md) — handover doc with the deploy + bootstrap procedure.
- [`docs/specs/cloud-deployment-foundation-tech-design.md`](../specs/cloud-deployment-foundation-tech-design.md) — design rationale, including the `--strategy canary` choice and the per-service smoke-check patterns.
- [`infra/cloud/README.md`](../../infra/cloud/README.md) — operator index, deploy procedure, env contract references.
- [`docs/runbooks/rotate-akahu-access-tokens.md`](rotate-akahu-access-tokens.md) — precedent for Quinn-owned secret rotation that interacts with Fly env vars.