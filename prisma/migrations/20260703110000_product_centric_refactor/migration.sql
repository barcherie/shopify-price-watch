-- Product-centric Price Watch refactor.
CREATE TYPE "RobotsAccessStatus" AS ENUM ('UNKNOWN', 'ALLOWED', 'DISALLOWED');

ALTER TABLE "ShopifyProduct"
  ADD COLUMN "featuredImageUrl" TEXT,
  ADD COLUMN "featuredImageAlt" TEXT,
  ADD COLUMN "firstVariantShopifyId" TEXT,
  ADD COLUMN "firstVariantTitle" TEXT,
  ADD COLUMN "firstVariantSku" TEXT,
  ADD COLUMN "price" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "currencyCode" VARCHAR(3) NOT NULL DEFAULT 'EUR',
  ADD COLUMN "shopifyCreatedAt" TIMESTAMP(3),
  ADD COLUMN "shopifyUpdatedAt" TIMESTAMP(3);

WITH first_variants AS (
  SELECT DISTINCT ON ("productId")
    "productId", "shopifyId", "title", "sku", "price", "currencyCode"
  FROM "ShopifyVariant"
  WHERE "active" = true
  ORDER BY "productId", "createdAt" ASC, "id" ASC
)
UPDATE "ShopifyProduct" product
SET
  "firstVariantShopifyId" = variant."shopifyId",
  "firstVariantTitle" = variant."title",
  "firstVariantSku" = variant."sku",
  "price" = variant."price",
  "currencyCode" = variant."currencyCode"
FROM first_variants variant
WHERE variant."productId" = product."id";

ALTER TABLE "Competitor"
  ADD COLUMN "robotsContent" TEXT,
  ADD COLUMN "robotsAccess" "RobotsAccessStatus" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "robotsOverrideConfirmed" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ProductMatch"
  ADD COLUMN "productId" TEXT,
  ADD COLUMN "lastScrapedAt" TIMESTAMP(3);

UPDATE "ProductMatch" match
SET "productId" = variant."productId",
    "lastScrapedAt" = match."lastCheckedAt"
FROM "ShopifyVariant" variant
WHERE match."variantId" = variant."id";

DELETE FROM "ProductMatch" duplicate
USING "ProductMatch" retained
WHERE duplicate."productId" = retained."productId"
  AND duplicate."url" = retained."url"
  AND (
    duplicate."createdAt" > retained."createdAt"
    OR (
      duplicate."createdAt" = retained."createdAt"
      AND duplicate."id" > retained."id"
    )
  );

ALTER TABLE "ProductMatch"
  ALTER COLUMN "productId" SET NOT NULL;

ALTER TABLE "PriceObservation"
  ADD COLUMN "competitorId" TEXT,
  ADD COLUMN "url" TEXT,
  ADD COLUMN "durationMs" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "success" BOOLEAN NOT NULL DEFAULT false;

UPDATE "PriceObservation" observation
SET
  "competitorId" = match."competitorId",
  "url" = match."url",
  "success" = observation."price" IS NOT NULL AND observation."errorCode" IS NULL
FROM "ProductMatch" match
WHERE observation."matchId" = match."id";

ALTER TABLE "PriceObservation"
  ALTER COLUMN "competitorId" SET NOT NULL,
  ALTER COLUMN "url" SET NOT NULL;

ALTER TABLE "ScrapeRun"
  ADD COLUMN "skipped" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ProductMatch" DROP CONSTRAINT "ProductMatch_variantId_fkey";
ALTER TABLE "ProductMatch"
  DROP COLUMN "variantId",
  DROP COLUMN "confidenceScore",
  DROP COLUMN "internalNote",
  DROP COLUMN "lastCheckedAt";

ALTER TABLE "Competitor"
  DROP COLUMN "requestsPerMinute";

DROP TABLE "ShopifyVariant";

DROP INDEX IF EXISTS "ProductMatch_variantId_status_idx";
DROP INDEX IF EXISTS "ProductMatch_variantId_url_key";

CREATE INDEX "ShopifyProduct_title_idx" ON "ShopifyProduct"("title");
CREATE INDEX "ProductMatch_productId_status_idx" ON "ProductMatch"("productId", "status");
CREATE INDEX "ProductMatch_lastScrapedAt_idx" ON "ProductMatch"("lastScrapedAt");
CREATE UNIQUE INDEX "ProductMatch_productId_url_key" ON "ProductMatch"("productId", "url");
CREATE INDEX "PriceObservation_competitorId_observedAt_idx" ON "PriceObservation"("competitorId", "observedAt" DESC);

ALTER TABLE "ProductMatch"
  ADD CONSTRAINT "ProductMatch_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "ShopifyProduct"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PriceObservation"
  ADD CONSTRAINT "PriceObservation_competitorId_fkey"
  FOREIGN KEY ("competitorId") REFERENCES "Competitor"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
