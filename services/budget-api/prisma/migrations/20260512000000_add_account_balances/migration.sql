-- AlterTable
ALTER TABLE "budget_api"."LinkedCard"
ADD COLUMN "currentBalanceCents" INTEGER,
ADD COLUMN "availableBalanceCents" INTEGER,
ADD COLUMN "balanceCurrency" TEXT,
ADD COLUMN "balanceOverdrawn" BOOLEAN,
ADD COLUMN "balanceUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "budget_api"."AccountBalanceSnapshot" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "cardId" UUID NOT NULL,
    "currentBalanceCents" INTEGER,
    "availableBalanceCents" INTEGER,
    "currency" TEXT,
    "overdrawn" BOOLEAN,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountBalanceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountBalanceSnapshot_userId_capturedAt_idx" ON "budget_api"."AccountBalanceSnapshot"("userId", "capturedAt");

-- CreateIndex
CREATE INDEX "AccountBalanceSnapshot_cardId_capturedAt_idx" ON "budget_api"."AccountBalanceSnapshot"("cardId", "capturedAt");

-- AddForeignKey
ALTER TABLE "budget_api"."AccountBalanceSnapshot" ADD CONSTRAINT "AccountBalanceSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "budget_api"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_api"."AccountBalanceSnapshot" ADD CONSTRAINT "AccountBalanceSnapshot_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "budget_api"."LinkedCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
