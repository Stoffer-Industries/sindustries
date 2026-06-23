-- CreateTable
CREATE TABLE "budget_api"."BalanceAlertConfig" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "cardId" UUID NOT NULL,
    "condition" TEXT NOT NULL,
    "thresholdCents" INTEGER NOT NULL,
    "pushEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BalanceAlertConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BalanceAlertConfig_cardId_key" ON "budget_api"."BalanceAlertConfig"("cardId");

-- CreateIndex
CREATE INDEX "BalanceAlertConfig_userId_idx" ON "budget_api"."BalanceAlertConfig"("userId");

-- AddForeignKey
ALTER TABLE "budget_api"."BalanceAlertConfig" ADD CONSTRAINT "BalanceAlertConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "budget_api"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_api"."BalanceAlertConfig" ADD CONSTRAINT "BalanceAlertConfig_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "budget_api"."LinkedCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
