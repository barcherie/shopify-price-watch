import prisma from "../db.server";

export type BenchmarkStatus = "TOP_PRICE" | "COMPETITIVE" | "WATCH" | "FIX";

export type BenchmarkRow = {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  vendor: string | null;
  category: string | null;
  sku: string | null;
  shopifyPrice: number;
  currencyCode: string;
  bestCompetitorPrice: number | null;
  bestCompetitorName: string | null;
  differenceAmount: number | null;
  differencePercent: number | null;
  cheaperCompetitors: number;
  matchCount: number;
  status: BenchmarkStatus;
  lastObservedAt: string | null;
};

function statusFromDifference(
  shopifyPrice: number,
  bestPrice: number | null,
): BenchmarkStatus {
  if (bestPrice === null || bestPrice <= 0) return "WATCH";
  const differencePercent = ((shopifyPrice - bestPrice) / bestPrice) * 100;
  if (differencePercent <= 0) return "TOP_PRICE";
  if (differencePercent <= 3) return "COMPETITIVE";
  if (differencePercent <= 8) return "WATCH";
  return "FIX";
}

export async function getBenchmarkRows(): Promise<BenchmarkRow[]> {
  const variants = await prisma.shopifyVariant.findMany({
    where: {
      active: true,
      product: { status: { not: "DELETED" } },
    },
    include: {
      product: true,
      matches: {
        where: {
          status: "VALIDATED",
          competitor: { active: true },
        },
        include: {
          competitor: true,
          observations: {
            where: { price: { not: null } },
            orderBy: { observedAt: "desc" },
            take: 1,
          },
        },
      },
    },
    orderBy: [{ product: { title: "asc" } }, { title: "asc" }],
  });

  return variants.map((variant) => {
    const shopifyPrice = Number(variant.price);
    const observations = variant.matches
      .map((match) => {
        const observation = match.observations[0];
        if (
          !observation?.price ||
          observation.currencyCode !== variant.currencyCode
        ) {
          return null;
        }
        return {
          price: Number(observation.price),
          competitor: match.competitor.name,
          observedAt: observation.observedAt,
        };
      })
      .filter((value): value is NonNullable<typeof value> => value !== null)
      .sort((a, b) => a.price - b.price);

    const best = observations[0] || null;
    const differenceAmount = best ? shopifyPrice - best.price : null;
    const differencePercent =
      best && best.price > 0
        ? ((shopifyPrice - best.price) / best.price) * 100
        : null;

    return {
      variantId: variant.id,
      productTitle: variant.product.title,
      variantTitle: variant.title,
      vendor: variant.product.vendor,
      category:
        variant.product.categoryName || variant.product.productType || null,
      sku: variant.sku,
      shopifyPrice,
      currencyCode: variant.currencyCode,
      bestCompetitorPrice: best?.price ?? null,
      bestCompetitorName: best?.competitor ?? null,
      differenceAmount,
      differencePercent,
      cheaperCompetitors: observations.filter(
        (observation) => observation.price < shopifyPrice,
      ).length,
      matchCount: variant.matches.length,
      status: statusFromDifference(shopifyPrice, best?.price ?? null),
      lastObservedAt: best?.observedAt.toISOString() ?? null,
    };
  });
}
