-- Drop content ops metadata fields that were incorrectly added to the schema.
-- These fields belong in the task body, not the Tasks API model.
-- IF EXISTS handles both fresh DBs and envs that applied the original migration.
ALTER TABLE "Task" DROP COLUMN IF EXISTS "sourceReview";
ALTER TABLE "Task" DROP COLUMN IF EXISTS "targetRepo";
ALTER TABLE "Task" DROP COLUMN IF EXISTS "publicRisk";
ALTER TABLE "Task" DROP COLUMN IF EXISTS "channel";
ALTER TABLE "Task" DROP COLUMN IF EXISTS "tomApprovalPr";
ALTER TABLE "Task" DROP COLUMN IF EXISTS "quinnApprovalPr";
ALTER TABLE "Task" DROP COLUMN IF EXISTS "approvalOwners";
