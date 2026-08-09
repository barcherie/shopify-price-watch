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
const STALE_RUNNING_JOB_MS = 45 * 60 * 1000;
const MAX_PRODUCTS_PER_RUN = 500;

export class DiscoveryAlreadyRunningError extends Error {}

type DiscoveryQueueLogger = (message: string) => void;

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

export async function createDiscoveryRunFromProducts(input: {
  productQueries: Array<{ productId: string; searchQuery?: string | null }>;
  vendor?: string | null;
}) {
  const productQueries = input.productQueries
    .map((item) => ({
      productId: item.productId.trim(),
      searchQuery: item.searchQuery?.trim() || null,
    }))
    .filter((item) => item.productId);
  if (!productQueries.length) {
    throw new Error("Sélectionnez au moins un produit.");
  }

  const productIds = Array.from(
    new Set(productQueries.map((item) => item.productId)),
  ).slice(0, MAX_PRODUCTS_PER_RUN);
  const queryByProductId = new Map(
    productQueries.map((item) => [item.productId, item.searchQuery]),
  );
  const products = await prisma.shopifyProduct.findMany({
    where: { id: { in: productIds }, status: { not: "DELETED" } },
    select: { id: true },
    orderBy: [{ vendor: "asc" }, { title: "asc" }],
  });
  if (!products.length) {
    throw new Error("Aucun produit valide dans la sélection.");
  }

  return prisma.discoveryRun.create({
    data: {
      totalProducts: products.length,
      vendor: input.vendor?.trim() || null,
      onlyMissing: false,
      message: "Recherche préparée avec des requêtes par produit.",
      status: "RUNNING",
      jobs: {
        createMany: {
          data: products.map((product) => ({
            productId: product.id,
            searchQuery: queryByProductId.get(product.id) || null,
          })),
        },
      },
    },
  });
}

async function refreshRun(runId: string) {
  const exists = await prisma.discoveryRun.findUnique({
    where: { id: runId },
    select: { id: true },
  });
  if (!exists) return null;

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
  const cancelled = jobs
    .filter((job) => job.status === "CANCELLED")
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
    pending > 0
      ? "RUNNING"
      : cancelled === totalProducts
        ? "CANCELLED"
        : hasFailures || cancelled > 0
          ? "PARTIAL"
          : ("SUCCESS" as const);
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
          : cancelled > 0
            ? `Tâche annulée : ${processed}/${totalProducts} produit(s) clôturé(s), dont ${cancelled} annulé(s).`
            : `Terminé : ${found} trouvée(s), ${notFound} sans résultat, ${alreadyExists} déjà renseignée(s), ${errors} erreur(s).`,
      finishedAt: pending > 0 ? null : new Date(),
    },
  });
}

function discoveryProgressMessage(input: {
  productTitle: string;
  competitorName: string;
  current: number;
  total: number;
  status: string;
  message?: string;
}) {
  if (input.status === "STARTED") {
    return `${input.productTitle} : ${input.current}/${input.total} — recherche chez ${input.competitorName}…`;
  }
  const labels = {
    FOUND: "trouvé",
    NOT_FOUND: "non trouvé",
    ERROR: "erreur",
    ALREADY_EXISTS: "déjà renseigné",
  } as const;
  const label = labels[input.status as keyof typeof labels] || input.status;
  return `${input.productTitle} : ${input.current}/${input.total} — ${input.competitorName} : ${label}${input.message ? ` (${input.message})` : ""}`;
}

export async function cancelDiscoveryRun(runId: string) {
  const run = await prisma.discoveryRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error("Tâche introuvable.");
  if (run.status !== "RUNNING") {
    return prisma.discoveryRun.update({
      where: { id: runId },
      data: { message: "Cette tâche est déjà terminée." },
    });
  }

  const cancelled = await prisma.discoveryJob.updateMany({
    where: { runId, status: { in: ["PENDING", "RUNNING"] } },
    data: {
      status: "CANCELLED",
      message: "Produit annulé.",
      progressMessage: "Recherche annulée.",
      finishedAt: new Date(),
    },
  });
  await refreshRun(runId);
  return prisma.discoveryRun.update({
    where: { id: runId },
    data: {
      status: "CANCELLED",
      message: `${cancelled.count} produit(s) annulé(s).`,
      finishedAt: new Date(),
    },
  });
}

export async function deleteDiscoveryRun(runId: string) {
  const run = await prisma.discoveryRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error("Tâche introuvable.");

  await prisma.discoveryRun.delete({ where: { id: runId } });
}

