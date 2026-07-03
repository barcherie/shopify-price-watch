import { createHash, randomUUID } from "node:crypto";
import type { ScrapeTrigger } from "@prisma/client";
import prisma from "../db.server";
import { extractPriceFromHtml } from "./price-extractor.server";
import { fetchHtmlPage, fetchRenderedPage } from "./page-fetcher.server";
import { UnsafeUrlError } from "./url-safety.server";

const LOCK_ID = "price-watch-scrape";
const LOCK_DURATION_MS = 30 * 60 * 1000;

export class ScrapeAlreadyRunningError extends Error {}

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
}) {
  const lockToken = await acquireLock();
  let runId: string | null = null;

  try {
    const matches = await prisma.productMatch.findMany({
      where: {
        status: "VALIDATED",
        ...(options.matchId ? { id: options.matchId } : {}),
        competitor: {
          active: true,
          legalStatus: "APPROVED",
        },
      },
      include: { competitor: true },
      orderBy: [{ competitorId: "asc" }, { createdAt: "asc" }],
    });

    const run = await prisma.scrapeRun.create({
      data: {
        trigger: options.trigger,
        total: matches.length,
      },
    });
    runId = run.id;

    let succeeded = 0;
    let failed = 0;
    const lastRequestAt = new Map<string, number>();

    for (const match of matches) {
      await renewLock(lockToken);

      const minimumDelay = Math.ceil(
        60_000 / Math.max(1, match.competitor.requestsPerMinute),
      );
      const previousRequest = lastRequestAt.get(match.competitorId);
      if (previousRequest) {
        const remaining = minimumDelay - (Date.now() - previousRequest);
        if (remaining > 0) await wait(remaining);
      }
      lastRequestAt.set(match.competitorId, Date.now());

      try {
        const page =
          match.competitor.renderMode === "BROWSER"
            ? await fetchRenderedPage(match.url, match.competitor.domain)
            : await fetchHtmlPage(match.url, match.competitor.domain);

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
            scrapeRunId: run.id,
            price: extracted.price,
            currencyCode: extracted.currencyCode,
            availability: extracted.availability,
            extractionMethod: extracted.method,
            httpStatus: page.status,
            sourceHash: createHash("sha256").update(page.html).digest("hex"),
          },
        });
        succeeded += 1;
      } catch (error) {
        const details = errorDetails(error);
        await prisma.priceObservation.create({
          data: {
            matchId: match.id,
            scrapeRunId: run.id,
            errorCode: details.code,
            errorMessage: details.message,
          },
        });
        failed += 1;
      } finally {
        await prisma.productMatch.update({
          where: { id: match.id },
          data: { lastCheckedAt: new Date() },
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
