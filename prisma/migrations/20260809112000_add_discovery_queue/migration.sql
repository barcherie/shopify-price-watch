CREATE TYPE "DiscoveryRunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED');

CREATE TYPE "DiscoveryJobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED');

CREATE TABLE "DiscoveryRun" (
  "id" TEXT NOT NULL,
  "status" "DiscoveryRunStatus" NOT NULL DEFAULT 'RUNNING',
  "totalProducts" INTEGER NOT NULL DEFAULT 0,
  "processed" INTEGER NOT NULL DEFAULT 0,
  "found" INTEGER NOT NULL DEFAULT 0,
  "notFound" INTEGER NOT NULL DEFAULT 0,
  "alreadyExists" INTEGER NOT NULL DEFAULT 0,
  "errors" INTEGER NOT NULL DEFAULT 0,
  "query" TEXT,
  "vendor" TEXT,
  "onlyMissing" BOOLEAN NOT NULL DEFAULT true,
  "message" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DiscoveryRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscoveryJob" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "status" "DiscoveryJobStatus" NOT NULL DEFAULT 'PENDING',
  "searchQuery" TEXT,
  "found" INTEGER NOT NULL DEFAULT 0,
  "notFound" INTEGER NOT NULL DEFAULT 0,
  "alreadyExists" INTEGER NOT NULL DEFAULT 0,
  "errors" INTEGER NOT NULL DEFAULT 0,
  "message" TEXT,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DiscoveryJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DiscoveryRun_createdAt_idx" ON "DiscoveryRun"("createdAt" DESC);
CREATE INDEX "DiscoveryRun_status_createdAt_idx" ON "DiscoveryRun"("status", "createdAt");
CREATE UNIQUE INDEX "DiscoveryJob_runId_productId_key" ON "DiscoveryJob"("runId", "productId");
CREATE INDEX "DiscoveryJob_status_createdAt_idx" ON "DiscoveryJob"("status", "createdAt");
CREATE INDEX "DiscoveryJob_productId_idx" ON "DiscoveryJob"("productId");

ALTER TABLE "DiscoveryJob"
  ADD CONSTRAINT "DiscoveryJob_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "DiscoveryRun"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DiscoveryJob"
  ADD CONSTRAINT "DiscoveryJob_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "ShopifyProduct"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
