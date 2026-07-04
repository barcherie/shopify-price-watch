ALTER TABLE "ScrapeRun"
  ADD COLUMN "errorMessage" TEXT;

ALTER TABLE "Competitor"
  ADD COLUMN "searchUrlTemplate" TEXT;

UPDATE "Competitor"
SET "searchUrlTemplate" = 'https://www.bourgognearcherie.com/recherche?s={query}'
WHERE "domain" = 'bourgognearcherie.com';

CREATE TABLE "AutomationSettings" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "intervalDays" INTEGER NOT NULL DEFAULT 5,
  "nextRunAt" TIMESTAMP(3),
  "lastSchedulerCheckAt" TIMESTAMP(3),
  "lastSchedulerStatus" TEXT,
  "lastSchedulerMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AutomationSettings_pkey" PRIMARY KEY ("id")
);

INSERT INTO "AutomationSettings" (
  "id",
  "enabled",
  "intervalDays",
  "nextRunAt",
  "updatedAt"
)
VALUES (
  'default',
  true,
  5,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;
