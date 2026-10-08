-- services/tasks-api/ops/reconciliation.sql
--
-- Service-owned reconciliation manifest for tasks_api. The harness
-- (scripts/cloud/database/reconcile.mjs) reads this file and runs each
-- statement against the source and destination. Each statement must
-- return rows shaped as (check_name TEXT, metric TEXT, value BIGINT).
--
-- INVARIANTS:
--   * No row data, no IDs, no titles, no comments, no emails.
--   * No cross-schema queries (everything scoped to tasks_api).
--   * Aggregates only — counts, distinct counts, orphan counts.
--   * Stable metric labels (used as map keys; do not rename casually).
--
-- This file is intentionally read at runtime; adding/removing a check
-- is a code change that must be reflected in the AC evidence and the
-- tasks-api spec.

-- ----- Aggregate row counts + distinct PK counts per table -----------------

SELECT 'Task'           AS check_name, 'row_count'        AS metric, count(*)::bigint AS value FROM "Task"
UNION ALL
SELECT 'Task'           AS check_name, 'distinct_pk_count' AS metric, count(DISTINCT id)::bigint AS value FROM "Task"
UNION ALL
SELECT 'TaskComment'    AS check_name, 'row_count'        AS metric, count(*)::bigint AS value FROM "TaskComment"
UNION ALL
SELECT 'TaskComment'    AS check_name, 'distinct_pk_count' AS metric, count(DISTINCT id)::bigint AS value FROM "TaskComment"
UNION ALL
SELECT 'TaskDependency' AS check_name, 'row_count'        AS metric, count(*)::bigint AS value FROM "TaskDependency"
UNION ALL
SELECT 'TaskDependency' AS check_name, 'distinct_pk_count' AS metric, count(DISTINCT id)::bigint AS value FROM "TaskDependency"
UNION ALL
SELECT 'TaskTag'        AS check_name, 'row_count'        AS metric, count(*)::bigint AS value FROM "TaskTag"
UNION ALL
SELECT 'TaskTag'        AS check_name, 'distinct_pk_count' AS metric, count(DISTINCT id)::bigint AS value FROM "TaskTag"
UNION ALL
SELECT 'Approval'       AS check_name, 'row_count'        AS metric, count(*)::bigint AS value FROM "Approval"
UNION ALL
SELECT 'Approval'       AS check_name, 'distinct_pk_count' AS metric, count(DISTINCT id)::bigint AS value FROM "Approval"
UNION ALL
SELECT 'AttentionOwner' AS check_name, 'row_count'        AS metric, count(*)::bigint AS value FROM "AttentionOwner"
UNION ALL
SELECT 'AttentionOwner' AS check_name, 'distinct_pk_count' AS metric, count(DISTINCT id)::bigint AS value FROM "AttentionOwner";

-- ----- Domain aggregates ----------------------------------------------------

-- Tasks grouped by status (open / doing / acceptance / done / etc).
SELECT 'Task' || '::by_status::' || coalesce(status, 'NULL') AS check_name,
       'group_count' AS metric,
       count(*)::bigint AS value
FROM "Task"
GROUP BY status;

-- Tasks grouped by taskType (feature / code / research / etc).
SELECT 'Task' || '::by_type::' || coalesce("taskType", 'NULL') AS check_name,
       'group_count' AS metric,
       count(*)::bigint AS value
FROM "Task"
GROUP BY "taskType";

-- Total comment counts (informational; must match between sides).
SELECT 'TaskComment' AS check_name, 'total' AS metric, count(*)::bigint AS value FROM "TaskComment";

-- Dependency totals.
SELECT 'TaskDependency' AS check_name, 'total' AS metric, count(*)::bigint AS value FROM "TaskDependency";

-- Approval totals grouped by state (approved / pending / revoked / etc).
SELECT 'Approval' || '::by_state::' || coalesce(state, 'NULL') AS check_name,
       'group_count' AS metric,
       count(*)::bigint AS value
FROM "Approval"
GROUP BY state;

-- AttentionOwner totals grouped by owner (informational; resets between
-- sweeps are expected and accounted for in the runbook).
SELECT 'AttentionOwner' || '::by_owner::' || coalesce(owner, 'NULL') AS check_name,
       'group_count' AS metric,
       count(*)::bigint AS value
FROM "AttentionOwner"
GROUP BY owner;

-- ----- Invariant checks (expected zero) ------------------------------------

-- Orphan comments (TaskComment with no matching Task).
SELECT 'invariants::orphan_comments' AS check_name,
       'count' AS metric,
       count(*)::bigint AS value
FROM "TaskComment" c
LEFT JOIN "Task" t ON t.id = c."taskId"
WHERE t.id IS NULL;

-- Orphan dependencies (TaskDependency with no matching Task on either side).
SELECT 'invariants::orphan_dependencies' AS check_name,
       'count' AS metric,
       count(*)::bigint AS value
FROM "TaskDependency" d
LEFT JOIN "Task" t1 ON t1.id = d."taskId"
LEFT JOIN "Task" t2 ON t2.id = d."dependsOnTaskId"
WHERE t1.id IS NULL OR t2.id IS NULL;

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
