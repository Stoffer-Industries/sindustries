# Runbook — Production data migration, backup and restore

This runbook drives the production database cutover workflow
(`.github/workflows/cloud-production-db-cutover.yml`) and the on-host
scripts under `scripts/cloud/database/`. It is the operator companion
to the tech design `docs/specs/production-data-migration-restore-tech-design.md`
and the staging rehearsal runbook
`docs/runbooks/staging-database-migration-restore.md`.

The production cutover runs the **same** harness as the staging drill.
There is no second, "production-only" script set: one harness, two
environment profiles. The production profile is stricter, not looser —
see §2.

## 1. Scope

This runbook covers one production transfer run end to end:

1. inventory the source,
2. dump the source to a verified archive,
3. restore the archive into the destination,
4. apply Prisma migrations,
5. reconcile source against destination,
6. (optional) restore the migrated data again into a recovery database
   and reconcile again — this is the AC3 backup evidence,
7. seal the evidence into `manifest.json`.

It also covers the failure paths: what to do when a step fails, what is
safe to retry, and when to roll back.

**Not** in scope: choosing the maintenance window, approving the
transfer, Neon plan changes, or decommissioning the source. Those are
operator decisions recorded in the task, not steps in this document.

## 2. What makes a production run different from staging

| | staging | production |
|---|---|---|
| Environment label | `staging` | `production` |
| Endpoint identification | denied by production-marker substring in the DSN | **required** allowlist of `host[:port]` the run may touch (`--expected-host`) |
| Second key | not required | `CLOUD_DB_PRODUCTION_ACK=1` in the environment, set only by the typed confirmation |
| Database-name rule | must carry `sindustries_staging_` | must NOT carry the staging prefix |
| Artifact directory | `./artifacts/cloud-staging` | `./artifacts/cloud-production` |
| Envelope kind | `cloud-staging-*` | `cloud-production-*` |

The production Neon branch database is named `neondb` — **the same name
staging uses**. A database-name prefix therefore cannot identify a
production target, which is why the production profile identifies its
target by declared endpoint instead, and why that allowlist is
mandatory: a run that has not declared its endpoints refuses to run.

### The three keys

A production run needs three independent keys, and no single one of them
can start a move:

1. **The `production` GitHub Environment.** Its reviewers are the
   approval gate. A dispatch that has not been approved never starts.
2. **The typed confirmation `MIGRATE PRODUCTION`.** This is what sets
   `CLOUD_DB_PRODUCTION_ACK=1`. The scripts require that variable; the
   workflow sets it only when the confirmation string matches exactly.
3. **The declared endpoints.** `source_host` and `destination_host` at
   dispatch time. The scripts refuse any endpoint outside that list, so
   a mistyped DSN in a secret cannot point the run at an undeclared
   database.

## 3. Prerequisites

All of the following must hold before the workflow is dispatched:

- task `fb1240c0` (provision the production environment) is `done` and
  its acceptance is recorded — including the Neon IP allowlist gate
  (AC2) and the Fly spend-bound ordering gate (AC5);
- the `production` GitHub Environment exists, has required reviewers
  configured, and carries the DSN secrets below;
- a maintenance window and a rollback decision point are agreed with
  Tom and recorded in the task;
- the source is quiesced — writes stopped or drained — for the
  duration of the run;
- the operator has the runbook open next to the Actions tab.

### Required secrets on the `production` GitHub Environment

| Secret | Purpose |
|---|---|
| `TASKS_API_SOURCE_DSN` | read-only DSN for source `tasks_api` |
| `BUDGET_API_SOURCE_DSN` | read-only DSN for source `budget_api` |
| `TASKS_API_DEST_DSN` | owner DSN for destination `tasks_api` |
| `BUDGET_API_DEST_DSN` | owner DSN for destination `budget_api` |
| `RECOVERY_TASKS_API_DSN` | owner DSN for the recovery database (only with `recovery=true`) |
| `RECOVERY_BUDGET_API_DSN` | owner DSN for the recovery database (only with `recovery=true`) |

The workflow writes each DSN to a mode-`0600` file in the runner's temp
directory before the scripts run. The scripts accept file paths only —
never positional DSNs — and never log a DSN, a partial URL, or a token
byte.

## 4. The cutover sequence (happy path)

1. Verify the prerequisites in §3 and record the agreed window in the
   task.
2. Quiesce the source. Take the final pre-cutover row-count snapshot
   if one has not already been captured.
3. Dispatch the workflow with:
   - `confirm_production` = `MIGRATE PRODUCTION`
   - `source_host` = the source endpoint's `host[:port]`, exactly as it
     appears in the source DSN
   - `destination_host` = the destination endpoint's `host[:port]`
   - `recovery` = `true` when AC3 backup evidence is being captured in
     the same window
   - `interruption` = `none`
   - `cleanup_destination` = `false` unless a previous failed run left
     schemas behind in the destination
4. The workflow runs `drill.sh --environment production`, which executes
   in order:
   - `inventory.sh` — server version, schemas, extensions, relation
     counts, Prisma migration state, source activity;
   - `dump.sh` — custom-format archive, verified with
     `pg_restore --list`, sha256, atomic rename;
   - `restore.sh` — restores into the destination, refuses a
     non-empty destination, verifies both schemas exist afterwards;
   - `migrate.sh` — `prisma migrate deploy` for `tasks-api` and
     `budget-api`, refusing to run over failed migrations;
   - `reconcile.mjs` — service-owned reconciliation manifests, count
     comparison, primary-key digest comparison, `verdict=PASS|FAIL`;
   - `manifest.sh` — the evidence manifest (step 8 in `drill.sh`).
