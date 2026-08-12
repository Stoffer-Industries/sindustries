ALTER TABLE "Task"
ADD COLUMN "workflowHandoffRoleId" TEXT,
ADD COLUMN "workflowHandoffGate" TEXT,
ADD COLUMN "workflowHandoffReason" TEXT;

CREATE INDEX "Task_workflowHandoffRoleId_idx" ON "Task"("workflowHandoffRoleId");
