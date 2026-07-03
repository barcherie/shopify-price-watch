import * as cheerio from "cheerio";
import type { PriceExtractionMethod } from "@prisma/client";
import type { AnyNode } from "domhandler";

export type ExtractedPrice = {
  price: string;
  currencyCode: string;
  availability: string | null;
  method: PriceExtractionMethod;
};

type ExtractOptions = {
  priceSelector?: string | null;
  availabilitySelector?: string | null;
};

export function normalizePrice(rawValue: unknown): string | null {
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    return rawValue.toFixed(2);
  }
  if (typeof rawValue !== "string") return null;

  let value = rawValue
    .replace(/\u00a0|\u202f/g, " ")
    .replace(/[^\d,.-]/g, "")
    .trim();
  if (!value || value === "-") return null;

  const comma = value.lastIndexOf(",");
  const dot = value.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimalSeparator = comma > dot ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    value = value.split(thousandsSeparator).join("");
    value = value.replace(decimalSeparator, ".");
  } else if (comma >= 0) {
    const decimals = value.length - comma - 1;
    value =
      decimals > 0 && decimals <= 2
        ? value.replace(",", ".")
        : value.replaceAll(",", "");
  } else if (dot >= 0) {
    const decimals = value.length - dot - 1;
    if (!(decimals > 0 && decimals <= 2)) value = value.replaceAll(".", "");
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 10_000_000)
    return null;
  return number.toFixed(2);
}

function readElementValue(element: cheerio.Cheerio<AnyNode>): string | null {
  return (
    element.attr("content") ||
    element.attr("data-price-amount") ||
    element.attr("data-price") ||
    element.attr("value") ||
    element.text() ||
    null
  );
}

function jsonLdObjects(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(jsonLdObjects);
  if (!value || typeof value !== "object") return [];

  const object = value as Record<string, unknown>;
  const graph = object["@graph"];
  return [object, ...(graph ? jsonLdObjects(graph) : [])];
}

function hasType(object: Record<string, unknown>, expected: string) {
  const type = object["@type"];
  return Array.isArray(type) ? type.includes(expected) : type === expected;
}

function offerCandidates(offers: unknown): Array<Record<string, unknown>> {
  return jsonLdObjects(offers).filter(
    (offer) =>
      hasType(offer, "Offer") ||
      hasType(offer, "AggregateOffer") ||
      "price" in offer ||
      "lowPrice" in offer,
  );
}

function currencyFromText(text: string) {
  if (/€|\bEUR\b/i.test(text)) return "EUR";
  if (/\$|\bUSD\b/i.test(text)) return "USD";
  if (/£|\bGBP\b/i.test(text)) return "GBP";
  return "EUR";
}

function extractJsonLd($: cheerio.CheerioAPI): ExtractedPrice | null {
  const scripts = $('script[type="application/ld+json"]').toArray();

  for (const script of scripts) {
    const text = $(script).text().trim();
    if (!text) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }

    const products = jsonLdObjects(parsed).filter((object) =>
      hasType(object, "Product"),
    );
    for (const product of products) {
      for (const offer of offerCandidates(product.offers)) {
        const price = normalizePrice(offer.price ?? offer.lowPrice);
        if (!price) continue;

        return {
          price,
          currencyCode:
            typeof offer.priceCurrency === "string"
              ? offer.priceCurrency.toUpperCase()
              : "EUR",
          availability:
            typeof offer.availability === "string"
              ? offer.availability.split("/").pop() || null
              : null,
          method: "JSON_LD",
        };
      }
    }
  }

  return null;
}

function extractMeta($: cheerio.CheerioAPI): ExtractedPrice | null {
  const selectors = [
    '[itemprop="offers"] [itemprop="price"]',
    'meta[property="product:price:amount"]',
    'meta[property="og:price:amount"]',
    'meta[name="product.price.amount"]',
  ];

  for (const selector of selectors) {
    const element = $(selector).first();
    if (!element.length) continue;
    const price = normalizePrice(readElementValue(element));
    if (!price) continue;

    const currencyElement = $(
      '[itemprop="offers"] [itemprop="priceCurrency"], meta[property="product:price:currency"], meta[property="og:price:currency"]',
    ).first();
    const availabilityElement = $(
      '[itemprop="offers"] [itemprop="availability"], meta[property="product:availability"]',
    ).first();

    return {
      price,
      currencyCode: (
        currencyElement.attr("content") ||
        currencyElement.text() ||
        "EUR"
      )
        .trim()
        .toUpperCase(),
      availability:
        availabilityElement.attr("href")?.split("/").pop() ||
        availabilityElement.attr("content") ||
        availabilityElement.text().trim() ||
        null,
      method: "META",
    };
  }

  return null;
}

function extractConfiguredCss(
  $: cheerio.CheerioAPI,
  options: ExtractOptions,
): ExtractedPrice | null {
  if (!options.priceSelector) return null;

  let element: cheerio.Cheerio<AnyNode>;
  try {
    element = $(options.priceSelector).first();
  } catch {
    return null;
  }
  if (!element.length) return null;

  const raw = readElementValue(element);
  const price = normalizePrice(raw);
  if (!price) return null;

  let availability: string | null = null;
  if (options.availabilitySelector) {
    try {
      availability =
        $(options.availabilitySelector).first().text().trim() || null;
    } catch {
      availability = null;
    }
  }

  return {
    price,
    currencyCode: currencyFromText(raw || ""),
    availability,
    method: "CSS",
  };
}

function extractFallback($: cheerio.CheerioAPI): ExtractedPrice | null {
  $("script, style, noscript, svg").remove();
  const text = $("body").text().replace(/\s+/g, " ");
  const matches = Array.from(
    text.matchAll(
      /(?:EUR\s*)?(\d{1,7}(?:[ .,\u00a0]\d{3})*(?:[,.]\d{1,2})?)\s*(?:€|\bEUR\b)/gi,
    ),
  );
  const prices = Array.from(
    new Set(matches.map((match) => normalizePrice(match[1])).filter(Boolean)),
  ) as string[];

  if (prices.length !== 1) return null;
  return {
    price: prices[0],
    currencyCode: "EUR",
    availability: null,
    method: "FALLBACK",
  };
}

export function extractPriceFromHtml(
  html: string,
  options: ExtractOptions = {},
): ExtractedPrice | null {
  const $ = cheerio.load(html);
  return (
    extractJsonLd($) ||
    extractMeta($) ||
    extractConfiguredCss($, options) ||
    extractFallback($)
  );
}
