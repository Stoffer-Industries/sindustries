-- Add a `pending` value to the `ApprovalState` enum: the durable
-- "this required gate has a row, but the gate has not been granted yet"
-- state. Replaces the `revoked`-as-outstanding hack documented in
-- docs/specs/add-ash-qa-agent-verifier-gate-tech-design.md (task f6a4d56a)
-- and adds the durable backing for task d9cd8a83.
--
-- Implementation note: Prisma wraps every migration in a transaction. In a
-- transaction, Postgres rejects any use of an enum value that was added
-- via `ALTER TYPE ... ADD VALUE` in the same transaction until commit
-- (`unsafe use of new value ... New enum values must be committed before
-- they can be used`). `ALTER TYPE ... DROP VALUE` cannot run inside a
-- transaction block at all (it's reported as `syntax error at or near
-- "VALUE"` in postgres:16). The recreate-enum pattern below avoids both
-- restrictions, matching the 2026-08-18 migration that widened
-- `ApprovalType` the same way.
--
-- Preflight (run before applying):
--   SELECT state, count(*) FROM "TaskApproval" GROUP BY state;
-- Expected: zero `pending` rows; any count of `approved` and `revoked`
--   rows. (No production code currently writes `pending`; this migration
--   only adds the enum value. The task-creation transaction in
--   `services/tasks-api/src/routes/tasks.ts` lands in the same PR and is
--   what first materialises `pending` rows.)
--
-- Post-apply (run after):
--   SELECT state, count(*) FROM "TaskApproval" GROUP BY state;
-- Expected: same shape as preflight — zero `pending`, any count of
--   `approved` and `revoked`. The migration is non-destructive; existing
--   rows survive verbatim via the `USING` clause.
--
-- Rollback (if the migration must be reversed on a fresh database):
--   -- Recreate the original enum without `pending`, then re-cast the
--   -- column back. Drops any `pending` rows created between deploy and
--   -- revert (none should exist pre-deploy).
--   CREATE TYPE "ApprovalState_old" AS ENUM ('approved', 'revoked');
--   ALTER TABLE "TaskApproval" ALTER COLUMN state TYPE "ApprovalState_old"
--     USING state::text::"ApprovalState_old";
--   DROP TYPE "ApprovalState";
--   ALTER TYPE "ApprovalState_old" RENAME TO "ApprovalState";

-- Step 1: add the new enum value. `IF NOT EXISTS` keeps the migration a
-- no-op if a partial rollout already added it, and is one of the two
-- forms that Postgres 12+ allows inside a transaction.
ALTER TYPE "ApprovalState" ADD VALUE IF NOT EXISTS 'pending';

-- Step 2: recreate the enum including the new value, casting the column
-- via `USING` so existing `approved`/`revoked` rows map verbatim. No
-- standalone UPDATE is needed (the literal is read from the NEW enum's
-- definition, safe inside the transaction).
CREATE TYPE "ApprovalState_new" AS ENUM ('pending', 'approved', 'revoked');
ALTER TABLE "TaskApproval" ALTER COLUMN state TYPE "ApprovalState_new"
  USING state::text::"ApprovalState_new";
DROP TYPE "ApprovalState";
ALTER TYPE "ApprovalState_new" RENAME TO "ApprovalState";