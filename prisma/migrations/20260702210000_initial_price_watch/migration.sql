CREATE TYPE "CompetitorLegalStatus" AS ENUM ('PENDING', 'APPROVED', 'BLOCKED');
CREATE TYPE "RenderMode" AS ENUM ('HTTP', 'BROWSER');
CREATE TYPE "ProductMatchStatus" AS ENUM ('PENDING', 'VALIDATED', 'REJECTED');
CREATE TYPE "PriceExtractionMethod" AS ENUM ('JSON_LD', 'META', 'CSS', 'FALLBACK');
CREATE TYPE "ScrapeRunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED');
CREATE TYPE "ScrapeTrigger" AS ENUM ('MANUAL', 'CRON');

CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShopifyProduct" (
    "id" TEXT NOT NULL,
    "shopifyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "vendor" TEXT,
    "handle" TEXT NOT NULL,
    "productType" TEXT,
    "categoryName" TEXT,
    "onlineStoreUrl" TEXT,
    "status" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShopifyProduct_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShopifyVariant" (
    "id" TEXT NOT NULL,
    "shopifyId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sku" TEXT,
    "barcode" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "currencyCode" VARCHAR(3) NOT NULL DEFAULT 'EUR',
    "selectedOptions" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShopifyVariant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Competitor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "legalStatus" "CompetitorLegalStatus" NOT NULL DEFAULT 'PENDING',
    "termsUrl" TEXT,
    "permissionReference" TEXT,
    "robotsCheckedAt" TIMESTAMP(3),
    "termsCheckedAt" TIMESTAMP(3),
    "renderMode" "RenderMode" NOT NULL DEFAULT 'HTTP',
    "priceSelector" TEXT,
    "availabilitySelector" TEXT,
    "requestsPerMinute" INTEGER NOT NULL DEFAULT 6,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Competitor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProductMatch" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "competitorId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" "ProductMatchStatus" NOT NULL DEFAULT 'PENDING',
    "confidenceScore" INTEGER,
    "internalNote" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProductMatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PriceObservation" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "scrapeRunId" TEXT,
    "price" DECIMAL(12,2),
    "currencyCode" VARCHAR(3),
    "availability" TEXT,
    "extractionMethod" "PriceExtractionMethod",
    "httpStatus" INTEGER,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "sourceHash" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PriceObservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScrapeRun" (
    "id" TEXT NOT NULL,
    "trigger" "ScrapeTrigger" NOT NULL,
    "status" "ScrapeRunStatus" NOT NULL DEFAULT 'RUNNING',
    "total" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScrapeRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "JobLock" (
    "id" TEXT NOT NULL,
    "token" TEXT,
    "lockedUntil" TIMESTAMP(3) NOT NULL DEFAULT '1970-01-01 00:00:00',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JobLock_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShopifyProduct_shopifyId_key" ON "ShopifyProduct"("shopifyId");
CREATE INDEX "ShopifyProduct_vendor_idx" ON "ShopifyProduct"("vendor");
CREATE INDEX "ShopifyProduct_status_idx" ON "ShopifyProduct"("status");
CREATE UNIQUE INDEX "ShopifyVariant_shopifyId_key" ON "ShopifyVariant"("shopifyId");
CREATE INDEX "ShopifyVariant_productId_idx" ON "ShopifyVariant"("productId");
CREATE INDEX "ShopifyVariant_sku_idx" ON "ShopifyVariant"("sku");
CREATE UNIQUE INDEX "Competitor_name_key" ON "Competitor"("name");
CREATE UNIQUE INDEX "Competitor_domain_key" ON "Competitor"("domain");
CREATE INDEX "Competitor_active_legalStatus_idx" ON "Competitor"("active", "legalStatus");
CREATE INDEX "ProductMatch_competitorId_status_idx" ON "ProductMatch"("competitorId", "status");
CREATE INDEX "ProductMatch_variantId_status_idx" ON "ProductMatch"("variantId", "status");
CREATE UNIQUE INDEX "ProductMatch_variantId_url_key" ON "ProductMatch"("variantId", "url");
CREATE INDEX "PriceObservation_matchId_observedAt_idx" ON "PriceObservation"("matchId", "observedAt" DESC);
CREATE INDEX "PriceObservation_scrapeRunId_idx" ON "PriceObservation"("scrapeRunId");
CREATE INDEX "ScrapeRun_startedAt_idx" ON "ScrapeRun"("startedAt" DESC);

ALTER TABLE "ShopifyVariant" ADD CONSTRAINT "ShopifyVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ShopifyProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductMatch" ADD CONSTRAINT "ProductMatch_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ShopifyVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductMatch" ADD CONSTRAINT "ProductMatch_competitorId_fkey" FOREIGN KEY ("competitorId") REFERENCES "Competitor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PriceObservation" ADD CONSTRAINT "PriceObservation_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "ProductMatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PriceObservation" ADD CONSTRAINT "PriceObservation_scrapeRunId_fkey" FOREIGN KEY ("scrapeRunId") REFERENCES "ScrapeRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
