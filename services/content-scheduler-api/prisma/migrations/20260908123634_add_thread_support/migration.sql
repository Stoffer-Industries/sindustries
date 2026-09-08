-- CreateEnum
CREATE TYPE "ContentSchedulerPublishAttemptState" AS ENUM ('publishing', 'rolling_back', 'rolled_back', 'succeeded', 'cleanup_required');

-- AlterEnum
ALTER TYPE "ContentSchedulerItemKind" ADD VALUE 'thread';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ContentSchedulerItemStatus" ADD VALUE 'publishing';
ALTER TYPE "ContentSchedulerItemStatus" ADD VALUE 'cleanup_required';

-- CreateTable
CREATE TABLE "ContentSchedulerThreadPart" (
    "id" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "body" VARCHAR(1000) NOT NULL,

    CONSTRAINT "ContentSchedulerThreadPart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentSchedulerPublishAttempt" (
    "id" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "state" "ContentSchedulerPublishAttemptState" NOT NULL,
    "failedAtPosition" INTEGER,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ContentSchedulerPublishAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentSchedulerAttemptTweet" (
    "id" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "tweetId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deleteError" TEXT,

    CONSTRAINT "ContentSchedulerAttemptTweet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentSchedulerThreadPart_itemId_position_idx" ON "ContentSchedulerThreadPart"("itemId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ContentSchedulerThreadPart_itemId_position_key" ON "ContentSchedulerThreadPart"("itemId", "position");

-- CreateIndex
CREATE INDEX "ContentSchedulerPublishAttempt_itemId_startedAt_idx" ON "ContentSchedulerPublishAttempt"("itemId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContentSchedulerAttemptTweet_attemptId_position_key" ON "ContentSchedulerAttemptTweet"("attemptId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ContentSchedulerAttemptTweet_attemptId_tweetId_key" ON "ContentSchedulerAttemptTweet"("attemptId", "tweetId");

-- AddForeignKey
ALTER TABLE "ContentSchedulerThreadPart" ADD CONSTRAINT "ContentSchedulerThreadPart_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ContentSchedulerItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentSchedulerPublishAttempt" ADD CONSTRAINT "ContentSchedulerPublishAttempt_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ContentSchedulerItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentSchedulerAttemptTweet" ADD CONSTRAINT "ContentSchedulerAttemptTweet_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ContentSchedulerPublishAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
