---
status: draft
task_id: d37681e1-2666-425b-bf1d-5edd4f4be7ce
product_spec: brain/tasks/specs/open/staging-database-migration-restore.md
shipped_pr: null
shipped_date: null
---

# Validate staging database migration and restore

## Links and delivery metadata

- Product spec: `brain/tasks/specs/open/staging-database-migration-restore.md`
- Parent migration index: `brain/tasks/specs/open/sindustries-cloud-migration.md` (workstream 5 of 7)
- Task: `d37681e1-2666-425b-bf1d-5edd4f4be7ce`
- Task title: `🔧 Validate staging database migration and restore`
- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-d37681e1-2666-425b-bf1d-5edd4f4be7ce-staging-database-migration-restore`
- Worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/rowan-staging-db-migration`
- Tech design: `docs/specs/staging-database-migration-restore-tech-design.md`

## Product intent

The product spec makes staging the rehearsal and recovery gate for production data migration. Representative data must reach the cloud destination without unexplained loss or duplication, checked-in migrations and workflows must still work, a post-migration backup must restore into a usable service, and interruption/retry behavior must be proven without corrupting either side.

The result is a repeatable, auditable database-transfer procedure—not a one-off successful `pg_dump` command.

## Clarification and assumptions

No clarification is needed before design approval because this task is dependency-blocked on the cloud staging environment (`2850c5ac-252e-404a-863b-b83755b2f618`), which supplies the actual source/destination endpoints and deployment interface. This design intentionally remains PostgreSQL/provider-neutral.

Assumptions:

1. The approved staging task provides isolated source and cloud destination databases containing only synthetic, masked, or otherwise approved non-production data.
2. Both current PostgreSQL schemas are in scope: `tasks_api` and `budget_api`. They are owned by their respective services even if the cloud foundation places them in one physical database.
3. The source remains authoritative and read-only for the transfer rehearsal. Destination and recovery databases are disposable, uniquely named/labelled staging resources.
4. The destination supports PostgreSQL 16-compatible `pg_dump`/`pg_restore`; the client major version must equal the server major version unless a documented provider compatibility guarantee says otherwise.
5. Redis/BullMQ contents are not migrated. Content Scheduler queue state is derived from `tasks_api.ContentSchedulerItem` and is rebuilt by worker startup reconciliation.

## Scope

In scope:

- inventory and preflight of both service-owned schemas;
- a consistent, encrypted-in-transit custom-format PostgreSQL archive;
- restore into a fresh cloud staging destination;
- checked-in Prisma migration deployment for both services;
- aggregate and invariant reconciliation without exposing row data;
- representative staging workflows after migration;
- a post-migration backup restored into a second isolated recovery database;
- interruption and retry drills for dump, restore, and workflow recovery;
- a redacted evidence record and operator runbook.

Out of scope:

- production data or production traffic;
- provider/database selection and base provisioning;
- cross-service schema consolidation;
- migration of Redis queues;
- application schema changes unrelated to making the rehearsal safe;
- destructive retry in place against a partially restored destination.

## Architecture and ownership boundary

### Natural source of truth

This is a **database-backed domain data plus operational workflow boundary**. Each service continues to own its schema and Prisma migrations. Shared orchestration may snapshot and verify both schemas atomically, but it must not move budget tables into Tasks API ownership or let either service query the other's schema.

- `services/tasks-api/prisma/migrations/` owns `tasks_api` schema evolution.
- `services/budget-api/prisma/migrations/` owns `budget_api` schema evolution.
- `scripts/cloud/database/` owns provider-neutral backup/restore orchestration and safety preflights.
- `services/<service>/ops/reconciliation.sql` owns service-specific aggregate/invariant queries because the owning service understands its data.
- PostgreSQL archive objects are operational artifacts stored in the approved encrypted provider bucket/location, never Git.
- `docs/infra/` stores only the redacted evidence summary and artifact checksums/references.

A durable reusable transfer harness is approximately the same effort as a collection of manual commands and materially lowers production-migration risk, so no interim ad-hoc shim is justified.

### Transfer topology

```text
approved staging source PostgreSQL
  ├─ tasks_api schema ──┐
  └─ budget_api schema ─┴─ read-only consistent pg_dump snapshot
                               │ TLS
                               ▼
                         encrypted custom archive
                               │
                     fresh cloud staging database
                               │
               Prisma migrate deploy (per owning service)
                               │
              reconciliation + staging workflow validation
                               │
                    post-migration custom archive
                               │
                     fresh recovery-test database
                               │
             migrations + reconciliation + workflow validation
```

