-- Add new TaskStatus enum values that were added to schema but not migrated
-- Using transactional approach for safety
BEGIN;

-- Add new enum values (PostgreSQL 9.3+)
ALTER TYPE "TaskStatus" ADD VALUE 'open';
ALTER TYPE "TaskStatus" ADD VALUE 'ready';
ALTER TYPE "TaskStatus" ADD VALUE 'acceptance';

COMMIT;
