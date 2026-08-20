-- attentionOwners is an ordered escalation stack. The first slot is the next
-- actionable owner; duplicate people are valid when they occupy distinct
-- escalation/role slots.
DROP INDEX IF EXISTS "TaskAttentionOwner_taskId_owner_key";
DROP INDEX IF EXISTS "TaskAttentionOwner_taskId_createdAt_idx";

ALTER TABLE "TaskAttentionOwner" ADD COLUMN "position" INTEGER;

WITH ranked AS (
  SELECT "id", (ROW_NUMBER() OVER (
    PARTITION BY "taskId" ORDER BY "createdAt" ASC, "id" ASC
  ) - 1)::INTEGER AS slot
  FROM "TaskAttentionOwner"
)
UPDATE "TaskAttentionOwner" target
SET "position" = ranked.slot
FROM ranked
WHERE target."id" = ranked."id";

ALTER TABLE "TaskAttentionOwner" ALTER COLUMN "position" SET NOT NULL;

CREATE UNIQUE INDEX "TaskAttentionOwner_taskId_position_key"
  ON "TaskAttentionOwner"("taskId", "position");
CREATE INDEX "TaskAttentionOwner_taskId_position_idx"
  ON "TaskAttentionOwner"("taskId", "position");