The destination is never used as a retry target after a partial restore. A failed attempt is quarantined and a new empty database is created, preventing hidden partial-state acceptance.

## Implementation plan and file scope

### 1. Define the guarded database tooling

Add:

- `scripts/cloud/database/common.sh` — strict shell mode, required command/version checks, TLS enforcement, environment assertions, redacted logging, run IDs, and cleanup helpers.
- `scripts/cloud/database/inventory.sh` — records server version, schema list, Prisma migration state, extension list, relation sizes, and aggregate row counts without row contents.
- `scripts/cloud/database/dump.sh` — creates `<run-id>.dump.partial`, uses `pg_dump --format=custom --no-owner --no-acl --schema=tasks_api --schema=budget_api`, verifies the archive with `pg_restore --list`, calculates SHA-256, then atomically renames to `<run-id>.dump`.
- `scripts/cloud/database/restore.sh` — requires a fresh destination assertion, restores with `pg_restore --exit-on-error --no-owner --no-acl`, and writes a non-secret result envelope.
- `scripts/cloud/database/migrate.sh` — runs `prisma migrate deploy` separately from each service with that service's schema-qualified `DATABASE_URL`, then queries `_prisma_migrations` for failed/pending state.
- `scripts/cloud/database/reconcile.mjs` — runs source and destination service-owned reconciliation manifests, compares normalized outputs, and emits booleans/deltas rather than values.
- `scripts/cloud/database/drill.sh` — orchestrates transfer, post-migration backup, recovery restore, interruption cases, workflow checks, and cleanup.

Connection strings are read from mode-`0600` files or process environment populated by the provider secret runner. They are never accepted as positional arguments, echoed, placed in manifests, or written to GitHub logs. `sslmode=require` (or stronger provider verification) is mandatory for remote connections.

Every mutating command requires all of:

- provider account/project assertion;
- `environment=staging` resource label;
- database name/prefix allowlist;
- source and destination host/database inequality;
- destination emptiness/fresh-run marker;
- run ID and explicit `--confirm <run-id>` for cleanup/drop operations.

The source role receives `CONNECT` and `SELECT` only. The destination role may create/restore only inside the designated staging database.

### 2. Add service-owned reconciliation manifests

Add:

- `services/tasks-api/ops/reconciliation.sql`
- `services/budget-api/ops/reconciliation.sql`

The manifests return stable, named aggregate checks:

- row count and distinct primary-key count for every owned table;
- min/max creation/update timestamps where present;
- required foreign-key orphan counts (expected zero);
- uniqueness checks matching domain constraints (expected zero duplicate groups);
- Tasks-specific counts by task status/type, dependency/comment/tag totals, approval/attention totals, and Content Scheduler status totals;
- Budget-specific counts by domain table, transaction direction/category-source totals, encrypted Akahu token null/length-class checks (never decryption or bytes), and sum/count checks for integer money fields grouped only at a non-identifying global level;
- Prisma applied-migration names/checksums and failed/pending count.

The comparison result records `match`, source count, destination count, and numeric delta only. It does not record task titles, comments, emails, token bytes, merchant text, IDs, or sample rows. A mismatch fails the run until explained and approved; the harness never auto-waives a delta.

For defence against equal-count/different-row errors, the harness computes an in-memory deterministic digest over canonical primary-key sets per table on both sides and records only `digestMatch: true|false`; raw IDs and digests are not committed to the evidence document.

### 3. Execute the initial transfer and migrations

The runbook sequence is:

1. verify both endpoints, versions, labels, free space, credentials, and connectivity;
2. stop staging fixture writers or place the approved source in a documented quiet window;
3. capture the source inventory and one consistent custom archive of both schemas;
4. provision a brand-new destination database from the foundation interface;
5. restore the archive;
6. run `prisma migrate deploy` for Tasks API, then Budget API, each against its owned schema;
7. run reconciliation and fail closed on any unexplained difference;
8. deploy staging services against the destination and run the black-box staging workflow harness delivered by task `2850c5ac-252e-404a-863b-b83755b2f618`;
9. resume staging fixture writers only after all checks pass.

A full schema archive is preferred over data-only loading because it preserves schema objects and `_prisma_migrations` consistently in an empty database. Checked-in migrations still run afterward, proving forward application from the captured source state. If the provider forbids database-level restore operations, restore into a provider-created empty database using schema-owner privileges; do not fall back to overwriting existing schemas.

