---
status: draft
task_id: f2c23e26-9d26-451d-bf62-e1a357fa24ab
product_spec: brain/tasks/specs/open/production-data-migration-restore.md
shipped_pr: null
shipped_date: null
---

# Tech Design — Migrate production data with verified backup and restore

## Revision — 2026-11-21 (topology and scope)

Tom's execution decision of 2026-11-19 changed the shape of this
migration, and this section records the design consequences. It is the
operative part of this document; the sections below it are the original
2026-08 design, kept for the reasoning behind the parts that still hold.

**Service scope.** The migration moves TWO services: `tasks_api` and
`content_scheduler`. Budget API and GymTrack MCP are deferred to a
separate slice. The harness therefore migrates, reconciles and restores
those two schemas and no longer the `budget_api` one — the same change
applies to the staging rehearsal, so the rehearsal keeps rehearsing the
production shape.

**Topology.** The destination is the EXISTING production Neon database —
its `tasks_api` and `content_scheduler` schemas. No new permanent
production database is created for this cutover. The recovery target is
a TEMPORARY, isolated database used only to prove that a verified backup
restores into a usable state; it is created for the run and dropped
after it.

**What that changes in the design.**

1. *The readiness gate.* The `neon.cutover-database-capacity` gate
   (three distinct production databases) is obsolete — it demanded
   permanent production databases the migration is forbidden from
   creating. It is replaced by `neon.cutover-destination-database`,
   which proves that the existing production database exists and that the
   Neon inventory was read completely.
2. *The recovery target becomes a first-class invariant.* Under the old
   topology the recovery database was a third permanent production
   database, distinguished by capacity count. Under the new topology it
   is temporary, so nothing about its inventory can prove it is a
   different database — only its endpoint can. `drill.sh` therefore
   reads the host out of each recovery DSN and refuses the run when the
   recovery target shares a host with the source (which would overwrite
   the rollback source) or with the destination (which would reconcile
   the destination against itself). The workflow requires a declared
   `recovery_host` that differs from both, and adds it to the endpoint
   allowlist.
3. *The recovery DSNs are explicit arguments.* The drill used to derive
   the recovery DSN paths from the destination file names
   (`<dest-stem>-recovery.dsn`). No caller followed that convention, so
   the recovery path failed on a missing file. The recovery DSNs are now
   explicit arguments, which cannot drift from the caller's naming.
4. *The migration tooling's location.* The design below says
   `infra/migrations/`. The harness it describes was implemented at
   `scripts/cloud/database/` under the predecessor task `d37681e1`,
   because that is where the staging rehearsal harness already lived and
   a second tree would have left two implementations of one procedure.
   The behaviour the design specifies — one reusable, environment-
   parameterised procedure, run against production with a production
   runbook — is what shipped. The `infra/migrations/` paths in the
   sections below are therefore historical.

**AC verification matrix (current).**

| AC | Verification |
| --- | --- |
| AC1 | `reconcile-<run-id>.json` records `verdict=PASS` for both services: the service-owned reconciliation manifests (`services/tasks-api/ops/reconciliation.sql`, `services/content-scheduler-api/ops/reconciliation.sql`) compared row counts, distinct PK counts and grouped state counts, plus a primary-key digest per table. No unexplained loss or duplication |
| AC2 | `migrate-<run-id>.json` records a clean `prisma migrate deploy` for `tasks-api` and `content-scheduler-api` against the destination schemas, with no failed or unaccounted-pending rows in either `_prisma_migrations` table |
| AC3 | the recovery reconcile (`reconcile-recovery-<run-id>.json`) records `verdict=PASS` against the TEMPORARY isolated recovery target, whose host the drill proved is neither the source's nor the destination's. The archive digest is sealed in `manifest-<run-id>.json` |
| AC4 | the failure/interruption drills (`--interruption dump|restore`, `cleanup-destination` two-key auth, the recovery isolation refusal, the endpoint allowlist refusal) and the contract suites in `scripts/cloud/database/tests/` and `tests/cloud/tests/` |


## Links and scope