5. Download the `cloud-production-db-cutover-<run-id>` artifact bundle
   and archive it per §7.
6. If the verdict is `PASS`, the run is complete; record the evidence
   in the task.

## 5. Failure, interruption and safe retry (AC4)

| Failure | What the scripts do | Operator action |
|---|---|---|
| `pg_dump` fails or the archive does not parse | the `.partial` is removed; the source is never written to | fix the cause, re-dispatch with a fresh run id |
| `pg_restore` fails mid-way | the destination is left partially restored; the source is untouched | re-dispatch with `cleanup_destination=true` so the two schemas are dropped and recreated by `pg_restore` itself |
| `prisma migrate deploy` fails | the run stops before reconciliation; the failed migration stays recorded in `_prisma_migrations` | resolve the migration, then re-run from the dump step |
| reconciliation reports a mismatch | the drill exits non-zero before the run is declared `PASS` | **halt.** Compare the envelopes, decide whether to re-dump, then re-dispatch |
| the runner loses connectivity | the scripts fail closed; nothing is half-written | re-dispatch with a fresh run id; the destination is rebuilt from the archive |

**Safe retry rules.**

- Nothing in the harness ever writes to the source. The source is
  read-only for the whole run.
- The destination is rebuilt from the archive on every attempt. There is
  no incremental merge step, so a retry cannot double-write rows.
- A retry always uses a fresh run id. The run id is part of the
  artefact names and of the manifest, so two runs can never be confused
  for one.
- A failed attempt's artefacts stay in place for inspection until the
  operator has captured the evidence. `cleanup_destination` is the only
  destructive action, and it needs two keys of its own.

**Interruption drills.** `interruption=dump` or `interruption=restore`
exercises the bounded failure path on the real run. Both leave the
partial artefact in place for forensic inspection and exit non-zero.
They are AC4 evidence, not a way to attempt a real migration — do not
run them against a live destination outside a deliberate drill window.

## 6. Go / no-go criteria

| Phase | Go | No-go |
|---|---|---|
| Pre-flight | every prerequisite in §3 met; `production` Environment approved; confirmation string exact; source and destination hosts declared and different; PostgreSQL client major = 18 | any missing secret, wrong confirmation, undeclared endpoint, wrong client major |
| Inventory | source reachable, both schemas present, `_prisma_migrations` present | source unreachable, schema missing, no migration table |
| Dump | `pg_dump` exits 0, `pg_restore --list` parses the archive, sha256 computed | any of the three post-dump checks fails |
| Restore | destination was empty pre-restore, both schemas present post-restore, `pg_restore --exit-on-error` exits 0 | destination non-empty pre-restore, missing schema post-restore, restore non-zero |
| Migrations | `prisma migrate deploy` exits 0 for both services, no failed or pending rows | any failed row, any unexpected pending row |
| Reconcile | `verdict=PASS`, every check matches, every digest matches | any check mismatch, any digest mismatch |
| Manifest | `manifest.json` lists every artefact with its digest and the reconcile verdict | manifest missing an artefact, or a reconcile verdict that is not `PASS` |

## 7. Evidence

Every run produces, in the artifact directory:

- `inventory-<run-id>.json` — source state, no row contents;
- `<run-id>.dump` + `.sha256` — the archive and its digest;
- `dump-<run-id>.json` — the dump envelope;
- `restore-<run-id>.json` + `.log` — the restore envelope and the
  `pg_restore` log;
- `migrate-<run-id>.json` + per-service logs — the migration state
  before and after;
- `reconcile-<run-id>.json` — per-check source/destination counts,
  deltas, and the primary-key digest match flag;
- `drill-<run-id>.json` — the run envelope;
- `manifest-<run-id>.json` — the digest of every artefact above plus
  the rolled-up verdict.

The manifest is the single file to attach to the task. The archive
itself belongs in the encrypted object store, not in a GitHub artifact;
the manifest records its digest so the two can be tied together later.

## 8. Rollback

Rollback is a source-side decision, not a script:

1. The destination is **not** dropped automatically. It is preserved for
   forensics.
2. If the cutover has not yet repointed the applications, the correct
   rollback is to leave the applications on the source and re-run the
   transfer after fixing the cause.
3. If the applications have already been repointed to the destination,
   repoint them back to the source, restart, and re-run the smoke
   checks against the source before declaring the incident closed.

The harness never repoints an application. Application repointing is a
separate, operator-driven step recorded in the task.

## 9. Credential handling

- The DSN secrets on the `production` GitHub Environment are rotated by
  Quinn. A rotation invalidates any in-flight run; re-dispatch after
  the rotation.
- The DSN files written by the workflow live in the ephemeral runner
  temp directory and are destroyed with the runner.
- The scripts redact DSNs, `password=`, `DATABASE_URL=` and every
  `PRISMA_*` variable from every log line they write.
- No DSN, endpoint credential or token byte is ever written into an
  artefact envelope, the manifest, or the task comment.

## 10. Escalation

If a run fails in a way §5 and §6 do not cover, escalate via:

- the `cron-revert` Slack channel (Quinn's standard escalation lane);
- or, for security-sensitive findings, the `security` channel.

An escalation must include: the run id, the failing phase, the
artefact path, the manifest digest, and a link to the task. Never paste
a DSN into a channel — quote the artefact path instead.
