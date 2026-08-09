-- Exceptional or otherwise unmodelled attention requests. These rows sit
-- parallel to TaskApproval (workflow gates), TaskDependency (task-to-task
-- edges), Task.assignee (delivery), and the existing Task.blocked indicator.
-- Attention ownership does not derive from or clear any of those concepts.
-- See docs/specs/blocked-by-escalation-owners-and-stacked-avatars-tech-design.md.

CREATE TABLE "TaskAttentionOwner" (
    "id"        UUID NOT NULL,
    "taskId"    UUID NOT NULL,
    "owner"     TEXT NOT NULL,
    "addedBy"   TEXT,
    "note"      TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskAttentionOwner_pkey" PRIMARY KEY ("id")
);

-- One row per (task, owner). Upserts target this index. PATCH duplicates
-- normalise away in the route layer before the upsert so race conditions
-- across two PATCHes collapse cleanly.
CREATE UNIQUE INDEX "TaskAttentionOwner_taskId_owner_key"
    ON "TaskAttentionOwner"("taskId", "owner");

-- Exceptional-attention filter `GET /tasks?attentionOwner=<owner>` uses this
-- index. Index only — owner cardinality stays low enough that we don't
-- need a composite.
CREATE INDEX "TaskAttentionOwner_owner_idx"
    ON "TaskAttentionOwner"("owner");

-- Detail view loads rows in insertion order so the stacked avatar group
-- and the task detail list agree on a stable sequence.
CREATE INDEX "TaskAttentionOwner_taskId_createdAt_idx"
    ON "TaskAttentionOwner"("taskId", "createdAt");

-- Cascade on task archive/delete so attention-owner rows never outlive the task.
ALTER TABLE "TaskAttentionOwner"
    ADD CONSTRAINT "TaskAttentionOwner_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "Task"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
