-- First-class approval state for tasks. Each row represents one approval
-- type (spec / tech_design / qa) for one task. Revoked approvals keep the
-- row with `state = 'revoked'` and `revokedAt` set so the audit trail is
-- preserved. See docs/specs/tasks-api-native-approvals-tech-design.md.

CREATE TYPE "ApprovalType" AS ENUM ('spec', 'tech_design', 'qa');
CREATE TYPE "ApprovalState" AS ENUM ('approved', 'revoked');

CREATE TABLE "TaskApproval" (
    "id"         UUID NOT NULL,
    "taskId"     UUID NOT NULL,
    "type"       "ApprovalType" NOT NULL,
    "owner"      TEXT NOT NULL,
    "state"      "ApprovalState" NOT NULL DEFAULT 'approved',
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt"  TIMESTAMP(3),
    "note"       TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskApproval_pkey" PRIMARY KEY ("id")
);

-- One approval row per (taskId, type). Upserts target this index.
CREATE UNIQUE INDEX "TaskApproval_taskId_type_key"
    ON "TaskApproval"("taskId", "type");

-- Look up approvals by task + state (e.g. "all currently approved").
CREATE INDEX "TaskApproval_taskId_state_idx"
    ON "TaskApproval"("taskId", "state");

-- Cascade on task archive/delete so approvals never outlive the task.
ALTER TABLE "TaskApproval"
    ADD CONSTRAINT "TaskApproval_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "Task"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
