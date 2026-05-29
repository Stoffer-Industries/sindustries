-- Add blocked and ready columns to Task table
ALTER TABLE "Task" ADD COLUMN "blocked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Task" ADD COLUMN "ready" BOOLEAN NOT NULL DEFAULT false;
