-- CreateTable
CREATE TABLE "budget_api"."AkahuConnection" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "accessToken" TEXT NOT NULL,
    "scope" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AkahuConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AkahuConnection_userId_key" ON "budget_api"."AkahuConnection"("userId");

-- AddForeignKey
ALTER TABLE "budget_api"."AkahuConnection" ADD CONSTRAINT "AkahuConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "budget_api"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

