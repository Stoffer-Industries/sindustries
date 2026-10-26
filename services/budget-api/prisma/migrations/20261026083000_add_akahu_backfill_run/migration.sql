-- Add the Akahu backfill run record (task a37b31c9, AC6).
--
-- A bounded backfill is a data-repair operation over financial records, so
-- it leaves an auditable record of the window it covered and what it did.
-- The table is written only by the backfill code path
-- (src/services/akahuBackfill.ts); a dry run writes nothing at all.
--
-- The table is additive: no existing table is altered, and no settled
-- transaction row is ever deleted by the backfill.

CREATE TABLE "AkahuBackfillRun" (
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

-- Index for the per-user run history lookup (the runbook's "what did we
-- already backfill for this user" query).
CREATE INDEX "AkahuBackfillRun_userId_windowStartMs_idx" ON "AkahuBackfillRun"("userId", "windowStartMs");

ALTER TABLE "AkahuBackfillRun"
  ADD CONSTRAINT "AkahuBackfillRun_userId_fkey" FOREIGN KEY ("userId")
  REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
