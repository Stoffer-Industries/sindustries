# Runbook — Cloud staging database transfer + restore

This runbook drives the cloud-staging database drill workflow
(`.github/workflows/cloud-staging-db-drill.yml`) and the on-host
scripts under `scripts/cloud/database/`. It is the operator companion
to the tech design `docs/specs/staging-database-migration-restore-tech-design.md`
and the AC evidence template at `docs/infra/staging-database-migration-validation-template.md`.

## 1. Prerequisites

The operator must hold, or have access to:

- a GitHub account with `workflow_dispatch` permission on the
  `Stoffer-Industries/sindustries` repository;
- a Fly.io account with `app:read`, `app:create`, and `volume:read`
  scopes for the staging org;
- the four required DSN secrets on the `staging` GitHub Environment:
  - `TASKS_API_SOURCE_DSN`     — read-only DSN for source `tasks_api`
  - `BUDGET_API_SOURCE_DSN`    — read-only DSN for source `budget_api`
  - `TASKS_API_DEST_DSN`       — owner DSN for destination `tasks_api`
  - `BUDGET_API_DEST_DSN`      — owner DSN for destination `budget_api`
- when running with `--recovery`, the two recovery DSNs:
  - `RECOVERY_TASKS_API_DSN`   — owner DSN for recovery `tasks_api`
  - `RECOVERY_BUDGET_API_DSN`  — owner DSN for recovery `budget_api`

The DSNs are written to mode-`0600` files inside the runner temp
directory at the start of the workflow. The scripts refuse to accept
positional DSNs; only file paths.

## 2. The drill sequence (happy path)

1. Verify the staging GitHub Environment has all six DSNs above and
   that no production DSN substring appears in any of them.
2. Trigger the workflow with default inputs (`recovery=false`,
   `interruption=none`) from the Actions tab.
3. The workflow runs `drill.sh` which executes, in order:
   - `inventory.sh` — captures server version, schemas, extensions,
     relation counts, Prisma migration state, and source activity.
   - `dump.sh` — produces a custom-format `.dump` archive, verifies
     it with `pg_restore --list`, computes sha256, atomic rename.
   - `restore.sh` — restores into the destination, asserts the
     destination was empty, verifies both schemas exist post-restore.
   - `migrate.sh` — runs `prisma migrate deploy` for tasks-api and
     budget-api in turn, asserts no failed / unaccounted migrations.
   - `reconcile.mjs` — runs the service-owned reconciliation
     manifests, compares counts + distinct-PK sets + invariants,
     writes a `verdict=PASS|FAIL` envelope.
4. Inspect the uploaded `cloud-staging-db-drill-<run-id>` artifact.
5. Fill in the dated evidence document at
   `docs/infra/staging-database-migration-validation-<YYYY-MM-DD>.md`
   using the template.

## 3. The drill sequence (interruption drills)

Set `interruption=dump` or `interruption=restore` to exercise the
corresponding bounded failure on disposable resources. Both drills:

- run only on the staging GitHub Environment;
- never touch the source;
- leave the partial archive / quarantined database in place for
  forensic inspection;
- exit non-zero with a clear log line.

After an interruption drill, the operator must:

1. Inspect the leftover state (`.dump.partial` or quarantined DB).
2. Run the workflow again with `interruption=none` to confirm the
   normal path is still healthy.

## 4. Go / no-go criteria

| Phase | Go | No-go |
|---|---|---|
| Pre-flight | All six DSNs present, all environment labels = `staging`, PostgreSQL client major = 16. | Any production DSN substring, missing secret, wrong environment label, wrong PostgreSQL major. |
| Inventory | Source reachable, both schemas present, Prisma migrations table exists. | Source unreachable, schema missing, no `_prisma_migrations` table. |
| Dump | `pg_dump` exits 0, archive parses with `pg_restore --list`, sha256 computed. | Any of the three post-dump checks fail. |
| Restore | Destination was empty pre-restore, both schemas present post-restore, `pg_restore --exit-on-error` exits 0. | Destination non-empty pre-restore, missing schema post-restore, restore non-zero. |
| Migrations | `prisma migrate deploy` exits 0 for both services, no failed / pending rows. | Any failed row, any unexpected pending row. |
| Reconcile | `verdict=PASS` for both services, digest match for every table. | Any check mismatch, any digest mismatch. |
| Recovery (optional) | Same as restore + migrate + reconcile, all green. | Any phase above fails. |

## 5. Cleanup

The workflow never drops a database. Cleanup is intentionally manual:

- the destination and recovery databases are quarantined and tagged
  with the run id; the operator drops them after evidence capture;
- archives are placed in the approved encrypted object store (not
  GitHub artifacts); the runbook notes object version + retention
  policy for each run.

To make a run idempotent, re-run the workflow with a fresh run id
and the operator will see new artifacts. The runbook never instructs
the operator to "drop database" or "remove archive" via the
workflow; that is a separate manual step with a typed confirmation
matching the run id.

## 6. Credential rotation

- The four DSN secrets on the `staging` GitHub Environment are rotated
  by Quinn; rotation triggers a fresh drill via the workflow.
- The DSN files written by the workflow are inside the ephemeral
  runner temp directory and are destroyed when the runner terminates.
- The scripts never write a DSN, partial URL, or token byte to any
  log line, evidence envelope, or shell history entry.

## 7. Escalation

If the drill fails in a way that is not covered by the table in §4
or by the AC evidence template, escalate via:

- the `cron-revert` Slack channel (Quinn's standard escalation lane);
- or, for security-sensitive findings, the `security` channel.

Escalations must include the run id, the failing phase, the artefact
path, and a link to the dated evidence document if one exists.
