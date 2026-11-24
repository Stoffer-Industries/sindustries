ALTER TABLE "budget_api"."User" ADD COLUMN "clerkUserId" TEXT;

CREATE UNIQUE INDEX "User_clerkUserId_key" ON "budget_api"."User"("clerkUserId");
