-- Add taskType column and remove the ready column (which never ran in prod init)
-- Ready was planned but never existed in the actual prod init migration.
-- This single migration replaces all post-init migrations:
--   - 20260308000000_add_blocked_ready_columns
--   - 20260312094500_add_task_comments
--   - 20260316000000_add_task_status_values
--   - 20260529000000_add_task_type

BEGIN;

-- Add taskType text column
ALTER TABLE "Task" ADD COLUMN "taskType" TEXT;

-- Remove ready boolean column (was never in prod init, so this is a no-op against prod
-- but necessary to reflect the schema)
ALTER TABLE "Task" DROP COLUMN "ready";

COMMIT;
