-- First-class "blocked-by escalation" owners. Each row says "this owner
-- has an outstanding blocker action on this task." Sits parallel to
-- TaskApproval (workflow gates) and TaskDependency (task-to-task edges);
-- none of the three replaces another. The legacy Task.blocked boolean
-- survives untouched so existing tasks remain visibly blocked during the
-- transition. See
-- docs/specs/blocked-by-escalation-owners-and-stacked-avatars-tech-design.md.

CREATE TABLE "TaskBlockedBy" (
    "id"        UUID NOT NULL,
    "taskId"    UUID NOT NULL,
    "owner"     TEXT NOT NULL,
    "addedBy"   TEXT,
    "note"      TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskBlockedBy_pkey" PRIMARY KEY ("id")
);

-- One row per (task, owner). Upserts target this index. PATCH duplicates
-- normalise away in the route layer before the upsert so race conditions
-- across two PATCHes collapse cleanly.
CREATE UNIQUE INDEX "TaskBlockedBy_taskId_owner_key"
    ON "TaskBlockedBy"("taskId", "owner");

-- Discovery queue filter `GET /tasks?blockedBy=<owner>` runs through this
-- index. Index only — owner cardinality stays low enough that we don't
-- need a composite.
CREATE INDEX "TaskBlockedBy_owner_idx"
    ON "TaskBlockedBy"("owner");

-- Detail view loads rows in insertion order so the stacked avatar group
-- and the task detail list agree on a stable sequence.
CREATE INDEX "TaskBlockedBy_taskId_createdAt_idx"
    ON "TaskBlockedBy"("taskId", "createdAt");

-- Cascade on task archive/delete so blocked-by rows never outlive the task.
ALTER TABLE "TaskBlockedBy"
    ADD CONSTRAINT "TaskBlockedBy_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "Task"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
