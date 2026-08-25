# Runbook — Cloud data environment provision

**Owner:** Rowan (engineering); **Quinn owns the live Neon/Upstash accounts and runs the provision operation.**
**Applies to:** first-time creation (and reproduction) of the staging Postgres + Redis back-end for `tasks-api`, `budget-api`, and `auto-post-worker`.
**Trigger:** task `b2f62c36` WS2 — needs Quinn to create the managed Postgres (Neon) and managed Redis (Upstash) that the Fly apps read `DATABASE_URL` and `REDIS_URL` from at runtime.
**Related:** [`docs/systems/cloud-platform.md`](../systems/cloud-platform.md) (handover doc), [`docs/runbooks/cloud-deployment-rollback.md`](cloud-deployment-rollback.md) (rollback), [`infra/cloud/scripts/bootstrap-staging.sh`](../../infra/cloud/scripts/bootstrap-staging.sh) (Quinn-runnable env-wire step), [`infra/cloud/env/.env.example`](../../infra/cloud/env/.env.example) and the per-service `infra/cloud/env/<service>.env.example` (env contract).

## Why this exists

`infra/cloud/scripts/bootstrap-staging.sh` wires Quinn's existing connection strings into Fly secrets — it does not create the databases themselves. WS2 closes that gap: Quinn creates a Neon project (syd region, isolated from local dev data) and an Upstash Redis (syd region, TLS), captures the resulting connection strings, and feeds them into `.env.local` so the bootstrap script can apply them.

This runbook captures *exactly what Quinn creates*, *what's in vs out of scope*, *how to verify each piece is reachable from a Fly machine*, and *what to do if provision fails* — so Quinn does not have to reverse-engineer the Neon/Upstash APIs during a first-time setup.

## What gets created

| Resource | Vendor | Region | Tier (staging) | Owner | Lives in |
| --- | --- | --- | --- | --- | --- |
| Postgres primary | Neon | `syd` (Sydney) | Free / Launch | Quinn | Neon dashboard; URL in `infra/cloud/.env.local` (gitignored) |
| Redis primary | Upstash | `syd` (Sydney) | Pay-per-request (free tier) | Quinn | Upstash dashboard; URL in `infra/cloud/.env.local` (gitignored) |

Both resources are **separate from local dev** so dev work can't accidentally clobber staging:

- **Neon:** the staging project is a fresh Neon project (`sindustries-staging`), distinct from any Quinn-owned personal projects used for local dev. The schema-per-service (`tasks_api`, `budget_api`, `content_scheduler`, `gymtrack`) is encoded in the `?schema=…` URL suffix per service so service data is isolated inside the cluster.
- **Upstash:** a fresh Upstash database (`sindustries-staging`), TLS-only (`rediss://…`), distinct from any local Redis instance.

The staging resources are sized for **near-idle** staging traffic. Production sizing is a separate concern tracked under task `020f423e` (Execute production cloud cutover with rollback verification).

## Out of scope (today)

| Concern | Why | Tracked under |
| --- | --- | --- |
| Production Postgres / Redis sizing | WS2 is staging only | `020f423e` |
| Backups / point-in-time restore on Neon | Neon supports this for production; staging uses free-tier PITR | `020f423e`, `f2c23e26` |
| Multi-region replication | Single-region `syd` is enough for staging | (no task) |
| Read replicas | Staging load doesn't need one | (no task) |
| Observability on the data plane | The OTel collector is wired but the data-plane metrics host is TBD | `4b3d6e9c` |

## Pre-flight (Quinn)

1. **Authenticate the CLIs locally** (one-time, persistent across runs):
   - `neonctl auth` — opens a browser flow tied to Quinn's Neon account.
   - `upstash auth` — same pattern against Quinn's Upstash account.
   - `fly auth login` — already in place for the WS1 bootstrap; re-run if it has expired.
