CREATE TABLE "ApprovalSession" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tokenHash" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ApprovalSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ApprovalSession_tokenHash_key" ON "ApprovalSession"("tokenHash");
CREATE INDEX "ApprovalSession_actor_expiresAt_idx" ON "ApprovalSession"("actor", "expiresAt");
CREATE INDEX "ApprovalSession_expiresAt_revokedAt_idx" ON "ApprovalSession"("expiresAt", "revokedAt");
