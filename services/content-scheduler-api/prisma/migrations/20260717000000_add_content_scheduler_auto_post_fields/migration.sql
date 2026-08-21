-- Add autoPost* bookkeeping fields to ContentSchedulerItem.
--
-- These fields let the route layer enqueue delayed auto-post jobs through a
-- provider-neutral JobSchedulerAdapter (BullMQ locally, cloud-managed queue
-- later) and let the worker detect stale delayed jobs (e.g. when Tom changes
-- scheduledFor, unapproves, removes, or manually publishes before the job
-- fires).
--
-- The autoPost* fields are operational metadata, not product state. The
-- product truth remains status / scheduledFor / publishedAt / publishedUrl
-- / publishError. See docs/specs/content-scheduler-auto-post-2026-07-16-tech-design.md
-- for the full design.

ALTER TABLE "ContentSchedulerItem"
  ADD COLUMN "autoPostJobId" TEXT,
  ADD COLUMN "autoPostScheduleVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "autoPostScheduledAt" TIMESTAMP(3),
  ADD COLUMN "autoPostLastEnqueuedAt" TIMESTAMP(3);
