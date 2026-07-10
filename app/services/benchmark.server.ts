import prisma from "../db.server";

export type BenchmarkStatus = "TOP_PRICE" | "COMPETITIVE" | "WATCH" | "FIX";

export type BenchmarkInput = {
  productId: string;
  productTitle: string;
  vendor: string | null;
  category: string | null;
  featuredImageUrl: string | null;
  featuredImageAlt: string | null;
  shopifyPrice: number;
  currencyCode: string;
  matches: Array<{
    status: "PENDING" | "VALIDATED" | "REJECTED";
    competitorName: string;
    price: number | null;
    previousPrice: number | null;
    currencyCode: string | null;
    observedAt: Date | null;
  }>;
};

export type BenchmarkRow = {
  productId: string;
  productTitle: string;
  vendor: string | null;
  category: string | null;
  featuredImageUrl: string | null;
  featuredImageAlt: string | null;
  shopifyPrice: number;
  currencyCode: string;
  bestCompetitorPrice: number | null;
  bestCompetitorPreviousPrice: number | null;
  bestCompetitorTrend: "UP" | "DOWN" | "STABLE" | null;
  bestCompetitorName: string | null;
  competitorNames: string[];
  differenceAmount: number | null;
  differencePercent: number | null;
  cheaperCompetitors: number;
  moreExpensiveCompetitors: number;
  matchCount: number;
  status: BenchmarkStatus;
  lastObservedAt: string | null;
};

export function statusFromDifference(
  shopifyPrice: number,
  bestPrice: number | null,
): BenchmarkStatus {
  if (bestPrice === null || bestPrice <= 0) return "WATCH";
  const differencePercent = ((shopifyPrice - bestPrice) / bestPrice) * 100;
  if (differencePercent <= 0) return "TOP_PRICE";
  if (differencePercent < 2) return "COMPETITIVE";
  if (differencePercent <= 5) return "WATCH";
  return "FIX";
}

export function buildBenchmarkRows(products: BenchmarkInput[]): BenchmarkRow[] {
  return products.flatMap((product) => {
    const validatedMatches = product.matches.filter(
      (match) => match.status === "VALIDATED",
    );
    if (!validatedMatches.length) return [];

    const observations = validatedMatches
      .filter(
        (match) =>
          match.price !== null &&
          match.price > 0 &&
          match.currencyCode === product.currencyCode,
      )
      .sort((a, b) => (a.price || 0) - (b.price || 0));
    const best = observations[0] || null;
    const bestPrice = best?.price ?? null;
    const bestPreviousPrice = best?.previousPrice ?? null;
    const bestTrend =
      bestPrice === null || bestPreviousPrice === null
        ? null
        : bestPrice > bestPreviousPrice
          ? "UP"
          : bestPrice < bestPreviousPrice
            ? "DOWN"
            : "STABLE";
    const differenceAmount =
      bestPrice === null ? null : product.shopifyPrice - bestPrice;
    const differencePercent =
      bestPrice === null
        ? null
        : ((product.shopifyPrice - bestPrice) / bestPrice) * 100;

    return [
      {
        productId: product.productId,
        productTitle: product.productTitle,
        vendor: product.vendor,
        category: product.category,
        featuredImageUrl: product.featuredImageUrl,
        featuredImageAlt: product.featuredImageAlt,
        shopifyPrice: product.shopifyPrice,
        currencyCode: product.currencyCode,
        bestCompetitorPrice: bestPrice,
        bestCompetitorPreviousPrice: bestPreviousPrice,
        bestCompetitorTrend: bestTrend,
        bestCompetitorName: best?.competitorName ?? null,
        competitorNames: validatedMatches.map((match) => match.competitorName),
        differenceAmount,
        differencePercent,
        cheaperCompetitors: observations.filter(
          (observation) => (observation.price || 0) < product.shopifyPrice,
        ).length,
        moreExpensiveCompetitors: observations.filter(
          (observation) => (observation.price || 0) > product.shopifyPrice,
        ).length,
        matchCount: validatedMatches.length,
        status: statusFromDifference(product.shopifyPrice, bestPrice),
        lastObservedAt:
          observations
            .map((observation) => observation.observedAt)
            .filter((date): date is Date => date !== null)
            .sort((a, b) => b.getTime() - a.getTime())[0]
            ?.toISOString() ?? null,
      },
    ];
  });
}

export async function getBenchmarkRows(): Promise<BenchmarkRow[]> {
  const products = await prisma.shopifyProduct.findMany({
    where: {
      status: { not: "DELETED" },
      matches: { some: { status: "VALIDATED" } },
    },
    include: {
      matches: {
        where: {
          status: "VALIDATED",
          competitor: { active: true },
        },
        include: {
          competitor: true,
          observations: {
            where: { success: true, price: { not: null } },
            orderBy: { observedAt: "desc" },
            take: 2,
          },
        },
      },
    },
    orderBy: { title: "asc" },
  });

  return buildBenchmarkRows(
    products.map((product) => ({
      productId: product.id,
      productTitle: product.title,
      vendor: product.vendor,
      category: product.categoryName || product.productType || null,
      featuredImageUrl: product.featuredImageUrl,
      featuredImageAlt: product.featuredImageAlt,
      shopifyPrice: Number(product.price),
      currencyCode: product.currencyCode,
      matches: product.matches.map((match) => ({
        status: match.status,
        competitorName: match.competitor.name,
        price: match.observations[0]?.price
          ? Number(match.observations[0].price)
          : null,
        previousPrice: match.observations[1]?.price
          ? Number(match.observations[1].price)
          : null,
        currencyCode: match.observations[0]?.currencyCode || null,
        observedAt: match.observations[0]?.observedAt || null,
      })),
    })),
  );
}
