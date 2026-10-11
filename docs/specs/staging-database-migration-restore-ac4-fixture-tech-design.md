---
status: draft
task_id: d37681e1-2666-425b-bf1d-5edd4f4be7ce
product_spec: brain/tasks/specs/in-progress/staging-database-migration-restore.md
shipped_pr: null
shipped_date: null
---

# AC4 migration-failure CI fixture (task d37681e1)

## Links and delivery metadata

- Parent task: `d37681e1-2666-425b-bf1d-5edd4f4be7ce` — "Validate staging database migration and restore"
- Parent tech design: `docs/specs/staging-database-migration-restore-tech-design.md` (Quinn-approved 2026-08-15, ee920b05 on `task-d37681e1-...-staging-database-migration-restore`)
- AC1–AC3 main delivery: PR #778 (commit 2f51f979), PR #786 (commit b7e23040), PR #791 (commit 9b87dbb8)
- Repository: `Stoffer-Industries/sindustries`
- Branch: `d37681e1-ac4-fixture`
- Worktree: `/Volumes/WD1/worktrees/quinn/d37681e1-ac4-fixture`
- Tech design: `docs/specs/staging-database-migration-restore-ac4-fixture-tech-design.md`

## Product intent

AC4 of task d37681e1 says: "Failure, interruption, and safe retry behaviour are documented and verified without corrupting the source or destination."

PR #778 explicitly deferred the **CI migration-failure fixture** ("CI migration-failure fixture in a disposable PostgreSQL container (AC4 partial coverage)") and Ash's 2026-10-10 qa-agent-blocked verdict re-confirmed the gap. The interruption drills (dump, restore, worker) are already covered by `drill.sh --interruption` and the 17 unit tests on `scripts/cloud/database/common.sh`. The remaining slice is a CI-provable migration-failure test.

This design delivers that slice without re-opening the parent design.

## Clarification and assumptions

No clarification is needed before design approval because:

- The parent tech design (Quinn-approved 2026-08-15) already specifies the exact behaviour the fixture must assert: "Prisma migration failure is tested in CI using a disposable PostgreSQL container and a deliberately invalid test-only migration fixture outside the production migration directories. The assertion is that orchestration stops, reports the owning service/migration, performs no workflow validation, and requires a new destination; production migration history is never edited or auto-resolved."
- The shell tooling (`scripts/cloud/database/common.sh`, `migrate.sh`, `drill.sh`) is already merged on `main` and is what the fixture exercises.
- The CI test will use a disposable PostgreSQL service in the GitHub Actions runner, not a Neon/cloud database, so it does not depend on the staging Environment secrets Quinn is separately provisioning.

Assumptions:

