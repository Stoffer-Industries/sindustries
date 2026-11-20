-- services/content-scheduler-api/ops/reconciliation.sql
--
-- Service-owned reconciliation manifest for content_scheduler. The harness
-- (scripts/cloud/database/reconcile.mjs) reads this file and runs each
-- statement against the source and destination. Each statement must
-- return rows shaped as (check_name TEXT, metric TEXT, value BIGINT).
--
-- INVARIANTS:
--   * No row data, no IDs, no tweet bodies, no URLs, no tokens.
--   * Aggregates only — counts, distinct counts, group counts.
--   * No cross-schema queries (everything scoped to content_scheduler).
--   * Stable metric labels (used as map keys; do not rename casually).
--
-- The published-tweet identifiers (ContentSchedulerAttemptTweet.tweetId,
-- .url) are NEVER read: a published tweet ID is an external identity, and
-- reading it would move data outside the aggregate-only posture this
-- manifest keeps.

-- ----- Aggregate row counts + distinct PK counts per table -----------------

SELECT 'ContentSchedulerItem'           AS check_name, 'row_count'         AS metric, count(*)::bigint AS value FROM "ContentSchedulerItem"
UNION ALL
SELECT 'ContentSchedulerItem'           AS check_name, 'distinct_pk_count' AS metric, count(DISTINCT id)::bigint AS value FROM "ContentSchedulerItem"
UNION ALL
SELECT 'ContentSchedulerThreadPart'     AS check_name, 'row_count'         AS metric, count(*)::bigint AS value FROM "ContentSchedulerThreadPart"
UNION ALL
SELECT 'ContentSchedulerThreadPart'     AS check_name, 'distinct_pk_count' AS metric, count(DISTINCT id)::bigint AS value FROM "ContentSchedulerThreadPart"
UNION ALL
SELECT 'ContentSchedulerPublishAttempt' AS check_name, 'row_count'         AS metric, count(*)::bigint AS value FROM "ContentSchedulerPublishAttempt"
UNION ALL
SELECT 'ContentSchedulerPublishAttempt' AS check_name, 'distinct_pk_count' AS metric, count(DISTINCT id)::bigint AS value FROM "ContentSchedulerPublishAttempt"
UNION ALL
SELECT 'ContentSchedulerAttemptTweet'   AS check_name, 'row_count'         AS metric, count(*)::bigint AS value FROM "ContentSchedulerAttemptTweet"
UNION ALL
SELECT 'ContentSchedulerAttemptTweet'   AS check_name, 'distinct_pk_count' AS metric, count(DISTINCT id)::bigint AS value FROM "ContentSchedulerAttemptTweet";

-- ----- Content scheduler state groups --------------------------------------

-- The item state is the operational signal for this service: a queued
-- item that never left the queue is exactly what a bad migration
-- produces. Grouped by state, never per item.
SELECT 'ContentSchedulerItem' || '::by_status::' || coalesce(status::text, 'NULL') AS check_name,
       'group_count' AS metric,
       count(*)::bigint AS value
FROM "ContentSchedulerItem"
GROUP BY 1;

-- The publish journal's state groups: a run that was interrupted
-- mid-publish leaves `publishing` / `cleanup_required` rows behind.
SELECT 'ContentSchedulerPublishAttempt' || '::by_state::' || coalesce(state::text, 'NULL') AS check_name,
       'group_count' AS metric,
       count(*)::bigint AS value
FROM "ContentSchedulerPublishAttempt"
GROUP BY 1;

-- ----- Invariant checks (expected zero) ------------------------------------

-- Thread parts always belong to an item. The relation is enforced by a
-- foreign key, so a non-zero count means the schema is not the one this
-- manifest was written against.
SELECT 'invariants::orphan_thread_parts' AS check_name,
       'count' AS metric,
       count(*)::bigint AS value
FROM "ContentSchedulerThreadPart" p
LEFT JOIN "ContentSchedulerItem" i ON i.id = p."itemId"
WHERE i.id IS NULL;

-- Publish attempts always belong to an item.
SELECT 'invariants::orphan_publish_attempts' AS check_name,
       'count' AS metric,
       count(*)::bigint AS value
FROM "ContentSchedulerPublishAttempt" a
LEFT JOIN "ContentSchedulerItem" i ON i.id = a."itemId"
WHERE i.id IS NULL;

-- ----- Prisma applied-migration state --------------------------------------

SELECT 'prisma_migrations' || '::' || coalesce("migration_name", 'NULL') AS check_name,
       'applied' AS metric,
       count(*)::bigint AS value
FROM _prisma_migrations
WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
GROUP BY "migration_name";

SELECT 'prisma_migrations' AS check_name,
       'failed' AS metric,
       count(*)::bigint AS value
FROM _prisma_migrations
WHERE finished_at IS NULL AND rolled_back_at IS NULL;

SELECT 'prisma_migrations' AS check_name,
       'rolled_back' AS metric,
       count(*)::bigint AS value
FROM _prisma_migrations
WHERE rolled_back_at IS NOT NULL;

SELECT 'prisma_migrations' AS check_name,
       'pending' AS metric,
       count(*)::bigint AS value
FROM _prisma_migrations
WHERE started_at IS NULL;