- Product spec: `brain/tasks/specs/open/production-data-migration-restore.md`
- Parent migration index: `brain/tasks/specs/open/sindustries-cloud-migration.md`
- Predecessor rehearsal task: `d37681e1-2666-425b-bf1d-5edd4f4be7ce` (Validate staging database migration and restore)
- Task: `f2c23e26-9d26-451d-bf62-e1a357fa24ab`
- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-f2c23e26-production-data-migration`
- Worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-f2c23e26-production-data-migration`
- Primary surfaces: `infra/`, `services/budget-api/prisma`, `services/tasks-api/prisma`, `services/gymtrack-mcp/prisma`, `infra/plano`
- Stack: Postgres 16 (source and target), Prisma migrate, S3-compatible object store for backup artefacts

## Product summary

Move SIndustries production data from the current local/on-prem Postgres cluster into the cloud data environment that `b2f62c36` (cloud deployment foundation) and `206927ed` (production runtime configuration) bring up. Rehearse the move end-to-end on staging first (see predecessor `d37681e1`); this task runs the same procedure against production once staging evidence is accepted.

The migration has four required outcomes:

1. Production data is transferred with documented reconciliation evidence and no unexplained loss or duplication.
2. Required Prisma migrations complete cleanly against the migrated data.
3. A backup of the migrated production data restores into a usable service state on demand.
4. The procedure handles failure, interruption, and safe retry without corrupting source or destination.

## Ownership boundary check

- Data ownership: each service (`tasks-api`, `budget-api`, `gymtrack-mcp`) owns its own Postgres database; the cloud cutover moves each database into its own database in the cloud Postgres cluster. There is no shared database and no shared migration runner.
- Migration tooling lives in `infra/migrations/` as plain shell + Python scripts that call `pg_dump` / `pg_restore` / `psql` / `prisma migrate`. It does not become a service: there is no durable API, no auth, no scheduled job. Once production is moved, the scripts are retained as one-shot evidence, not as a deployable runtime.
- Reconciliation evidence lands in `infra/migrations/evidence/<run-id>/` (counts, checksums, sequence values, restore logs) and is referenced from the task description on completion.
- Backup storage lives in the cloud object store provisioned by `b2f62c36`; retention and access policy are governed by `206927ed`, not duplicated here.
- `.openclaw` boundary: the cloud Postgres connection strings, S3 credentials, and bastion/SSH config that the scripts consume live in `~/.openclaw/.env` (and per-agent env files). The scripts read them at run time; nothing is committed to the repo.

## Preconditions

This task runs only after:

1. `d37681e1` (Validate staging database migration and restore) reaches `done` with all four ACs verified and accepted by Tom. The spec note is explicit: "This task may proceed only after the staging database migration and restore evidence is accepted."
2. `b2f62c36` (cloud deployment foundation) reaches `done` — the target Postgres cluster and network reachability exist.
3. `206927ed` (production runtime configuration) reaches `done` — connection strings, secrets, and backup bucket are wired in `~/.openclaw/.env`.
4. Tom has approved the product spec (currently Draft at `brain/tasks/specs/open/production-data-migration-restore.md`). If Tom revises the spec, this design is re-evaluated.

## Migration approach

Use `pg_dump` / `pg_restore` in directory-format with parallel workers (`--jobs`), schema-only + data-only split, and a transaction-wrapped restore so a partially-applied dump can be detected and rolled back. Logical replication is intentionally not used: the staging rehearsal in `d37681e1` proved that a planned-downtime window is acceptable, and logical replication would add cutover complexity that buys us no extra safety beyond what the rehearsal already covers.

The high-level sequence:

1. **Quiesce source writes.** Drain writes to the source databases by stopping the source app instances (or moving them into a read-only mode if the app supports it). Capture a final pre-cutover row-count snapshot of every table.
2. **Dump source.** Run `pg_dump --format=directory --jobs=<n> --no-owner --no-privileges` against each source database. Output goes to a staging volume on the cutover host.
3. **Pre-restore validation.** Verify the dump is internally consistent (`pg_restore --list` succeeds; `pg_restore --schema-only --no-owners` on a throwaway DB parses cleanly). Reject and re-dump if validation fails.
4. **Restore target.** Drop and recreate the target database in the cloud cluster. Apply Prisma migrations via `prisma migrate deploy` to bring the schema to head. Then `pg_restore --jobs=<n> --exit-on-error --single-transaction` the dump into the target.
5. **Reconcile.** Compare source and target row counts, sequence values, and a sampled MD5 checksum of every TEXT/BYTEA column for every table. A column is "in scope" for checksumming if its content is fully determined by source data (so no floating-point columns, no `now()` defaults). Mismatches halt the cutover and trigger a re-run from step 1.
6. **Cutover.** Update the cloud app's `DATABASE_URL` (via `~/.openclaw/.env` plus restart) so the next request hits the target DB. Apps read connection strings on boot, so a rolling restart of each service is enough.
7. **Smoke.** Run a small suite of read/write smoke checks against each service in the target cluster (e.g., create a task, list a budget category, fetch a GymTrack workout). If any smoke check fails, the procedure moves to rollback (see Failure handling).
8. **Source freeze.** Leave the source DBs online but quiesced for a configurable hold window (default 24h) before final decommission.

