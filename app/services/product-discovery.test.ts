import { describe, expect, it } from "vitest";
import {
  buildSearchQueries,
  extractSitemapLocations,
  scoreProductCandidate,
  sitemapUrlsFromRobots,
} from "./product-discovery.server";

describe("product discovery", () => {
  it("prioritise une URL contenant le SKU", () => {
    expect(
      scoreProductCandidate(
        {
          title: "Central Ramrods Vektor V2",
          vendor: "Ramrods",
          sku: "RR-VEC-29",
        },
        "https://example.com/produit/rr-vec-29",
      ),
    ).toBe(1);
  });

  it("score une URL à partir de la marque et du titre", () => {
    expect(
      scoreProductCandidate(
        {
          title: "Central Ramrods Vektor V2",
          vendor: "Ramrods",
          sku: null,
        },
        "https://example.com/stabilisation/central-ramrods-vektor-v2",
      ),
    ).toBeGreaterThanOrEqual(0.5);
  });

  it("ignore un produit sans rapport", () => {
    expect(
      scoreProductCandidate(
        {
          title: "Central Ramrods Vektor V2",
          vendor: "Ramrods",
          sku: null,
        },
        "https://example.com/arc-classique-debutant",
      ),
    ).toBe(0);
  });

  it("préfère le produit exact à une déclinaison supplémentaire", () => {
    const product = {
      title: "Central Ramrods Vektor V2",
      vendor: "Ramrods",
      sku: null,
    };
    const exact = scoreProductCandidate(
      product,
      "https://example.com/central-ramrods-vektor-v2",
      "Central Ramrods Vektor V2",
    );
    const tungsten = scoreProductCandidate(
      product,
      "https://example.com/central-ramrods-vektor-v2-tungsten-damping",
      "Central Ramrods Vektor V2 Tungsten Damping",
    );
    expect(exact).toBeGreaterThan(tungsten);
  });

  it("recherche aussi un produit sans son année commerciale", () => {
    const product = {
      title: "PSE Lazer X – 2026",
      vendor: "PSE",
      sku: null,
    };
    expect(buildSearchQueries(product)).toContain("PSE Lazer X");
    expect(
      scoreProductCandidate(
        product,
        "https://example.com/arcs/pse-lazer-x",
        "PSE Lazer X",
      ),
    ).toBeGreaterThanOrEqual(0.72);
  });

  it("rejette une année explicitement contradictoire", () => {
    const product = {
      title: "PSE Lazer X – 2026",
      vendor: "PSE",
      sku: null,
    };
    expect(
      scoreProductCandidate(
        product,
        "https://example.com/pse-lazer-x-2024",
        "PSE Lazer X 2024",
      ),
    ).toBe(0);
  });

  it("extrait les URLs XML et les sitemaps déclarés", () => {
    expect(
      extractSitemapLocations(
        "<urlset><url><loc>https://example.com/a</loc></url></urlset>",
      ),
    ).toEqual(["https://example.com/a"]);
    expect(
      sitemapUrlsFromRobots(
        "Sitemap: https://example.com/products.xml",
        "example.com",
      ),
    ).toContain("https://example.com/products.xml");
  });
});
