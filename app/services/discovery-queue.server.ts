import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import {
  discoverProductMatches,
  type DiscoveryResult,
} from "./product-discovery.server";

const LOCK_ID = "price-watch-discovery";
const LOCK_DURATION_MS = 30 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 3;
const MAX_PRODUCTS_PER_RUN = 500;

export class DiscoveryAlreadyRunningError extends Error {}

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
  if (acquired.count !== 1) throw new DiscoveryAlreadyRunningError();
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

function summarizeResults(results: DiscoveryResult[]) {
  return {
    found: results.filter((result) => result.status === "FOUND").length,
    notFound: results.filter((result) => result.status === "NOT_FOUND").length,
    alreadyExists: results.filter(
      (result) => result.status === "ALREADY_EXISTS",
    ).length,
    errors: results.filter((result) => result.status === "ERROR").length,
  };
}

function jobStatus(summary: ReturnType<typeof summarizeResults>) {
  if (summary.errors > 0 && summary.found === 0 && summary.alreadyExists === 0) {
    return "FAILED" as const;
  }
  if (summary.errors > 0 || summary.notFound > 0) {
    return "PARTIAL" as const;
  }
  return "SUCCESS" as const;
}

export async function createDiscoveryRun(input: {
  query?: string | null;
  vendor?: string | null;
  onlyMissing?: boolean;
  limit?: number;
}) {
  const query = input.query?.trim() || null;
  const vendor = input.vendor?.trim() || null;
  const onlyMissing = input.onlyMissing !== false;
  const limit = Math.min(
    MAX_PRODUCTS_PER_RUN,
    Math.max(1, input.limit || MAX_PRODUCTS_PER_RUN),
  );
  const where: Prisma.ShopifyProductWhereInput = {
    status: { not: "DELETED" },
    ...(vendor ? { vendor } : undefined),
    ...(query
      ? {
          OR: [
            { title: { contains: query, mode: "insensitive" } },
            { vendor: { contains: query, mode: "insensitive" } },
            { firstVariantSku: { contains: query, mode: "insensitive" } },
          ],
        }
      : undefined),
    ...(onlyMissing
      ? {
          matches: {
            none: {
              status: { in: ["PENDING", "VALIDATED"] },
              competitor: { active: true, legalStatus: "APPROVED" },
            },
          },
        }
      : undefined),
  };

  const products = await prisma.shopifyProduct.findMany({
    where,
    select: { id: true },
    orderBy: [{ vendor: "asc" }, { title: "asc" }],
    take: limit,
  });

  const run = await prisma.discoveryRun.create({
    data: {
      totalProducts: products.length,
      query,
      vendor,
      onlyMissing,
      message: products.length
        ? "Recherche en attente de traitement."
        : "Aucun produit ne correspond aux filtres.",
      finishedAt: products.length ? null : new Date(),
      status: products.length ? "RUNNING" : "SUCCESS",
      jobs: {
        createMany: {
          data: products.map((product) => ({ productId: product.id })),
        },
      },
    },
  });

  return run;
}

async function refreshRun(runId: string) {
  const jobs = await prisma.discoveryJob.groupBy({
    by: ["status"],
    where: { runId },
    _count: { _all: true },
    _sum: {
      found: true,
      notFound: true,
      alreadyExists: true,
      errors: true,
    },
  });
  const totalProducts = jobs.reduce((sum, job) => sum + job._count._all, 0);
  const pending = jobs
    .filter((job) => job.status === "PENDING" || job.status === "RUNNING")
    .reduce((sum, job) => sum + job._count._all, 0);
  const processed = totalProducts - pending;
  const found = jobs.reduce((sum, job) => sum + (job._sum.found || 0), 0);
  const notFound = jobs.reduce((sum, job) => sum + (job._sum.notFound || 0), 0);
  const alreadyExists = jobs.reduce(
    (sum, job) => sum + (job._sum.alreadyExists || 0),
    0,
  );
  const errors = jobs.reduce((sum, job) => sum + (job._sum.errors || 0), 0);
  const hasFailures = jobs.some(
    (job) => job.status === "FAILED" || job.status === "PARTIAL",
  );
  const status =
    pending > 0 ? "RUNNING" : hasFailures ? "PARTIAL" : ("SUCCESS" as const);
  return prisma.discoveryRun.update({
    where: { id: runId },
    data: {
      status,
      totalProducts,
      processed,
      found,
      notFound,
      alreadyExists,
      errors,
      message:
        pending > 0
          ? `${processed}/${totalProducts} produit(s) traités.`
          : `Terminé : ${found} trouvée(s), ${notFound} sans résultat, ${alreadyExists} déjà renseignée(s), ${errors} erreur(s).`,
      finishedAt: pending > 0 ? null : new Date(),
    },
  });
}

export async function processDiscoveryQueue(options?: { batchSize?: number }) {
  const lockToken = await acquireLock();
  const batchSize = Math.min(10, Math.max(1, options?.batchSize || DEFAULT_BATCH_SIZE));
  const touchedRuns = new Set<string>();
  let processed = 0;

  try {
    const jobs = await prisma.discoveryJob.findMany({
      where: {
        status: "PENDING",
        run: { status: "RUNNING" },
      },
      include: {
        product: { select: { title: true } },
        run: { select: { query: true } },
      },
      orderBy: { createdAt: "asc" },
      take: batchSize,
    });

    for (const job of jobs) {
      await renewLock(lockToken);
      touchedRuns.add(job.runId);
      const searchQuery = job.searchQuery || job.run.query || null;
      await prisma.discoveryJob.update({
        where: { id: job.id },
        data: { status: "RUNNING", startedAt: new Date() },
      });

      try {
        const results = await discoverProductMatches(job.productId, searchQuery);
        const summary = summarizeResults(results);
        await prisma.discoveryJob.update({
          where: { id: job.id },
          data: {
            ...summary,
            status: jobStatus(summary),
            message: `${job.product.title} : ${summary.found} trouvée(s), ${summary.notFound} sans résultat, ${summary.alreadyExists} déjà renseignée(s), ${summary.errors} erreur(s).`,
            finishedAt: new Date(),
          },
        });
      } catch (error) {
        await prisma.discoveryJob.update({
          where: { id: job.id },
          data: {
            status: "FAILED",
            errors: 1,
            message:
              error instanceof Error
                ? error.message.slice(0, 500)
                : "Erreur inconnue pendant la recherche.",
            finishedAt: new Date(),
          },
        });
      }
      processed += 1;
    }

    for (const runId of touchedRuns) {
      await refreshRun(runId);
    }

    return { processed, runIds: Array.from(touchedRuns) };
  } finally {
    await releaseLock(lockToken);
  }
}