## Reconciliation evidence

Every cutover produces a manifest at `infra/migrations/evidence/<run-id>/`:

- `pre-cutover-counts.csv`: per-table row counts from source before dump.
- `post-restore-counts.csv`: per-table row counts from target after restore.
- `counts-diff.csv`: zero-difference report or a per-table delta. AC1 is satisfied iff every delta is exactly zero.
- `sequences.csv`: source vs target `last_value` for every sequence. AC1 is satisfied iff every delta is exactly zero.
- `checksums.csv`: per-table, per-column MD5 sampled across the full table. AC1 is satisfied iff every checksum matches.
- `prisma-migrate-deploy.log`: clean run of `prisma migrate deploy` against the target. AC2 is satisfied iff no `*_failed_migration` rows remain in `_prisma_migrations`.
- `restore-from-backup.log`: full restore of the backup artefact into a clean throwaway database, followed by the same smoke checks as step 7. AC3 is satisfied iff all smoke checks pass against the restored database.
- `manifest.json`: run ID, source/target connection names (no credentials), timestamps, and SHA256 of every other file in the directory. The manifest is uploaded to the backup bucket so it survives host loss.

## Backup and restore

The backup is the dump produced in step 2, plus the pre-restore schema snapshot. We do not depend on `pg_basebackup` or PITR: PITR requires archive-WAL plumbing that is out of scope for this cutover, and a one-shot dump is enough to satisfy "a backup that restores into a usable service state."

Restore procedure (AC3):

1. Provision a throwaway database in the cloud cluster (`pg_createbackupdb` or `CREATE DATABASE …`).
2. Apply Prisma migrations to bring schema to head.
3. `pg_restore --jobs=<n> --exit-on-error` the dump.
4. Run the smoke suite from step 7 against the throwaway DB.
5. Tear down the throwaway DB.

The whole restore is exercised in CI on every rehearsal run (see Test plan). For production, the restore is run at least once after the cutover as live evidence, and the artefact + restore log are stored alongside the cutover manifest.

## Failure handling

Failure modes and the procedure for each:

- **Dump fails or produces an invalid archive.** Abort. The source DBs are untouched. Re-run after fixing the cause.
- **Restore fails mid-way (a row violates a constraint, disk full, network drop).** Restore runs `--single-transaction`, so the entire restore rolls back. The target database is dropped and recreated; the source is untouched.
- **Reconciliation finds mismatched counts or checksums.** Halt cutover before step 6. The source DBs are still quiesced. Drop the target database, fix the cause (typically a missed table or a Prisma migration applied to the source but not the target), re-dump from source, and re-run from step 3.
- **Smoke check fails after cutover (step 7).** The cloud apps are already pointing at the target. Roll back to source: update `DATABASE_URL` back to the source cluster, restart apps, run the same smoke checks against the source to confirm it is still in a quiesced but consistent state. The target database is preserved for forensics.
- **Cutover host loses connectivity mid-cutover.** The script is idempotent up to step 4 (drop + restore). Re-running after reconnecting produces the same target state. If cutover is past step 6 (apps repointed), the failure is treated as a smoke failure: roll back to source.
- **Safe retry requirement (AC4):** no script writes to source. Source is read-only throughout. The target is rebuilt from scratch on every retry. There is no incremental merge step that could double-write rows.

A runbook at `infra/migrations/PRODUCTION_CUTOVER.md` documents the exact operator commands and decision points, mirroring the rehearsal runbook at `infra/migrations/STAGING_REHEARSAL.md` (added in `d37681e1`).

