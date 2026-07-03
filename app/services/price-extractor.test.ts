import { describe, expect, it } from "vitest";
import { extractPriceFromHtml, normalizePrice } from "./price-extractor.server";

describe("normalizePrice", () => {
  it.each([
    ["315,00 €", "315.00"],
    ["1 299,95 €", "1299.95"],
    ["1.299,95 EUR", "1299.95"],
    ["1299.95", "1299.95"],
    [315, "315.00"],
  ])("normalise %s", (input, expected) => {
    expect(normalizePrice(input)).toBe(expected);
  });
});

describe("extractPriceFromHtml", () => {
  it("prioritises JSON-LD Product offers", () => {
    const html = `
      <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "Product",
          "name": "Arc",
          "offers": {
            "@type": "Offer",
            "price": "149.90",
            "priceCurrency": "EUR",
            "availability": "https://schema.org/InStock"
          }
        }
      </script>
      <span class="price">999,00 €</span>
    `;
    expect(extractPriceFromHtml(html)).toEqual({
      price: "149.90",
      currencyCode: "EUR",
      availability: "InStock",
      method: "JSON_LD",
    });
  });

  it("reads scoped schema.org microdata before related product prices", () => {
    const html = `
      <div class="product-price" itemprop="offers">
        <meta itemprop="priceCurrency" content="EUR">
        <link itemprop="availability" href="https://schema.org/InStock">
        <span itemprop="price" content="315">315,00 €</span>
      </div>
      <article><span itemprop="price" content="55">55,00 €</span></article>
    `;
    expect(extractPriceFromHtml(html)).toMatchObject({
      price: "315.00",
      currencyCode: "EUR",
      availability: "InStock",
      method: "META",
    });
  });

  it("uses a configured CSS selector", () => {
    const html = `
      <div id="main-product"><strong class="our-price">89,50 €</strong></div>
      <div class="stock">Disponible</div>
      <aside>12,00 €</aside>
    `;
    expect(
      extractPriceFromHtml(html, {
        priceSelector: "#main-product .our-price",
        availabilitySelector: ".stock",
      }),
    ).toEqual({
      price: "89.50",
      currencyCode: "EUR",
      availability: "Disponible",
      method: "CSS",
    });
  });

  it("rejects ambiguous fallback prices", () => {
    expect(
      extractPriceFromHtml("<body>Produit 10,00 € — accessoire 5,00 €</body>"),
    ).toBeNull();
  });
});
