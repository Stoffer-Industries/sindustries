-- Add content ops metadata fields to Task model
ALTER TABLE "Task" ADD COLUMN "sourceReview" TEXT;
ALTER TABLE "Task" ADD COLUMN "targetRepo" TEXT;
ALTER TABLE "Task" ADD COLUMN "publicRisk" TEXT;
ALTER TABLE "Task" ADD COLUMN "channel" TEXT;
ALTER TABLE "Task" ADD COLUMN "tomApprovalPr" TEXT;
ALTER TABLE "Task" ADD COLUMN "quinnApprovalPr" TEXT;
ALTER TABLE "Task" ADD COLUMN "approvalOwners" TEXT;
