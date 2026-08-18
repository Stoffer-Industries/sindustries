-- Add `updatedAt` to FeatureTaskAnalyticsEvent so the POST
-- /feature-task-analytics/events route can distinguish UPSERT inserts from
-- UPSERT updates without an extra query (was crashing on every call since
-- the endpoint shipped in commit 0ef7725, 2026-07-26).
--
-- See task 3a3f97a4 ("Fix TypeError in featureTaskAnalytics.ts:200") for the
-- AC mapping and the rollback story. AC1 in particular calls for backfilling
-- existing rows to a sane default; we use `createdAt` so the route's
-- `createdAt.getTime() === updatedAt.getTime()` predicate treats all existing
-- events as inserts (which is true: nothing has ever updated them, because
-- the column didn't exist).
--
-- The DEFAULT CURRENT_TIMESTAMP keeps new inserts valid without requiring
-- application-side changes. Prisma's `@updatedAt` directive (added to the
-- Prisma model in this same change) will keep the column in sync on every
-- UPDATE issued through the Prisma client; raw SQL UPDATEs (none in
-- production today) would need to maintain it themselves.

ALTER TABLE "FeatureTaskAnalyticsEvent"
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill existing rows: their createdAt is the most truthful "updatedAt"
-- we can derive, since the column didn't exist before this migration.
UPDATE "FeatureTaskAnalyticsEvent"
  SET "updatedAt" = "createdAt";
