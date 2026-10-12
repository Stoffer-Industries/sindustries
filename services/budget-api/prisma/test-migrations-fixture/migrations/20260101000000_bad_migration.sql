-- Deliberately invalid migration used by the AC4 CI migration-failure
-- fixture (task d37681e1). Mirror of the tasks-api fixture, scoped to
-- the budget_api schema. See services/tasks-api/prisma/test-migrations-fixture/
-- for the contract; production prisma migrate deploy never reads this
-- path because the fixture harness overrides PRISMA_MIGRATIONS_DIR.
CREATE TABLE "budget_api"."_ac4_bad_migration_marker" (
  "id" TEXT NOT NULL REFERENCES nonexistent_type_d4e3 (id)
);
