-- Deliberately invalid migration used by the AC4 CI migration-failure
-- fixture (task d37681e1). Mirrors the tasks-api fixture but scoped
-- to the budget_api schema; the harness invokes prisma against this
-- directory via a temp-dir schema, so production migration history
-- is never edited.
--
-- References a type that does not exist so Prisma returns a
-- deterministic SQL error ("relation \"nonexistent_type_d4e3\" does
-- not exist", Postgres 42P01) that the harness can match on without
-- parsing free-form stderr.
CREATE TABLE "budget_api"."_ac4_bad_migration_marker" (
  "id" TEXT NOT NULL REFERENCES nonexistent_type_d4e3 (id)
);