### 4. Prove backup recovery after migration

After the migrated destination passes reconciliation/workflows:

1. create a new post-migration custom archive with the same guarded path;
2. verify archive listing/checksum and record object version/retention metadata;
3. provision a second uniquely named recovery-test database;
4. restore the post-migration archive;
5. run both Prisma migration commands (expected no failed migrations and no unaccounted pending migrations);
6. run full reconciliation between migrated destination and recovery database;
7. point ephemeral service instances at the recovery database and run health plus representative Tasks, Budget, and Content Scheduler workflow checks;
8. destroy the ephemeral service instances and recovery database only after evidence is captured.

“Usable service state” therefore means more than a successful `pg_restore`: services boot, owned schemas reconcile, authenticated reads/writes work, and the Content Scheduler worker can reconstruct queue state from PostgreSQL.

### 5. Verify interruption and retry safety

`drill.sh` covers three bounded failures on disposable resources:

- **Interrupted dump:** terminate `pg_dump`; assert only `.partial` exists, archive verification fails, and no restore can consume it. Retry creates a new run ID and complete archive.
- **Interrupted restore:** terminate `pg_restore`; assert the attempt is marked failed/quarantined. Do not resume or re-run against the same database; create a fresh destination and restore from the verified archive.
- **Interrupted workflow/worker:** stop the ephemeral Content Scheduler worker after restore, restart it, and verify startup reconciliation rebuilds missing delayed-job state without duplicate publish. No real external publish occurs.

The source is unchanged in all drills. Retry cleanup is idempotent and scoped by run label. The script must refuse `--clean`, `DROP DATABASE`, or destructive schema operations when the target lacks the exact staging run marker.

Prisma migration failure is tested in CI using a disposable PostgreSQL container and a deliberately invalid test-only migration fixture outside the production migration directories. The assertion is that orchestration stops, reports the owning service/migration, performs no workflow validation, and requires a new destination; production migration history is never edited or auto-resolved.

### 6. Workflow, runbook, and evidence

- Add `.github/workflows/cloud-staging-db-drill.yml` as `workflow_dispatch` only, protected by the GitHub `staging` environment and concurrency group `cloud-staging-database`. It runs preflight/inventory, requires an operator confirmation input, executes the drill, and uploads redacted JSON. Archive transfer uses the provider's encrypted artifact store, not GitHub artifacts.
- Add `docs/runbooks/staging-database-migration-restore.md` with prerequisites, commands, go/no-go criteria, interruption semantics, cleanup, credential rotation, and escalation.
- Add `docs/infra/staging-database-migration-validation-<YYYY-MM-DD>.md` with run IDs, source/destination resource aliases (not DSNs), commit, archive checksum/reference, reconciliation summary, workflow result, failure-drill result, cleanup status, blockers, and verdict.
- Update the consolidated cloud system doc created by the foundation/staging tasks (expected `docs/systems/cloud-runtime.md`) with the shipped migration/restore procedure and ownership boundaries.

## Data model and API contract

No product table, column, or public HTTP contract change is planned.

Operational contracts added by this task:

- archive format: PostgreSQL custom format containing `tasks_api` and `budget_api`, no ownership/ACL records;
- reconciliation output: versioned JSON with `runId`, endpoint aliases, commit, per-check source/destination counts, delta/match, migration states, workflow results, and cleanup status;
- database target contract: one Tasks URL ending in `?schema=tasks_api` and one Budget URL ending in `?schema=budget_api`, even when both address the same database host/database;
- queue recovery contract: PostgreSQL is canonical and Redis jobs are rebuilt through existing worker reconciliation.

If implementation discovers a schema change is required solely to perform transfer/reconciliation, stop and revise the design. Operational tooling must not mutate product models for convenience.

## Workflow, cron, and skill changes

- One manual staging database drill workflow is added. There is no cron: database transfer and fault injection require an operator-selected source/destination and confirmation.
- No agent skills or Lobster workflows change.
- Existing Prisma scripts (`prisma:migrate`) remain the only application migration entrypoints; orchestration calls them rather than duplicating migration SQL.
- `scripts/dev/migrate-db.sh` remains local dev/prodlike tooling and is not stretched to accept cloud endpoints. Cloud safety assertions warrant a separate operational boundary.

## `.openclaw` boundary

No `.openclaw` change is required. OpenClaw remains local and must not receive staging database credentials. Validation calls the staging services through explicit endpoints; it does not point local agent processes directly at cloud PostgreSQL.

