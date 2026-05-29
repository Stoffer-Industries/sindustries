-- Add taskType column and remove the legacy ready flag.
-- This migration intentionally builds on the existing main migration history.

BEGIN;

-- Add taskType text column
ALTER TABLE "Task" ADD COLUMN "taskType" TEXT;

-- Readiness is represented by status='ready' now.
ALTER TABLE "Task" DROP COLUMN "ready";

COMMIT;