export async function updateDiscoveryJobSearchQuery(input: {
  jobId: string;
  searchQuery?: string | null;
}) {
  const job = await prisma.discoveryJob.findUnique({
    where: { id: input.jobId },
    include: { run: true },
  });
  if (!job) throw new Error("Produit de tâche introuvable.");
  if (job.status !== "PENDING") {
    throw new Error(
      "La requête peut être modifiée seulement avant le traitement du produit.",
    );
  }
  if (job.run.status !== "RUNNING") {
    throw new Error("Cette tâche n’est plus en cours.");
  }

  return prisma.discoveryJob.update({
    where: { id: input.jobId },
    data: { searchQuery: input.searchQuery?.trim() || null },
  });
}

export async function processDiscoveryQueue(options?: {
  batchSize?: number;
  logger?: DiscoveryQueueLogger;
}) {
  const lockToken = await acquireLock();
  const batchSize = Math.min(
    10,
    Math.max(1, options?.batchSize || DEFAULT_BATCH_SIZE),
  );
  const logger = options?.logger;
  const touchedRuns = new Set<string>();
  let processed = 0;

  try {
    const staleThreshold = new Date(Date.now() - STALE_RUNNING_JOB_MS);
    const recoveredJobs = await prisma.discoveryJob.updateMany({
      where: {
        status: "RUNNING",
        startedAt: { lt: staleThreshold },
        run: { status: "RUNNING" },
      },
      data: {
        status: "PENDING",
        message:
          "Recherche précédente interrompue avant la fin. Nouveau passage prévu.",
        startedAt: null,
      },
    });
    if (recoveredJobs.count > 0) {
      logger?.(
        `${recoveredJobs.count} produit(s) interrompu(s) remis en attente.`,
      );
    }

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
    logger?.(
      jobs.length
        ? `${jobs.length} produit(s) à traiter dans ce passage.`
        : "Aucun produit en attente.",
    );

    for (const [index, job] of jobs.entries()) {
      await renewLock(lockToken);
      touchedRuns.add(job.runId);
      const searchQuery = job.searchQuery || job.run.query || null;
      logger?.(
        `Produit ${index + 1}/${jobs.length} : ${job.product.title} — recherche lancée.`,
      );
      await prisma.discoveryJob.update({
        where: { id: job.id },
        data: {
          status: "RUNNING",
          startedAt: new Date(),
          progressMessage: `${job.product.title} : préparation de la recherche…`,
        },
      });

      try {
        const results = await discoverProductMatches(job.productId, searchQuery, {
          onProgress: async (event) => {
            const progressMessage = discoveryProgressMessage({
              productTitle: job.product.title,
              competitorName: event.competitorName,
              current: event.current,
              total: event.total,
              status: event.status,
              message: event.message,
            });
            logger?.(progressMessage);
            await prisma.discoveryJob.updateMany({
              where: { id: job.id, status: "RUNNING" },
              data: { progressMessage },
            });
          },
        });
        const summary = summarizeResults(results);
        logger?.(
          `Produit ${index + 1}/${jobs.length} : ${summary.found} trouvée(s), ${summary.notFound} sans résultat, ${summary.alreadyExists} déjà présente(s), ${summary.errors} erreur(s).`,
        );
        const updated = await prisma.discoveryJob.updateMany({
          where: { id: job.id, status: "RUNNING" },
          data: {
            ...summary,
            status: jobStatus(summary),
            message: `${job.product.title} : ${summary.found} trouvée(s), ${summary.notFound} sans résultat, ${summary.alreadyExists} déjà renseignée(s), ${summary.errors} erreur(s).`,
            progressMessage: "Recherche terminée.",
            finishedAt: new Date(),
          },
        });
        if (updated.count === 0) {
          logger?.(
            `Produit ${index + 1}/${jobs.length} : mise à jour ignorée, tâche annulée ou supprimée.`,
          );
        }
      } catch (error) {
        logger?.(
          `Produit ${index + 1}/${jobs.length} : erreur pendant la recherche.`,
        );
        await prisma.discoveryJob.updateMany({
          where: { id: job.id, status: "RUNNING" },
          data: {
            status: "FAILED",
            errors: 1,
            message:
              error instanceof Error
                ? error.message.slice(0, 500)
                : "Erreur inconnue pendant la recherche.",
            progressMessage: "Recherche arrêtée sur une erreur.",
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
