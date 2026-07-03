import { createHash, randomInt, randomUUID } from "node:crypto";
import type { ScrapeTrigger } from "@prisma/client";
import prisma from "../db.server";
import { extractPriceFromHtml } from "./price-extractor.server";
import { fetchHtmlPage, fetchRenderedPage } from "./page-fetcher.server";
import { robotsAllowsPath } from "./robots.server";
import { UnsafeUrlError } from "./url-safety.server";

const LOCK_ID = "price-watch-scrape";
const LOCK_DURATION_MS = 30 * 60 * 1000;
export const SCRAPE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export class ScrapeAlreadyRunningError extends Error {}

export function isScrapeDue(
  lastScrapedAt: Date | null,
  now = new Date(),
  force = false,
) {
  return (
    force ||
    !lastScrapedAt ||
    now.getTime() - lastScrapedAt.getTime() >= SCRAPE_COOLDOWN_MS
  );
}

async function acquireLock() {
  const token = randomUUID();
  const now = new Date();
  await prisma.jobLock.upsert({
    where: { id: LOCK_ID },
    update: {},
    create: { id: LOCK_ID, lockedUntil: new Date(0) },
  });
  const acquired = await prisma.jobLock.updateMany({
    where: { id: LOCK_ID, lockedUntil: { lt: now } },
    data: {
      token,
      lockedUntil: new Date(now.getTime() + LOCK_DURATION_MS),
    },
  });
  if (acquired.count !== 1) throw new ScrapeAlreadyRunningError();
  return token;
}

async function renewLock(token: string) {
  await prisma.jobLock.updateMany({
    where: { id: LOCK_ID, token },
    data: { lockedUntil: new Date(Date.now() + LOCK_DURATION_MS) },
  });
}

async function releaseLock(token: string) {
  await prisma.jobLock.updateMany({
    where: { id: LOCK_ID, token },
    data: { token: null, lockedUntil: new Date(0) },
  });
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorDetails(error: unknown) {
  if (error instanceof UnsafeUrlError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return { code: "TIMEOUT", message: "La page n’a pas répondu à temps." };
    }
    return { code: "EXTRACTION_ERROR", message: error.message.slice(0, 500) };
  }
  return { code: "UNKNOWN_ERROR", message: "Erreur inconnue." };
}

export async function runPriceWatch(options: {
  trigger: ScrapeTrigger;
  matchId?: string;
  force?: boolean;
}) {
  const force = options.force === true;
  if (force && process.env.NODE_ENV === "production") {
    throw new Error("Le mode FORCE est interdit en production.");
  }

  const lockToken = await acquireLock();
  let runId: string | null = null;

  try {
    const matches = await prisma.productMatch.findMany({
      where: {
        status: "VALIDATED",
        ...(options.matchId ? { id: options.matchId } : {}),
        competitor: { active: true, legalStatus: "APPROVED" },
      },
      include: { competitor: true },
      orderBy: [{ competitorId: "asc" }, { createdAt: "asc" }],
    });

    const run = await prisma.scrapeRun.create({
      data: { trigger: options.trigger, total: matches.length },
    });
    runId = run.id;

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    let hasMadeRequest = false;

    for (const match of matches) {
      await renewLock(lockToken);
      const now = new Date();

      if (!isScrapeDue(match.lastScrapedAt, now, force)) {
        await prisma.priceObservation.create({
          data: {
            matchId: match.id,
            competitorId: match.competitorId,
            scrapeRunId: run.id,
            url: match.url,
            durationMs: 0,
            success: false,
            errorCode: "SKIPPED_24H",
            errorMessage: "URL déjà relevée au cours des dernières 24 heures.",
          },
        });
        skipped += 1;
        continue;
      }

      const target = new URL(match.url);
      const robotsAllowed = robotsAllowsPath(
        match.competitor.robotsContent,
        target.pathname,
      );
      if (!robotsAllowed && !match.competitor.robotsOverrideConfirmed) {
        await prisma.priceObservation.create({
          data: {
            matchId: match.id,
            competitorId: match.competitorId,
            scrapeRunId: run.id,
            url: match.url,
            durationMs: 0,
            success: false,
            errorCode: "ROBOTS_DISALLOWED",
            errorMessage:
              "robots.txt interdit ce chemin. Une confirmation manuelle est requise.",
          },
        });
        failed += 1;
        continue;
      }

      if (hasMadeRequest) {
        await wait(randomInt(2_000, 5_001));
      }
      hasMadeRequest = true;

      const startedAt = Date.now();
      let httpStatus: number | null = null;
      try {
        const page =
          match.competitor.renderMode === "BROWSER"
            ? await fetchRenderedPage(match.url, match.competitor.domain)
            : await fetchHtmlPage(match.url, match.competitor.domain);
        httpStatus = page.status;

        if (page.status === 403 || page.status === 429) {
          await prisma.competitor.update({
            where: { id: match.competitorId },
            data: { active: false },
          });
          throw new Error(
            `Le concurrent a répondu ${page.status}; la collecte a été mise en pause.`,
          );
        }
        if (page.status < 200 || page.status >= 300) {
          throw new Error(
            `La page a répondu avec le statut HTTP ${page.status}.`,
          );
        }

        const extracted = extractPriceFromHtml(page.html, {
          priceSelector: match.competitor.priceSelector,
          availabilitySelector: match.competitor.availabilitySelector,
        });
        if (!extracted) {
          throw new Error("Aucun prix unique et fiable n’a été détecté.");
        }

        await prisma.priceObservation.create({
          data: {
            matchId: match.id,
            competitorId: match.competitorId,
            scrapeRunId: run.id,
            url: page.finalUrl,
            price: extracted.price,
            currencyCode: extracted.currencyCode,
            availability: extracted.availability,
            extractionMethod: extracted.method,
            httpStatus: page.status,
            durationMs: Date.now() - startedAt,
            success: true,
            sourceHash: createHash("sha256").update(page.html).digest("hex"),
          },
        });
        succeeded += 1;
      } catch (error) {
        const details = errorDetails(error);
        await prisma.priceObservation.create({
          data: {
            matchId: match.id,
            competitorId: match.competitorId,
            scrapeRunId: run.id,
            url: match.url,
            httpStatus,
            durationMs: Date.now() - startedAt,
            success: false,
            errorCode: details.code,
            errorMessage: details.message,
          },
        });
        failed += 1;
      } finally {
        await prisma.productMatch.update({
          where: { id: match.id },
          data: { lastScrapedAt: new Date() },
        });
      }
    }

    const status =
      failed === 0 ? "SUCCESS" : succeeded === 0 ? "FAILED" : "PARTIAL";
    return prisma.scrapeRun.update({
      where: { id: run.id },
      data: {
        status,
        succeeded,
        failed,
        skipped,
        finishedAt: new Date(),
      },
    });
  } catch (error) {
    if (runId) {
      await prisma.scrapeRun.update({
        where: { id: runId },
        data: { status: "FAILED", finishedAt: new Date() },
      });
    }
    throw error;
  } finally {
    await releaseLock(lockToken);
  }
}