If implementation later discovers an OpenClaw-owned temporary endpoint is necessary, Rowan must post `[openclaw-needed]` with exact path, proposed diff, validation command, and rollback; Rowan must not edit `~/.openclaw/`.

## Test plan and acceptance-criterion verification matrix

| AC | Planned verification | Layer / evidence |
|---|---|---|
| AC1 — representative staging data transfers with reconciliation and no unexplained loss/duplication | Create one consistent archive, restore to a fresh cloud staging database, compare every owned table's count/distinct-PK count, primary-key-set match, domain aggregates, orphan/duplicate checks, and migration history. Any non-zero unexplained delta fails. | Operational database integration/E2E via `drill.sh`; redacted reconciliation JSON and `docs/infra/staging-database-migration-validation-<date>.md`. Row-level E2E is inappropriate because evidence must not expose data. |
| AC2 — required database changes complete and staging workflows continue | Run each service's `prisma migrate deploy`; assert no failed/pending-unaccounted migrations; deploy services to migrated DB; execute authenticated Tasks, Budget, and Content Scheduler staging workflows. | Real staging environment E2E. Existing service integration suites remain regression coverage; the cloud workflow is the acceptance layer. |
| AC3 — migrated backup restores into usable service state | Back up the migrated destination, restore into a second fresh recovery DB, reconcile destination→recovery, boot ephemeral API/worker processes, and rerun health/authenticated workflow checks. | Operational restore E2E with archive checksum, restore logs, reconciliation, and black-box service results. |
| AC4 — failure/interruption/retry is documented and verified safely | Interrupt dump and restore on disposable resources, verify `.partial`/quarantine semantics, retry with new run IDs/fresh DBs, interrupt/restart worker and verify reconciliation, run CI migration-failure fixture, and prove source aggregate state is unchanged. | Shell integration tests + disposable PostgreSQL CI + staging operational drill + runbook inspection. |

Additional gates:

- `shellcheck` for shell scripts and unit tests for target guards/redaction;
- JSON schema validation for run output;
- PostgreSQL 16 container test covering successful full transfer and recovery restore;
- existing Tasks API/Budget API Prisma validation and integration tests;
- gitleaks plus explicit scan that no DSN, email, row ID, title/comment, merchant text, or token material appears in committed evidence;
- cleanup run twice to prove idempotence.

## Risks and mitigations

- **Equal row counts can hide replacement/duplication.** Compare distinct PK counts, in-memory canonical PK-set equality, invariants, and aggregates; do not accept counts alone.
- **Dump consistency across two schemas.** Use one `pg_dump` invocation/transaction over both schemas during a source quiet window. Record start/end timestamps and source activity state.
- **Managed Postgres privilege limits.** Preflight exact capabilities. Restore only into a fresh provider-created DB/schema with owner privileges; never weaken provider security or require superuser-only trigger disabling.
- **Partial restore accepted accidentally.** Every failed restore target is quarantined; retry always provisions a new target and acceptance requires archive verification, migration state, reconciliation, and workflows.
- **Migration ordering between services.** Run each service's migration command independently against its own schema. There are no cross-schema foreign keys; if one appears, stop and treat it as an architecture violation.
- **Sensitive Budget data in logs/evidence.** Queries return aggregates only; encrypted token bytes are never decrypted or printed; DSNs and row data are redacted.
- **Queue jobs absent after restore.** Redis is intentionally not copied. Worker startup reconciliation must restore scheduled state from PostgreSQL and is included in both migration and recovery tests.
- **Destructive target typo.** Dual environment/name/label checks, source/destination inequality, least privilege, and explicit run-ID confirmation fail closed.

## Open questions

1. Will the foundation use one physical PostgreSQL database with two schemas or separate databases? The harness supports both by accepting two service DSNs; one archive can cover both schemas only when they share a database. If separate, produce one synchronized run containing two archives and require both to pass before acceptance.
2. What encrypted artifact store and retention policy does the foundation provide? Record object version/checksum and minimum retention in the runbook; do not place archives in GitHub artifacts.
3. What source quiet-window mechanism does the staging task expose? Default: stop synthetic writers and validation workflows while APIs remain read-only/unrouted. If writes cannot be paused, use provider-supported snapshot/export semantics and document the consistency boundary.
4. Which representative Budget write will the staging harness use without live Akahu data? Consume the approved staging design's choice rather than create a second fixture path here.
