-- services/budget-api/ops/reconciliation.sql
--
-- Service-owned reconciliation manifest for budget_api. The harness
-- (scripts/cloud/database/reconcile.mjs) reads this file and runs each
-- statement against the source and destination. Each statement must
-- return rows shaped as (check_name TEXT, metric TEXT, value BIGINT).
--
-- INVARIANTS:
--   * No row data, no IDs, no merchant text, no token bytes.
--   * Encrypted AkahuToken rows are counted and length-class checked,
--     never decrypted or compared byte-for-byte.
--   * Aggregates only — counts, distinct counts, group counts, sum
--     checks for non-identifying integer money fields grouped at a
--     global level (never per-user/per-merchant).
--   * No cross-schema queries (everything scoped to budget_api).

-- ----- Aggregate row counts + distinct PK counts per table -----------------

SELECT 'User'            AS check_name, 'row_count'         AS metric, count(*)::bigint AS value FROM "User"
UNION ALL
SELECT 'User'            AS check_name, 'distinct_pk_count' AS metric, count(DISTINCT id)::bigint AS value FROM "User"
UNION ALL
SELECT 'AkahuConnection' AS check_name, 'row_count'         AS metric, count(*)::bigint AS value FROM "AkahuConnection"
UNION ALL
SELECT 'AkahuConnection' AS check_name, 'distinct_pk_count' AS metric, count(DISTINCT id)::bigint AS value FROM "AkahuConnection"
UNION ALL
SELECT 'Session'         AS check_name, 'row_count'         AS metric, count(*)::bigint AS value FROM "Session"
UNION ALL
SELECT 'Session'         AS check_name, 'distinct_pk_count' AS metric, count(DISTINCT id)::bigint AS value FROM "Session"
UNION ALL
SELECT 'LinkedCard'      AS check_name, 'row_count'         AS metric, count(*)::bigint AS value FROM "LinkedCard"
UNION ALL
SELECT 'LinkedCard'      AS check_name, 'distinct_pk_count' AS metric, count(DISTINCT id)::bigint AS value FROM "LinkedCard"
UNION ALL
SELECT 'AccountBalanceSnapshot' AS check_name, 'row_count'         AS metric, count(*)::bigint AS value FROM "AccountBalanceSnapshot"
UNION ALL
SELECT 'AccountBalanceSnapshot' AS check_name, 'distinct_pk_count' AS metric, count(DISTINCT id)::bigint AS value FROM "AccountBalanceSnapshot"
UNION ALL
SELECT 'Transaction'     AS check_name, 'row_count'         AS metric, count(*)::bigint AS value FROM "Transaction"
UNION ALL
SELECT 'Transaction'     AS check_name, 'distinct_pk_count' AS metric, count(DISTINCT id)::bigint AS value FROM "Transaction"
UNION ALL
SELECT 'CardMonthlyBudget' AS check_name, 'row_count'         AS metric, count(*)::bigint AS value FROM "CardMonthlyBudget"
UNION ALL
SELECT 'CardMonthlyBudget' AS check_name, 'distinct_pk_count' AS metric, count(DISTINCT id)::bigint AS value FROM "CardMonthlyBudget"
UNION ALL
SELECT 'CategorizationFeedback' AS check_name, 'row_count'         AS metric, count(*)::bigint AS value FROM "CategorizationFeedback"
UNION ALL
SELECT 'CategorizationFeedback' AS check_name, 'distinct_pk_count' AS metric, count(DISTINCT id)::bigint AS value FROM "CategorizationFeedback"
UNION ALL
SELECT 'BalanceAlertConfig' AS check_name, 'row_count'         AS metric, count(*)::bigint AS value FROM "BalanceAlertConfig"
UNION ALL
SELECT 'BalanceAlertConfig' AS check_name, 'distinct_pk_count' AS metric, count(DISTINCT id)::bigint AS value FROM "BalanceAlertConfig"
UNION ALL
SELECT 'NotificationEvent' AS check_name, 'row_count'         AS metric, count(*)::bigint AS value FROM "NotificationEvent"
UNION ALL
SELECT 'NotificationEvent' AS check_name, 'distinct_pk_count' AS metric, count(DISTINCT id)::bigint AS value FROM "NotificationEvent";

-- ----- AkahuConnection access-token length class (never read bytes) -----

-- Coarse classification: short (≤ 256 bytes), medium (≤ 1024), long.
SELECT 'AkahuConnection' || '::token_length_class::' ||
       CASE
         WHEN octet_length("accessToken") <= 256  THEN 'short'
         WHEN octet_length("accessToken") <= 1024 THEN 'medium'
         ELSE 'long'
       END AS check_name,
       'group_count' AS metric,
       count(*)::bigint AS value
FROM "AkahuConnection"
GROUP BY 1;

-- null/length-zero safety — should be zero on both sides.
SELECT 'AkahuConnection' AS check_name, 'null_or_empty_token' AS metric, count(*)::bigint AS value
FROM "AkahuConnection"
WHERE "accessToken" IS NULL OR octet_length("accessToken") = 0;

-- ----- Transaction direction + category-source totals ----------------------

SELECT 'Transaction' || '::by_direction::' || coalesce(direction::text, 'NULL') AS check_name,
       'group_count' AS metric,
       count(*)::bigint AS value
FROM "Transaction"
GROUP BY direction;

SELECT 'Transaction' || '::by_category_source::' || coalesce("categorySource"::text, 'NULL') AS check_name,
       'group_count' AS metric,
       count(*)::bigint AS value
FROM "Transaction"
GROUP BY "categorySource";

-- ----- Budget integer money sums (global only, never per-user/per-merchant)

-- amountCents sum check, grouped only at the global level.
SELECT 'Transaction' AS check_name, 'sum_amount_cents' AS metric, coalesce(sum("amountCents"), 0)::bigint AS value
FROM "Transaction";

-- Count by sign class (positive, negative, zero) — protects against
-- accidentally all-positive / all-negative transfers.
SELECT 'Transaction' || '::by_sign::' ||
       CASE
         WHEN "amountCents" >  0 THEN 'positive'
         WHEN "amountCents" <  0 THEN 'negative'
         ELSE 'zero'
       END AS check_name,
       'group_count' AS metric,
       count(*)::bigint AS value
FROM "Transaction"
GROUP BY 1;

-- ----- Invariant checks (expected zero) ------------------------------------

-- Orphan transactions (no LinkedCard).
SELECT 'invariants::orphan_transactions' AS check_name,
       'count' AS metric,
       count(*)::bigint AS value
FROM "Transaction" t
LEFT JOIN "LinkedCard" c ON c.id = t."cardId"
WHERE c.id IS NULL;

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
