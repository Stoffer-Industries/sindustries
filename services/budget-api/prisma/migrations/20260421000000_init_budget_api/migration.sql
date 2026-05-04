-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "budget_api";

-- CreateEnum
CREATE TYPE "budget_api"."TransactionDirection" AS ENUM ('debit', 'credit');

-- CreateEnum
CREATE TYPE "budget_api"."CategorySource" AS ENUM ('import', 'model', 'rule', 'manual');

-- CreateTable
CREATE TABLE "budget_api"."User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_api"."Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_api"."LinkedCard" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerCardId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "last4" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LinkedCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_api"."Transaction" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "cardId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerTransactionId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "merchant" TEXT,
    "description" TEXT,
    "amountCents" INTEGER NOT NULL,
    "direction" "budget_api"."TransactionDirection" NOT NULL,
    "category" TEXT,
    "categorySource" "budget_api"."CategorySource" NOT NULL DEFAULT 'import',
    "categoryConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_api"."CardMonthlyBudget" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "cardId" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "monthlyLimitCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardMonthlyBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_api"."CategorizationFeedback" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "merchantKey" TEXT NOT NULL,
    "originalCategory" TEXT,
    "correctedCategory" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CategorizationFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_api"."NotificationEvent" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "cardId" UUID,
    "month" TEXT,
    "stage" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "budget_api"."User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "budget_api"."Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_createdAt_idx" ON "budget_api"."Session"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "LinkedCard_userId_createdAt_idx" ON "budget_api"."LinkedCard"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LinkedCard_provider_providerCardId_key" ON "budget_api"."LinkedCard"("provider", "providerCardId");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_providerTransactionId_key" ON "budget_api"."Transaction"("providerTransactionId");

-- CreateIndex
CREATE INDEX "Transaction_userId_occurredAt_idx" ON "budget_api"."Transaction"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "Transaction_cardId_occurredAt_idx" ON "budget_api"."Transaction"("cardId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "CardMonthlyBudget_cardId_month_key" ON "budget_api"."CardMonthlyBudget"("cardId", "month");

-- CreateIndex
CREATE INDEX "CardMonthlyBudget_userId_month_idx" ON "budget_api"."CardMonthlyBudget"("userId", "month");

-- CreateIndex
CREATE INDEX "CategorizationFeedback_userId_merchantKey_idx" ON "budget_api"."CategorizationFeedback"("userId", "merchantKey");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationEvent_dedupeKey_key" ON "budget_api"."NotificationEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "NotificationEvent_userId_createdAt_idx" ON "budget_api"."NotificationEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationEvent_userId_cardId_month_idx" ON "budget_api"."NotificationEvent"("userId", "cardId", "month");

-- AddForeignKey
ALTER TABLE "budget_api"."Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "budget_api"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_api"."LinkedCard" ADD CONSTRAINT "LinkedCard_userId_fkey" FOREIGN KEY ("userId") REFERENCES "budget_api"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_api"."Transaction" ADD CONSTRAINT "Transaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "budget_api"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_api"."Transaction" ADD CONSTRAINT "Transaction_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "budget_api"."LinkedCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_api"."CardMonthlyBudget" ADD CONSTRAINT "CardMonthlyBudget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "budget_api"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_api"."CardMonthlyBudget" ADD CONSTRAINT "CardMonthlyBudget_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "budget_api"."LinkedCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_api"."CategorizationFeedback" ADD CONSTRAINT "CategorizationFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "budget_api"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_api"."NotificationEvent" ADD CONSTRAINT "NotificationEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "budget_api"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