1. The test uses the runner's `services: postgres:` declaration with PostgreSQL 16 to match the parent design's version assumption.
2. The invalid migration fixture is **outside** the production `prisma/migrations/` directories and is loaded with an explicit override path so `migrate.sh` never reaches a production migration directory.
3. The migration-failure assertion runs the existing `scripts/cloud/database/migrate.sh` against the disposable container, capturing its exit code, stderr, and the post-failure state of `_prisma_migrations`. It does not modify any production migration directory.
4. AC1–AC3 evidence still needs the live staging drill (Quinn operator step on the post-#791 head); this fixture is a parallel CI gate, not a substitute for the staging environment evidence.

## Scope

In scope:

- A new test-only migration directory `services/<service>/prisma/test-migrations-fixture/` containing exactly one deliberately invalid migration (e.g. a `CREATE TABLE` referencing a non-existent type), per the parent design's "outside the production migration directories" rule.
- A new bash harness `tests/cloud/staging-db-migration-failure-drill.sh` that:
  - Stands up the disposable PostgreSQL container (via `services: postgres:` when run in GitHub Actions, or via a local `postgres:16` Docker container when run from a developer machine).
  - Points `scripts/cloud/database/migrate.sh` at the disposable DSN with an explicit `PRISMA_MIGRATIONS_DIR` override to the test-only directory.
  - Captures exit code, stderr summary, and the post-failure state of `_prisma_migrations`.
  - Asserts: source untouched, no destination mutations beyond the failed migration's atomic transaction, exit code = 1, stderr names the owning service + migration, no `prisma migrate resolve` was attempted, the failed migration row remains in `_prisma_migrations` with a `failed` status.
- A companion bash test `tests/cloud/tests/staging-db-migration-failure-drill.test.sh` that stubs the harness and asserts the same conditions the harness emits.
- A new GitHub Actions workflow `cloud-staging-db-failure-fixture.yml` (or a `migration-failure` job inside the existing `cloud-staging-db-drill.yml`) gated on `workflow_dispatch` + a concurrency group so the fixture can be re-run on demand.

Out of scope:

- The live staging Environment drill (AC1–AC3) — Quinn owns that operator step.
- The `dump`/`restore`/`worker` interruption drills already covered by `drill.sh --interruption` and the `common.sh` unit tests.
- Any change to the existing `scripts/cloud/database/*` shell tooling; this design is additive.
- Production `prisma/migrations/` directories; the fixture never writes to them.

## Architecture and ownership boundary

### Natural source of truth

This is a **test-only operational fixture plus a CI workflow gate**. The natural source of truth is:

- `scripts/cloud/database/migrate.sh` (already shipped) owns the migration orchestration contract.
- The new `services/<service>/prisma/test-migrations-fixture/` directory owns the deliberately invalid migration artifact, scoped per service to match the production directory layout.
- `tests/cloud/staging-db-migration-failure-drill.sh` owns the disposable-container driver and the assertion envelope.
- `.github/workflows/cloud-staging-db-failure-fixture.yml` (or the new `cloud-staging-db-drill.yml` job) owns the CI scheduling and concurrency control.

A test-only fixture is approximately the same effort as a hand-rolled one-off in the existing drill workflow and materially lowers the chance of silently re-introducing a production-migration auto-resolve. No interim shim is justified.

### Failure-injection topology

```text
GitHub Actions runner (or local Docker)
  ├─ services: postgres:16 (disposable)         ← DSN: postgresql://postgres:postgres@localhost:5432/postgres?schema=tasks_api
  └─ scripts/cloud/database/migrate.sh
        ├─ PRISMA_MIGRATIONS_DIR=.../test-migrations-fixture
        ├─ DATABASE_URL=<disposable DSN>
        └─ exit 1, stderr names tasks_api + bad_migration.sql

post-failure assertions:
  - _prisma_migrations rows: [bad_migration.sql, status=failed, rolled_back=true]
  - no other tables created in tasks_api schema
  - exit code = 1
  - no `prisma migrate resolve` invocation
  - no workflow validation attempted (drill.sh never reached reconcile / workflow steps)
```

The disposable container is destroyed at the end of the run; nothing persistent is created.

## Implementation plan and file scope

### 1. Add the test-only migration fixture

For each of `services/tasks-api` and `services/budget-api`, add a sibling directory:

- `services/tasks-api/prisma/test-migrations-fixture/migrations/20260101000000_bad_migration.sql` — a `CREATE TABLE` that references a non-existent type so Prisma reports a deterministic SQL error.
- `services/budget-api/prisma/test-migrations-fixture/migrations/20260101000000_bad_migration.sql` — same shape, scoped to `budget_api`.

Both files are short (≤ 10 lines), deterministic, and never executed against a production database because the fixture script overrides `PRISMA_MIGRATIONS_DIR` before invoking `prisma migrate deploy`.

### 2. Add the bash harness

Add `tests/cloud/staging-db-migration-failure-drill.sh`:

- Arg-parses: `--source-dsn <dsn>` (must be a `localhost`-rooted or runner-service DSN), `--prisma-migrations-dir <path>`, `--service <tasks-api|budget-api>`, `--output <path>`, `--confirm-staging`.
- Sources `scripts/cloud/database/common.sh` for the redacted logging + environment guards. Adds a `STAGING_DB_FAILURE_FIXTURE=1` marker so the guards' production-DSN-substring check is **relaxed** (the disposable DSN may not match the staging-host pattern) but the `sslmode=disable` / `localhost` allowlist is enforced.
- Runs `prisma migrate deploy --schema services/<service>/prisma/schema.prisma` with the overridden `PRISMA_MIGRATIONS_DIR`. Captures exit code, stderr, and stdout.
- Queries `SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at` from the disposable database and records each row in the result JSON (no row data, just metadata).
- Emits a JSON envelope matching the existing `tests/cloud/staging-validation.schema.json` shape: `schemaVersion`, `runId`, `intentCommit`, `environment`, `startedAt`, `endedAt`, `checks[]`, `cleanup[]`, `productionBlockers[]`, `verdict`.
- Returns exit `0` when `verdict=pass` (fixture behaved correctly), `1` when the fixture missed an assertion, `2` on harness/config error.

### 3. Add the test file

Add `tests/cloud/tests/staging-db-migration-failure-drill.test.sh`:

- Stubs `prisma` (or runs against the same disposable container) and asserts the harness:
  - rejects a non-local DSN unless `STAGING_DB_FAILURE_FIXTURE=1` is set;
  - refuses to write to a path that resolves under a production `prisma/migrations/` directory;
  - records the bad migration in `_prisma_migrations` with `rolled_back_at` set;
  - records `exit_code=1` in the result envelope;
  - does not record `prisma migrate resolve` was invoked;
  - does not record a workflow-validation check (it should not have been reached).

### 4. Add the CI workflow

Add `.github/workflows/cloud-staging-db-failure-fixture.yml` as `workflow_dispatch` only, gated on a concurrency group `cloud-staging-db-failure-fixture`. The workflow:

- Runs on `ubuntu-latest`.
- Declares `services: postgres: image: postgres:16` with the standard health check.
- Checks out the repo, sets up Node.js, installs the tasks-api and budget-api workspaces.
- Runs `bash tests/cloud/staging-db-migration-failure-drill.sh --service tasks-api --prisma-migrations-dir services/tasks-api/prisma/test-migrations-fixture --source-dsn postgresql://postgres:postgres@localhost:5432/postgres?schema=tasks_api&sslmode=disable --confirm-staging`.
- Repeats for `budget-api`.
- Uploads the redacted JSON envelopes as artifacts.

The workflow does **not** touch the live staging Environment, the cloud-staging-database concurrency group, or any of the four DSN secrets Quinn is provisioning for AC1–AC3.

## Data model and API contract

No product table, column, or public HTTP contract change.

Operational contract added by this task:

- `tests/cloud/staging-db-migration-failure-drill.sh` — disposable-DSN driver that exercises `migrate.sh` against a deliberately invalid migration and emits a `verdict=pass|fail` JSON envelope.
- The `_prisma_migrations` row recorded for the bad migration is the **only** schema-level artifact the fixture creates, and only inside the disposable container.
- `services/<service>/prisma/test-migrations-fixture/` is a test-only directory, ignored by production deployment paths because `migrate.sh` is always invoked with an explicit `PRISMA_MIGRATIONS_DIR` (the default in production stays at the real `prisma/migrations/`).

## Workflow, cron, and skill changes

- One new GitHub Actions workflow (or one new job in `cloud-staging-db-drill.yml`).
- No cron, no agent skill, no Lobster workflow changes.
- No change to `scripts/cloud/database/*` shell tooling.

## `.openclaw` boundary

No `.openclaw` change. The fixture uses the same disposable-container pattern that already exists in the parent design and does not interact with OpenClaw.

## Acceptance-criteria verification matrix

| AC  | Verification                                                                                     | Layer       | Evidence                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC4 | CI proves Prisma migration failure is detected, isolated, and does not corrupt the destination.  | CI          | `cloud-staging-db-failure-fixture.yml` workflow run + uploaded JSON envelopes from `tests/cloud/staging-db-migration-failure-drill.sh` for both services. |
| AC4 | `migrate.sh` stops before workflow validation when a migration fails.                           | Unit + E2E  | `tests/cloud/tests/staging-db-migration-failure-drill.test.sh` source-level check on the absence of a `drill_step workflow.*` invocation.             |
| AC4 | The fixture never writes to a production `prisma/migrations/` directory.                        | Unit        | `tests/cloud/tests/staging-db-migration-failure-drill.test.sh` rejects a `PRISMA_MIGRATIONS_DIR` that resolves under a real `prisma/migrations/`.   |
| AC4 | The unit-tested shell guards and `drill.sh --interruption` continue to cover dump/restore/worker interruption. | Unit | `scripts/cloud/database/tests/common.test.sh` (17 tests, already green) + the parent design's "Interruption and retry safety" section, referenced from the runbook. |

AC1–AC3 remain covered by the live staging Environment drill (Quinn operator step on the post-#791 head, awaiting the 4 DSN secrets).

## Open questions and risks

1. **Prisma migration name format.** Prisma 5 expects migration directories named `YYYYMMDDHHMMSS_name` and a `_prisma_migrations` table seeded by an initial migration. The fixture's deliberately invalid migration will need to be the only one applied so the assertion is unambiguous. Plan: pin the fixture to a deterministic timestamp and a deterministic filename so the result envelope can match by name.

2. **GitHub Actions `services:` host vs. localhost.** The disposable DSN is `postgresql://postgres:postgres@localhost:5432/...` (services hostnames resolve to localhost inside the job). Local developer runs use a `postgres:16` Docker container. The harness accepts both via a single DSN flag.

3. **The fixture's verdict is "pass" when the migration-failure path is correctly taken.** A reader unfamiliar with the design may mis-read "pass" as "the migration succeeded." Mitigation: the `productionBlockers` field in the result envelope is `[]` on pass and a non-empty array on pass-with-limitations; the runbook explicitly states "verdict=pass means the failure-injection worked and the system failed safely."

4. **Tooling version drift.** The `shellcheck --severity=warning` lint fix in PR #787 covers the new files the same way it covers the rest of `scripts/cloud/database/` and `tests/cloud/`. The npm `lint:cloud-db` script will be extended in the implementation PR if needed (single-line, same pattern).

## Plan summary

1. Land the test-only migration directories under both services.
2. Land `tests/cloud/staging-db-migration-failure-drill.sh` + the companion test.
3. Land `.github/workflows/cloud-staging-db-failure-fixture.yml`.
4. Verify lint-clean + unit tests green on the branch; open draft PR; post [tech-design] URL.
5. After Quinn's tech_design approval, convert draft → ready and post [implementer-prs] for the AC4 fixture.
6. AC1–AC3 evidence still requires Quinn's operator re-trigger of the live drill; this fixture is a parallel CI gate and does not unblock that.
