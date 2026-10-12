-- Deliberately invalid migration used by the AC4 CI migration-failure
-- fixture (task d37681e1). Lives in a sibling directory of the
-- production prisma/migrations/ tree; production prisma migrate deploy
-- never reads this path. The fixture harness overrides
-- PRISMA_MIGRATIONS_DIR before invoking prisma, so production deploys
-- are unaffected.
--
-- References a type that does not exist so Prisma returns a
-- deterministic SQL error ("type "nonexistent_type_d4e3" does not
-- exist") that the test can match on without parsing free-form stderr.
CREATE TABLE "tasks_api"."_ac4_bad_migration_marker" (
  "id" TEXT NOT NULL REFERENCES nonexistent_type_d4e3 (id)
);
