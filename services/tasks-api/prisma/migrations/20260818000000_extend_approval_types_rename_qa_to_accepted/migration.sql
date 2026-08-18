-- Extend the `ApprovalType` enum with two new values (`qa_agent` for Ash's
-- mechanical-verification gate, `accepted` for Tom's renamed human sign-off
-- gate), rename all existing `qa` rows to `accepted`, and drop the legacy
-- `qa` enum value. All in one migration so the data model only ever holds
-- the new vocabulary.
--
-- See docs/specs/add-ash-qa-agent-verifier-gate-tech-design.md (task
-- f6a4d56a) for the AC mapping and the rollback story.
--
-- Implementation note: Prisma wraps every migration in a transaction. In a
-- transaction, Postgres rejects any use of an enum value that was added
-- via `ALTER TYPE ... ADD VALUE` in the same transaction until commit
-- (`unsafe use of new value ... New enum values must be committed before
-- they can be used`). A naive
--
--   ALTER TYPE ... ADD VALUE 'accepted';
--   UPDATE "TaskApproval" SET type = 'accepted' WHERE type = 'qa';
--
-- therefore fails inside the Prisma transaction wrapper. `ALTER TYPE ...
-- DROP VALUE` cannot run inside a transaction block at all (it's reported
-- as `syntax error at or near "VALUE"` in postgres:16).
--
-- The recreate-enum pattern below avoids both restrictions: the row
-- rename happens inside the `USING` clause of `ALTER COLUMN TYPE` (no
-- standalone UPDATE), and the legacy value is dropped by replacing the
-- enum type rather than using `DROP VALUE`. Every statement is
-- transaction-safe.
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
--   -- Re-create the original enum, then re-cast the column back.
--   CREATE TYPE "ApprovalType_old" AS ENUM ('spec', 'tech_design', 'qa', 'accepted');
--   ALTER TABLE "TaskApproval" ALTER COLUMN type TYPE "ApprovalType_old"
--     USING (CASE WHEN type = 'accepted' THEN 'qa'::"ApprovalType_old"
--                 ELSE type::text::"ApprovalType_old" END);
--   DROP TYPE "ApprovalType";
--   ALTER TYPE "ApprovalType_old" RENAME TO "ApprovalType";
-- The broader revert (touching Tom-approved `accepted` rows that were
-- never `qa`) is the explicit trade-off documented in the tech design.

-- Step 1: add the new enum values. `IF NOT EXISTS` keeps the migration a
-- no-op if a partial rollout already added them, and is one of the two
-- forms that Postgres 12+ allows inside a transaction.
ALTER TYPE "ApprovalType" ADD VALUE IF NOT EXISTS 'qa_agent';
ALTER TYPE "ApprovalType" ADD VALUE IF NOT EXISTS 'accepted';

-- Step 2: recreate the enum without the legacy `qa` value, mapping any
-- existing `qa` rows to `accepted` via the `USING` clause. The CASE
-- references the NEW enum (`ApprovalType_new`) for the 'qa' →
-- 'accepted' mapping, so the literal `accepted` is read from the type's
-- own definition (safe inside the transaction) rather than from the
-- not-yet-committed ALTER on the original enum.
CREATE TYPE "ApprovalType_new" AS ENUM ('spec', 'tech_design', 'qa_agent', 'accepted');
ALTER TABLE "TaskApproval" ALTER COLUMN type TYPE "ApprovalType_new" USING (
  CASE
    WHEN type = 'qa' THEN 'accepted'::"ApprovalType_new"
    ELSE type::text::"ApprovalType_new"
  END
);
DROP TYPE "ApprovalType";
ALTER TYPE "ApprovalType_new" RENAME TO "ApprovalType";
