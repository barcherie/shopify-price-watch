import { describe, expect, it } from "vitest";
import {
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
