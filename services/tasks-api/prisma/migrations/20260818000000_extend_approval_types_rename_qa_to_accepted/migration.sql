-- Extend the `ApprovalType` enum with two new values (`qa_agent` for Ash's
-- mechanical-verification gate, `accepted` for Tom's renamed human sign-off
-- gate) and rename all existing `qa` rows to `accepted` in the same
-- migration. The legacy `qa` enum value is dropped so the data model only
-- ever holds the new vocabulary.
--
-- See docs/specs/add-ash-qa-agent-verifier-gate-tech-design.md (task
-- f6a4d56a) for the AC mapping and the rollback story.
--
-- Implementation note: `ALTER TYPE ... DROP VALUE` is not allowed inside a
-- transaction block, but Prisma wraps every migration in a transaction.
-- The recreate-enum pattern below achieves the same result (rename + drop
-- the legacy value, add the new values) inside the Prisma transaction.
-- Steps 1 and 2 use `ADD VALUE IF NOT EXISTS` so they remain a no-op if
-- re-applied after a partial rollout.
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
-- Rollback (if the migration must be reversed on a fresh database):
--   -- Re-add the legacy enum value, restore the renamed rows.
--   ALTER TYPE "ApprovalType" ADD VALUE IF NOT EXISTS 'qa' BEFORE 'accepted';
--   UPDATE "TaskApproval" SET type = 'qa' WHERE type = 'accepted';
-- The broader revert (touching Tom-approved `accepted` rows that were
-- never `qa`) is the explicit trade-off documented in the tech design.

-- Step 1: add the new enum values BEFORE renaming rows so the new type
-- we create below already includes them.
ALTER TYPE "ApprovalType" ADD VALUE IF NOT EXISTS 'qa_agent';
ALTER TYPE "ApprovalType" ADD VALUE IF NOT EXISTS 'accepted';

-- Step 2: rename existing `qa` rows to `accepted`. This is the single
-- irreversible point of the migration — once `qa` rows become `accepted`,
-- we can no longer distinguish them from freshly-created `accepted` rows
-- (Tom's sign-off rows). The tech design accepts this trade-off in the
-- rollback section.
UPDATE "TaskApproval" SET type = 'accepted' WHERE type = 'qa';

-- Step 3: recreate the enum without the legacy `qa` value. The
-- recreate-enum pattern (CREATE new → ALTER COLUMN → DROP old → RENAME)
-- is required because `ALTER TYPE ... DROP VALUE` cannot run inside a
-- transaction block (Prisma wraps every migration in one).
CREATE TYPE "ApprovalType_new" AS ENUM ('spec', 'tech_design', 'qa_agent', 'accepted');
ALTER TABLE "TaskApproval" ALTER COLUMN type TYPE "ApprovalType_new" USING type::text::"ApprovalType_new";
DROP TYPE "ApprovalType";
ALTER TYPE "ApprovalType_new" RENAME TO "ApprovalType";
