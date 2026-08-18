-- Extend the `ApprovalType` enum with two new values (`qa_agent` for Ash's
-- mechanical-verification gate, `accepted` for Tom's renamed human sign-off
-- gate) and rename all existing `qa` rows to `accepted` in the same
-- migration. The legacy `qa` enum value is dropped at the end so the data
-- model only ever holds the new vocabulary.
--
-- See docs/specs/add-ash-qa-agent-verifier-gate-tech-design.md (task
-- f6a4d56a) for the AC mapping and the rollback story.
--
-- Preflight (run before applying):
--   SELECT type, count(*) FROM "TaskApproval" GROUP BY type;
-- Expected: a non-empty `qa` bucket, empty `qa_agent` and `accepted` buckets.
--
-- Post-apply (run after):
--   SELECT type, count(*) FROM "TaskApproval" GROUP BY type;
-- Expected: empty `qa` and `qa_agent` buckets; `accepted` count equals the
-- pre-migration `qa` count.
--
-- Rollback (if the migration must be reversed):
--   ALTER TYPE "ApprovalType" ADD VALUE 'qa';
--   UPDATE "TaskApproval" SET type = 'qa' WHERE type = 'accepted';
-- Postgres 12+ supports `ALTER TYPE ... ADD VALUE` to re-add a dropped
-- value; the UPDATE above restores the original rows. The broader revert
-- (touching Tom-approved `accepted` rows that were never `qa`) is the
-- explicit trade-off documented in the tech design.

-- Step 1: add the new enum values BEFORE renaming rows so the UPDATE
-- destination type is valid.
ALTER TYPE "ApprovalType" ADD VALUE 'qa_agent';
ALTER TYPE "ApprovalType" ADD VALUE 'accepted';

-- Step 2: rename existing `qa` rows to `accepted`. This is the single
-- irreversible point of the migration — once `qa` rows become `accepted`,
-- we can no longer distinguish them from freshly-created `accepted` rows
-- (Tom's sign-off rows). The tech design accepts this trade-off in the
-- rollback section.
UPDATE "TaskApproval" SET type = 'accepted' WHERE type = 'qa';

-- Step 3: drop the legacy `qa` enum value. Postgres requires no rows
-- reference the value at drop time, which is why the UPDATE in step 2
-- runs first. Requires Postgres 12+ for `ALTER TYPE ... DROP VALUE`.
ALTER TYPE "ApprovalType" DROP VALUE 'qa';
