import { describe, expect, it } from "vitest";
import {
  buildBenchmarkRows,
  statusFromDifference,
  type BenchmarkInput,
} from "./benchmark.server";

function product(
  matches: BenchmarkInput["matches"],
  shopifyPrice = 100,
): BenchmarkInput {
  return {
    productId: "product-1",
    productTitle: "Arc test",
    vendor: "Test",
    category: "Arcs",
    featuredImageUrl: null,
    featuredImageAlt: null,
    shopifyPrice,
    currencyCode: "EUR",
    matches,
  };
}

describe("buildBenchmarkRows", () => {
  it("exclut un produit sans correspondance", () => {
    expect(buildBenchmarkRows([product([])])).toEqual([]);
  });

  it("ignore une correspondance rejetée", () => {
    expect(
      buildBenchmarkRows([
        product([
          {
            status: "REJECTED",
            competitorName: "Concurrent",
            price: 90,
            currencyCode: "EUR",
            observedAt: new Date(),
          },
        ]),
      ]),
    ).toEqual([]);
  });

  it("affiche un produit avec une correspondance validée", () => {
    const rows = buildBenchmarkRows([
      product([
        {
          status: "VALIDATED",
          competitorName: "Concurrent",
          price: 90,
          currencyCode: "EUR",
          observedAt: new Date("2026-07-03"),
        },
      ]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].bestCompetitorName).toBe("Concurrent");
  });
});

describe("statusFromDifference", () => {
  it.each([
    [99, 100, "TOP_PRICE"],
    [101.99, 100, "COMPETITIVE"],
    [102, 100, "WATCH"],
    [105, 100, "WATCH"],
    [105.01, 100, "FIX"],
  ] as const)("%s face à %s donne %s", (shop, best, expected) => {
    expect(statusFromDifference(shop, best)).toBe(expected);
  });
});
