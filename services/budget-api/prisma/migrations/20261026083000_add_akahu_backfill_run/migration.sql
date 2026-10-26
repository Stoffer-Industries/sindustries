-- Add the Akahu backfill run record (task a37b31c9, AC6).
--
-- A bounded backfill is a data-repair operation over financial records, so
-- it leaves an auditable record of the window it covered and what it did.
-- The table is written only by the backfill code path
-- (src/services/akahuBackfill.ts); a dry run writes nothing at all.
--
-- The table is additive: no existing table is altered, and no settled
-- transaction row is ever deleted by the backfill.
--
-- Every statement in this migration is schema-qualified (`"budget_api"."…"`),
-- following the service's current migration convention. The budget_api schema exists only via
-- the `?schema=budget_api` parameter in DATABASE_URL, and the Prisma
-- models declare no `@@schema`, so an unqualified CREATE TABLE lands in
-- whichever schema the connection's `search_path` happens to name. Under
-- `prisma migrate deploy` that happens to be `budget_api`; under a raw
-- `psql` apply, a different migration runner, or a restored dump it would
-- land in `public` — where the client does not look — and the migration
-- would already be recorded as applied, so it would never re-run.

CREATE TABLE "budget_api"."AkahuBackfillRun" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "windowStartMs" BIGINT NOT NULL,
    "windowEndMs" BIGINT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "pagesFetched" INTEGER NOT NULL DEFAULT 0,
    "rowsSeen" INTEGER NOT NULL DEFAULT 0,
    "rowsUpserted" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AkahuBackfillRun_pkey" PRIMARY KEY ("id")
);

-- Index for an operator's per-user run-history lookup.
CREATE INDEX "AkahuBackfillRun_userId_windowStartMs_idx"
  ON "budget_api"."AkahuBackfillRun"("userId", "windowStartMs");

ALTER TABLE "budget_api"."AkahuBackfillRun"
  ADD CONSTRAINT "AkahuBackfillRun_userId_fkey" FOREIGN KEY ("userId")
  REFERENCES "budget_api"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