## Implementation plan

The cutover is a single deployable cut but the implementation is staged so each cut is independently mergeable and reviewable:

1. **Cut 1 — Reusable migration scripts.** Add `infra/migrations/{dump,restore,reconcile,smoke}.py` plus a top-level `infra/migrations/run.sh` that drives them. The scripts accept the source/target/backup targets via environment variables only; no credentials in the repo. Reconciliation evidence lands at the path described above. Rehearsal on staging (covered by `d37681e1`) exercises this cut end-to-end.
2. **Cut 2 — Restore verification CI.** Wire `restore-from-backup.py` into a CI job that runs on every change to `infra/migrations/`. The job spins up a throwaway Postgres (the existing CI Postgres service), dumps and restores into it, and runs the smoke suite. This guards against future regressions in the migration tooling.
3. **Cut 3 — Production runbook and execution.** Add `infra/migrations/PRODUCTION_CUTOVER.md` and execute the production cutover in a controlled window. Land the manifest + logs in the repo (`infra/migrations/evidence/prod-<run-id>/`) on the same PR that records completion, so reviewers see the evidence inline.

No application code changes are required by this task. `apps/*` and `services/*` are unchanged.

## AC verification matrix

| AC | Verification |
| --- | --- |
| AC1 | `counts-diff.csv` shows zero row-count delta per table and `sequences.csv` shows zero sequence-value delta; `checksums.csv` shows per-table, per-column MD5 match across every in-scope column. Manual review confirms no unexplained loss or duplication. |
| AC2 | `prisma migrate deploy` log shows clean apply against the target; `_prisma_migrations` has no `failed_migration` rows; representative staging-equivalent workflows (create a task, post a budget transaction, fetch a GymTrack workout) succeed against the migrated DB. |
| AC3 | Restore smoke run from `restore-from-backup.log` completes against a throwaway DB and all smoke checks pass; backup artefact SHA256 matches the manifest; throwaway DB is torn down. |
| AC4 | Negative tests cover: invalid dump, mid-restore failure, count mismatch, sequence mismatch, checksum mismatch, smoke failure post-cutover. Each negative test confirms the source DB is byte-for-byte unchanged and the retry procedure produces a clean target. CI restore job exercises the full retry path on every change to the migration tooling. |

Validation gates: `pg_dump --list` and `pg_restore --list` clean parse, `prisma migrate deploy` exit 0, `infra/migrations/tests/test_restore.py` pass, smoke suite pass against restored DB, full cutover rehearsal in staging (per `d37681e1`) accepted.

## Open questions and risks

- **Downtime window.** The cutover requires writes to be quiesced on the source. The exact window is owned by Tom and is not in scope here; the runbook captures the agreed window and rollback decision points.
- **Multi-database coordination.** Tasks API, budget API, and GymTrack MCP each own their own DB. The runbook migrates them in sequence; smoke checks run against each before moving to the next. A parallel-migration plan was considered and rejected: it complicates rollback without meaningfully shortening the window.
- **Schema drift between source and target.** If Prisma migrations are applied to source after the staging rehearsal but before the production cutover, the dump and the target schema may diverge. Mitigation: freeze schema changes between `d37681e1` done and the production cutover, re-validate in the runbook, and re-dump if any migration lands.
- **Backup retention and encryption.** The backup artefact is uploaded to the bucket provisioned by `206927ed` with the same encryption-at-rest policy. Retention beyond the cutover hold window is governed by the production-runtime task, not duplicated here.
- **Spec is still Draft.** This design assumes the current AC wording holds. If Tom revises the spec during review, this design is re-evaluated before implementation starts.

## `.openclaw` boundary

- Postgres source/target connection strings, S3 credentials, and bastion/SSH config live in `~/.openclaw/.env` and per-agent env files. The migration scripts read them at run time and never log them. The scripts do not commit anything that would reveal credentials.
- No cron, scheduled job, or long-running worker is added by this task. The migration is a one-shot operator-driven procedure.
- No agent identity or task API mutation is involved. This task does not post or modify task state beyond the `[tech-design]`, `[implementer-prs]`, and evidence comments called out in WORKFLOW.md.