2. **Confirm region availability.** `syd` is supported by both Neon and Upstash today. If a region is dropped in the future, fall back to the closest `nrt` (Tokyo) for both vendors — the Fly apps are already in `syd` and intra-region latency matters more than absolute geography.
3. **Have `infra/cloud/.env.local` ready** (Quinn-owned, gitignored, format documented in `bootstrap-staging.sh`'s header). The provision step writes `DATABASE_URL` and `REDIS_URL` (and the per-schema variants) into `.env.local` so the bootstrap script can pick them up.

## Provision Neon Postgres

Run from any machine with `neonctl` installed and authenticated.

```sh
# 1. Create the staging project (syd region).
neonctl projects create \
  --name sindustries-staging \
  --region syd

# Capture the project id from the output.
PROJECT_ID=...

# 2. Create a per-env branch (the staging branch; main branch keeps Neon defaults).
neonctl branches create \
  --project-id "$PROJECT_ID" \
  --name staging \
  --parent main

# Capture the branch connection string.
neonctl connection-string \
  --project-id "$PROJECT_ID" \
  --branch staging \
  --role-name neondb_owner \
  --database-name neondb
#   → postgresql://<user>:<pw>@<host>/neondb?sslmode=require
```

The base URL Quinn gets from step 2 is **shared** across services; per-service isolation happens via `?schema=<service>` suffix at the Fly-app layer (already wired in `infra/cloud/env/<service>.env.example`). Quinn writes the four derived URLs into `.env.local`:

```sh
# infra/cloud/.env.local (gitignored)
TASKS_API_DATABASE_URL=postgresql://...?schema=tasks_api&sslmode=require
BUDGET_API_DATABASE_URL=postgresql://...?schema=budget_api&sslmode=require
AUTO_POST_WORKER_DATABASE_URL=postgresql://...?schema=content_scheduler&sslmode=require
# (gymtrack-mcp schemas are provisioned in their own WS — out of scope here)
```

Each Fly app then reads its own `DATABASE_URL` from the `fly secrets set` step in `bootstrap-staging.sh`.

## Provision Upstash Redis

```sh
# 1. Create the staging database (syd, TLS, pay-per-request).
upstash redis create \
  --name sindustries-staging \
  --region syd \
  --tls

# Capture the primary endpoint + password.
upstash redis list
#   → rediss://default:<password>@<host>:<port>
```

Quinn writes the URL into `.env.local`:

```sh
# infra/cloud/.env.local (gitignored)
REDIS_URL=rediss://default:<password>@<host>:<port>
```

`bootstrap-staging.sh` propagates this to all three Fly apps as `REDIS_URL` (which `auto-post-worker.fly.toml` also surfaces as `CONTENT_SCHEDULER_REDIS_URL` — same value, two names).

## Wire into Fly secrets

After `.env.local` has both URLs, Quinn runs:

```sh
infra/cloud/scripts/bootstrap-staging.sh --yes --service tasks-api
infra/cloud/scripts/bootstrap-staging.sh --yes --service budget-api
infra/cloud/scripts/bootstrap-staging.sh --yes --service auto-post-worker
```

The bootstrap script reads each service's `*_DATABASE_URL` and the shared `REDIS_URL` from `.env.local`, strips the prefix, and applies via `fly secrets set` to the matching Fly app. It is idempotent — re-running does not destroy anything.

## Smoke checks (post-provision)

These verify AC2 ("connectivity, access controls, and separation from local development data").

### Database connectivity from a Fly machine

```sh
fly ssh console --app sindustries-tasks-api-staging --command "/bin/sh"
# Inside the machine:
node -e '
  const {PrismaClient} = require("@prisma/client");
  const p = new PrismaClient();
  p.$queryRawUnsafe("SELECT current_database(), current_schema()")
    .then(r => { console.log(r); process.exit(0); })
    .catch(e => { console.error(e.message); process.exit(1); });
'
```

Expected output: a row showing the database name and the `tasks_api` schema. Repeat for `budget-api` (`budget_api` schema) and `auto-post-worker` (`content_scheduler` schema).

### Redis connectivity from a Fly machine

```sh
fly ssh console --app sindustries-auto-post-worker-staging --command "/bin/sh"
# Inside the machine:
node -e '
  const {createClient} = require("redis");
  const c = createClient({url: process.env.REDIS_URL});
  c.on("error", e => { console.error(e.message); process.exit(1); });
  c.connect().then(() => c.ping()).then(p => {
    console.log("PING:", p); process.exit(0);
  });
'
```

Expected output: `PING: PONG`. The `rediss://` URL means TLS is enforced; if the machine falls back to `redis://` (no TLS), Upstash will reject the connection.

### Worker boot line

```sh
flyctl logs --app sindustries-auto-post-worker-staging --no-tail \
  | grep '\[content-scheduler-worker\] starting (adapter=bullmq)'
```

A clean boot line means Prisma reached Neon AND the BullMQ worker registered against Upstash. Both connections exercise the same `.env.local` values.

### Separation from local dev

- `psql` against the Neon URL from Quinn's laptop should fail (Neon requires TLS + IP allowlist or a Neon-issued connection). Confirm with:
  ```sh
  psql "$TASKS_API_DATABASE_URL" -c "SELECT 1"
  ```
  If it succeeds, Quinn has likely configured Neon's IP allow to include the laptop. That is fine — but document it. If it fails with a clear TLS / IP error, separation is intact.
- `redis-cli -u "$REDIS_URL" ping` from Quinn's laptop should fail with an auth or TLS error (Upstash requires the `rediss://` URL form and rejects plain `redis://`). Confirmation that local Redis (the dev one) is untouched and staging cannot be reached from a non-Fly network.

## What this runbook does NOT cover

| Concern | Why | Tracked under |
| --- | --- | --- |
| Production data-plane sizing | WS2 is staging only | `020f423e` |
| Database migration to production | Production cutover has its own runbook | `f2c23e26`, `d37681e1` |
| Neon PITR restore procedure | Documented in Neon's dashboard; Quinn handles per-incident | `f2c23e26` |
| Upstash failover / multi-region | Single-region only at this stage | (no task) |
| Cross-region replication | Not needed for staging | (no task) |

## Failure modes

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `neonctl projects create` fails with region unsupported | Neon dropped `syd`; fall back to `nrt` | Re-run with `--region nrt`; document the region drift in `infra/cloud/README.md` |
| `upstash redis create` rejects `syd` | Same fallback path | Use `--region nrt`; same drift note |
| Fly machine can't reach Neon | Egress blocked / wrong URL | Re-check the URL has `?sslmode=require`; check Fly's outbound network policy |
| Fly machine can't reach Upstash | Missing TLS / wrong port | Confirm URL starts with `rediss://` (not `redis://`); default Upstash port is `6379` |
| Worker boot log line never appears | Either Redis OR Postgres unreachable; `release_command` runs `prisma migrate deploy` first | `fly logs --app <app>` — check the first `prisma migrate deploy` output; if it failed, fix Neon URL before re-checking Redis |
| `psql` against the Neon URL succeeds from Quinn's laptop | Local-IP allowlist is too broad | Tighten Neon IP allow to Fly egress only; document the policy |

## When to skip the runbook

Quinn already has a Neon project + Upstash database wired into Fly secrets. The provision step is already done — no need to re-run. Re-run only if:

- Staging data plane needs to be recreated (e.g. moving to a different Neon project for billing).
- The Fly secrets are stale (Neon rotated the connection string without Quinn's knowledge — they shouldn't, but check if `fly secrets list` shows the same hostname as the Neon dashboard).
- Quinn is bringing on a second operator who needs their own staging data plane.

## Related documents

- [`docs/systems/cloud-platform.md`](../systems/cloud-platform.md) — handover doc with vendor rationale (Fly / Neon / Upstash), region reasoning, cost model, and credential boundary.
- [`docs/runbooks/cloud-deployment-rollback.md`](cloud-deployment-rollback.md) — rollback procedure (DB schema is one of the things rollback does NOT touch).
- [`infra/cloud/scripts/bootstrap-staging.sh`](../../infra/cloud/scripts/bootstrap-staging.sh) — Quinn-runnable env-wire step that reads `.env.local` and applies via `fly secrets set`.
- [`infra/cloud/env/.env.example`](../../infra/cloud/env/.env.example) — cross-service env contract template.
- [`infra/cloud/README.md`](../../infra/cloud/README.md) — operator index.
- [`docs/specs/cloud-deployment-foundation-tech-design.md`](../specs/cloud-deployment-foundation-tech-design.md) — design rationale, WS1–WS4 split, AC coverage matrix.