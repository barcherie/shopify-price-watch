import { describe, expect, it } from "vitest";
import {
  buildSearchQueries,
  extractSitemapLocations,
  isSearchResultsUrl,
  scoreProductCandidate,
  sitemapUrlsFromRobots,
  verifiedProductUrl,
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

  it("comprend que Grand Prix et ILF désignent le même montage", () => {
    const product = {
      title: "Branches Hoyt Metrix Grand prix ILF",
      vendor: "Hoyt",
      sku: null,
    };
    const candidates = [
      [
        "https://example.com/branches-formula-ou-grand-prix-metrix-foam-hoyt-archery",
        "Branches Formula ou grand prix Metrix Foam - HOYT Archery",
      ],
      [
        "https://example.com/hoyt-branches-metrix-ilf-syntactic-foam",
        "HOYT - Branches METRIX ILF Syntactic Foam",
      ],
      [
        "https://example.com/branches-hoyt-grand-prix-ilf-carbon-metrix-syntactic-foam-core-2026",
        "Branches Hoyt Grand Prix ILF Carbon Metrix Syntactic Foam Core 2026",
      ],
      [
        "https://example.com/products/branche-hoyt-syntactic-foam-metrix",
        "Branche Hoyt Syntactic Foam Metrix",
      ],
      [
        "https://example.com/hoyt-limbs-grand-prix-syntactic-foam-metrix",
        "Hoyt Limbs Grand Prix Syntactic Foam Metrix",
      ],
      [
        "https://example.com/branches-classiques/hoyt-metrix",
        "Hoyt Metrix branches classique",
      ],
      [
        "https://example.com/branches-hoyt-grand-prix-metrix-syntatic-foam-core-2026",
        "Branches HOYT Grand Prix Metrix Syntatic Foam Core - 2026",
      ],
    ];

    for (const [url, label] of candidates) {
      expect(scoreProductCandidate(product, url, label)).toBeGreaterThanOrEqual(
        0.72,
      );
    }
  });

  it("rejette une version Formula lorsque le produit demandé est ILF", () => {
    expect(
      scoreProductCandidate(
        {
          title: "Branches Hoyt Metrix Grand prix ILF",
          vendor: "Hoyt",
          sku: null,
        },
        "https://example.com/hoyt-branches-metrix-formula-foam",
        "Hoyt Branches Metrix Formula Foam",
      ),
    ).toBe(0);
  });

  it("rejette un cœur bois lorsque le produit demandé est mousse", () => {
    expect(
      scoreProductCandidate(
        {
          title: "Branches Hoyt Metrix ILF Syntactic Foam",
          vendor: "Hoyt",
          sku: null,
        },
        "https://example.com/hoyt-limbs-grand-prix-laminate-core-metrix",
        "Hoyt Limbs Grand Prix Laminate Core Metrix",
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

  it("ne confond jamais une recherche Diane avec une fiche produit", () => {
    expect(
      isSearchResultsUrl(
        "https://dianearcherie.com/jolisearch?s=120254-1468",
      ),
    ).toBe(true);
    expect(
      isSearchResultsUrl(
        "https://dianearcherie.com/123-stabilisateur-central.html",
      ),
    ).toBe(false);
  });

  it("reconnaît et nettoie l'URL canonique d'une fiche Shopify", () => {
    expect(
      verifiedProductUrl(
        `
          <html>
            <head>
              <meta property="og:type" content="product">
              <link rel="canonical" href="/products/compound-pse-lazer-nf?variant=1">
            </head>
          </html>
        `,
        "https://donutarchery.com/products/compound-pse-lazer-nf?_pos=1",
        "donutarchery.com",
      ),
    ).toBe("https://donutarchery.com/products/compound-pse-lazer-nf");
  });

  it("rejette une page de recherche même si elle contient des métadonnées produit", () => {
    expect(
      verifiedProductUrl(
        '<meta property="product:price:amount" content="999">',
        "https://donutarchery.com/search?q=PSE",
        "donutarchery.com",
      ),
    ).toBeNull();
  });
});
