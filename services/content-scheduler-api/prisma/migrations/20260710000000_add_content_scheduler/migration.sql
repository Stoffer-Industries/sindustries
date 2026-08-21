-- CreateEnum
CREATE TYPE "ContentSchedulerItemStatus" AS ENUM ('draft', 'queued', 'approved', 'published', 'removed');

-- CreateEnum
CREATE TYPE "ContentSchedulerSource" AS ENUM ('ops_notes', 'cto_craft', 'manual', 'other');

-- CreateTable
CREATE TABLE "ContentSchedulerItem" (
    "id" UUID NOT NULL,
    "body" VARCHAR(1000) NOT NULL,
    "source" "ContentSchedulerSource" NOT NULL DEFAULT 'manual',
    "sourceRef" TEXT,
    "status" "ContentSchedulerItemStatus" NOT NULL DEFAULT 'queued',
    "scheduledFor" TIMESTAMP(3),
    "position" INTEGER NOT NULL DEFAULT 0,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "publishedAt" TIMESTAMP(3),
    "publishedUrl" TEXT,
    "publishError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "ContentSchedulerItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentSchedulerItem_status_position_idx" ON "ContentSchedulerItem"("status", "position");

-- CreateIndex
CREATE INDEX "ContentSchedulerItem_status_scheduledFor_idx" ON "ContentSchedulerItem"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "ContentSchedulerItem_status_publishedAt_idx" ON "ContentSchedulerItem"("status", "publishedAt");