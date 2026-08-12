-- Migration: composite unique on (source, sourceRef) for ContentSchedulerItem.
-- Task: 9dfe56e4-13c4-4bb4-b53f-de7c77afd0d2 (CTO Craft tweet-draft pipeline).
--
-- The CTO Craft LangGraph workflow imports tweet drafts in batches via
-- POST /api/v1/content-scheduler/imports/cto-craft. Re-running against
-- the same Tech Manager Weekly issue, or retrying after a transient
-- response loss, must not create duplicate ContentSchedulerItem rows
-- for the same article URL within the same source.
--
-- PostgreSQL permits multiple NULL values in a unique column, so the
-- constraint only enforces uniqueness on non-null (source, sourceRef)
-- pairs. Existing manual rows with NULL sourceRef remain valid; only
-- non-null pairs must be unique within a source.
--
-- Preflight: abort the migration with a clear operator message if any
-- existing non-null (source, sourceRef) pairs would collide. We never
-- silently delete or merge rows.

DO $$
DECLARE
    duplicate_count BIGINT;
BEGIN
    SELECT COUNT(*) INTO duplicate_count
    FROM (
        SELECT "source", "sourceRef"
        FROM "ContentSchedulerItem"
        WHERE "sourceRef" IS NOT NULL
        GROUP BY "source", "sourceRef"
        HAVING COUNT(*) > 1
    ) AS dups;

    IF duplicate_count > 0 THEN
        RAISE EXCEPTION 'Cannot add unique constraint on (source, sourceRef): % existing non-null duplicate pair(s) found. Resolve duplicates manually before re-running this migration.', duplicate_count;
    END IF;
END $$;

CREATE UNIQUE INDEX "ContentSchedulerItem_source_sourceRef_key"
    ON "ContentSchedulerItem"("source", "sourceRef")
    WHERE "sourceRef" IS NOT NULL;