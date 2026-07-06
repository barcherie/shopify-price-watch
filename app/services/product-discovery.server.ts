import { randomInt } from "node:crypto";
import { load } from "cheerio";
import prisma from "../db.server";
import { fetchHtmlPage } from "./page-fetcher.server";
import { robotsAllowsPath } from "./robots.server";
import { validateTargetUrl } from "./url-safety.server";

const MAX_SITEMAP_REQUESTS = 12;
const MAX_CANDIDATE_URLS = 50_000;
const MINIMUM_SCORE = 0.72;
const MAX_CANDIDATES_TO_VERIFY = 3;
const STOP_WORDS = new Set([
  "avec",
  "chez",
  "dans",
  "des",
  "pour",
  "sur",
  "the",
  "une",
  "version",
]);

type ProductIdentity = {
  title: string;
  vendor: string | null;
  sku: string | null;
};

export type DiscoveryResult = {
  competitorId: string;
  competitorName: string;
  status: "FOUND" | "NOT_FOUND" | "ERROR" | "ALREADY_EXISTS";
  url?: string;
  message?: string;
};

function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isSignificantToken(token: string) {
  return (
    token === "x" ||
    token.length > 2 ||
    (token.length >= 2 && /\d/.test(token))
  );
}

function identityTokens(product: ProductIdentity) {
  return Array.from(
    new Set(
      normalize(`${product.vendor || ""} ${product.title}`)
        .split(" ")
        .filter(
          (token) =>
            isSignificantToken(token) &&
            !STOP_WORDS.has(token) &&
            !/^20\d{2}$/.test(token),
        ),
    ),
  );
}

export function buildSearchQueries(product: ProductIdentity) {
  const title = product.title.replace(/[–—]/g, " ").replace(/\s+/g, " ").trim();
  const withoutYear = title
    .replace(/\b20\d{2}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const normalizedVendor = normalize(product.vendor || "");
  const withoutVendor = withoutYear
    .split(" ")
    .filter((token) => normalize(token) !== normalizedVendor)
    .join(" ")
    .trim();
  const queries = [
    product.sku?.trim(),
    title,
    withoutYear,
    product.vendor && withoutVendor
      ? `${product.vendor} ${withoutVendor}`
      : null,
    withoutVendor,
  ].filter((query): query is string => Boolean(query && query.length >= 2));

  const seen = new Set<string>();
  return queries.filter((query) => {
    const key = normalize(query);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function scoreProductCandidate(
  product: ProductIdentity,
  candidateUrl: string,
  candidateLabel = "",
) {
  const pathname = decodeURIComponent(new URL(candidateUrl).pathname);
  const candidate = normalize(candidateLabel || pathname);
  const expectedYears: string[] =
    normalize(product.title).match(/\b20\d{2}\b/g) || [];
  const candidateYears: string[] = candidate.match(/\b20\d{2}\b/g) || [];
  if (
    expectedYears.length &&
    candidateYears.length &&
    !candidateYears.some((year) => expectedYears.includes(year))
  ) {
    return 0;
  }
  const normalizedSku = normalize(product.sku || "").replace(/\s/g, "");
  if (
    normalizedSku.length >= 3 &&
    candidate.replace(/\s/g, "").includes(normalizedSku)
  ) {
    return 1;
  }

  const tokens = identityTokens(product);
  if (!tokens.length) return 0;
  const matched = tokens.filter((token) => candidate.includes(token)).length;
  if (matched < Math.min(2, tokens.length)) return 0;
  const candidateTokens = new Set(
    candidate.split(" ").filter(isSignificantToken),
  );
  const coverage = matched / tokens.length;
  const precision = matched / Math.max(1, candidateTokens.size);
  return coverage * 0.8 + precision * 0.2;
}

export function extractSitemapLocations(xml: string) {
  const $ = load(xml, { xmlMode: true });
  return $("loc")
    .map((_, element) => $(element).text().trim())
    .get()
    .filter(Boolean);
}

export function isSearchResultsUrl(candidateUrl: string, sourceUrl?: string) {
  const candidate = new URL(candidateUrl);
  if (
    sourceUrl &&
    candidate.pathname.replace(/\/+$/, "") ===
      new URL(sourceUrl).pathname.replace(/\/+$/, "")
  ) {
    return true;
  }

  return candidate.pathname
    .split("/")
    .filter(Boolean)
    .some(
      (segment) =>
        segment.toLowerCase() === "recherche" ||
        segment.toLowerCase().includes("search"),
    );
}

function jsonLdContainsProduct(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(jsonLdContainsProduct);
  if (!value || typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  const types = Array.isArray(record["@type"])
    ? record["@type"]
    : [record["@type"]];
  if (
    types.some(
      (type) => typeof type === "string" && type.toLowerCase() === "product",
    )
  ) {
    return true;
  }
  return jsonLdContainsProduct(record["@graph"]);
}

export function verifiedProductUrl(
  html: string,
  candidateUrl: string,
  domain: string,
) {
  const $ = load(html);
  let hasProductJsonLd = false;
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      if (jsonLdContainsProduct(JSON.parse($(element).text()))) {
        hasProductJsonLd = true;
      }
    } catch {
      // Ignore malformed third-party structured data.
    }
  });
  const hasProductMetadata =
    $('meta[property="og:type"][content="product" i]').length > 0 ||
    $('meta[property^="product:"]').length > 0 ||
    $('[itemtype*="schema.org/Product" i]').length > 0;
  if (!hasProductJsonLd && !hasProductMetadata) return null;

  const canonicalHref = $('link[rel="canonical"]').attr("href");
  const canonical = validateTargetUrl(
    canonicalHref
      ? new URL(canonicalHref, candidateUrl).toString()
      : candidateUrl,
    domain,
  );
  if (isSearchResultsUrl(canonical.toString())) return null;
  canonical.search = "";
  canonical.hash = "";
  return canonical.toString();
}

export function sitemapUrlsFromRobots(
  robotsContent: string | null,
  domain: string,
) {
  const urls =
    robotsContent
      ?.split(/\r?\n/)
      .map((line) => line.match(/^\s*sitemap\s*:\s*(\S+)/i)?.[1])
      .filter((url): url is string => Boolean(url)) || [];
  return Array.from(
    new Set([
      ...urls,
      `https://${domain}/sitemap.xml`,
      `https://${domain}/1_index_sitemap.xml`,
    ]),
  );
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function discoverOnCompetitor(
  product: ProductIdentity,
  competitor: {
    domain: string;
    robotsContent: string | null;
    robotsOverrideConfirmed: boolean;
    searchUrlTemplate: string | null;
  },
  politeFetch: (url: string, domain: string) => Promise<string>,
) {
  async function verifyCandidates(
    candidates: Array<{ url: string; score: number }>,
    source: string,
  ) {
    const uniqueCandidates = Array.from(
      candidates
        .reduce((byUrl, candidate) => {
          const previous = byUrl.get(candidate.url);
          if (!previous || candidate.score > previous.score) {
            byUrl.set(candidate.url, candidate);
          }
          return byUrl;
        }, new Map<string, { url: string; score: number }>())
        .values(),
    )
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CANDIDATES_TO_VERIFY);

    for (const candidate of uniqueCandidates) {
      try {
        const html = await politeFetch(candidate.url, competitor.domain);
        const url = verifiedProductUrl(
          html,
          candidate.url,
          competitor.domain,
        );
        if (url) return { ...candidate, url, source };
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "Erreur inconnue.");
      }
    }
    return null;
  }

  const queryVariants = buildSearchQueries(product);
  const searchTemplates = Array.from(
    new Set(
      [
        competitor.searchUrlTemplate,
        `https://${competitor.domain}/recherche?s={query}`,
        `https://${competitor.domain}/search?q={query}&type=product`,
        `https://${competitor.domain}/catalogsearch/result/?q={query}`,
      ].filter((template): template is string => Boolean(template)),
    ),
  ).slice(0, competitor.searchUrlTemplate ? 1 : 3);
  const searchAttempts = competitor.searchUrlTemplate
    ? queryVariants.slice(0, 4).map((query) => ({
        template: competitor.searchUrlTemplate as string,
        query,
      }))
    : searchTemplates.map((template) => ({
        template,
        query:
          queryVariants.find(
            (query) =>
              normalize(query) !== normalize(product.sku || "") &&
              !/\b20\d{2}\b/.test(query),
          ) || product.title,
      }));
  const errors: string[] = [];
  let successfulSource = false;

  for (const { template, query } of searchAttempts) {
    try {
      const searchUrl = validateTargetUrl(
        template.replace("{query}", encodeURIComponent(query)),
        competitor.domain,
      );
      const searchAllowed =
        robotsAllowsPath(
          competitor.robotsContent,
          `${searchUrl.pathname}${searchUrl.search}`,
        ) || competitor.robotsOverrideConfirmed;
      if (!searchAllowed) {
        errors.push(`Recherche interdite par robots.txt : ${searchUrl.pathname}`);
        continue;
      }

      const html = await politeFetch(searchUrl.toString(), competitor.domain);
      successfulSource = true;
      const $ = load(html);
      const searchCandidates = $("a[href]")
        .map((_, element) => {
          const href = $(element).attr("href");
          if (!href) return null;
          try {
            const target = validateTargetUrl(
              new URL(href, searchUrl).toString(),
              competitor.domain,
            );
            if (isSearchResultsUrl(target.toString(), searchUrl.toString())) {
              return null;
            }
            const targetAllowed =
              robotsAllowsPath(
                competitor.robotsContent,
                `${target.pathname}${target.search}`,
              ) || competitor.robotsOverrideConfirmed;
            if (!targetAllowed) return null;
            const url = target.toString();
            return {
              url,
              score: scoreProductCandidate(
                product,
                url,
                $(element).text(),
              ),
            };
          } catch {
            return null;
          }
        })
        .get()
        .filter(
          (candidate): candidate is { url: string; score: number } =>
            Boolean(candidate) && candidate.score >= MINIMUM_SCORE,
        )
        .sort((a, b) => b.score - a.score);
      const verifiedCandidate = await verifyCandidates(
        searchCandidates,
        "recherche publique",
      );
      if (verifiedCandidate) return verifiedCandidate;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Erreur inconnue.");
      // Continue with another public search URL, then with sitemaps.
    }
  }

  const queue = sitemapUrlsFromRobots(
    competitor.robotsContent,
    competitor.domain,
  );
  const seen = new Set<string>();
  const candidates: string[] = [];
  let requests = 0;

  while (
    queue.length &&
    requests < MAX_SITEMAP_REQUESTS &&
    candidates.length < MAX_CANDIDATE_URLS
  ) {
    const sitemapUrl = queue.shift();
    if (!sitemapUrl || seen.has(sitemapUrl) || sitemapUrl.endsWith(".gz")) {
      continue;
    }
    seen.add(sitemapUrl);
    requests += 1;

    let xml: string;
    try {
      xml = await politeFetch(sitemapUrl, competitor.domain);
      successfulSource = true;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Erreur inconnue.");
      continue;
    }
    const locations = extractSitemapLocations(xml);
    const childSitemaps = locations.filter(
      (url) =>
        /\.xml(?:\?|$)/i.test(url) || url.toLowerCase().includes("sitemap"),
    );
    if (childSitemaps.length) {
      childSitemaps
        .sort((a, b) => {
          const aProduct = /product|produit/i.test(a) ? 0 : 1;
          const bProduct = /product|produit/i.test(b) ? 0 : 1;
          return aProduct - bProduct;
        })
        .forEach((url) => {
          try {
            queue.push(
              validateTargetUrl(url, competitor.domain).toString(),
            );
          } catch {
            // Ignore cross-domain or malformed sitemap entries.
          }
        });
      continue;
    }

    for (const location of locations) {
      try {
        const target = validateTargetUrl(location, competitor.domain);
        const allowed =
          robotsAllowsPath(
            competitor.robotsContent,
            `${target.pathname}${target.search}`,
          ) || competitor.robotsOverrideConfirmed;
        if (allowed) candidates.push(target.toString());
      } catch {
        // Ignore unsafe or unrelated URLs.
      }
    }
  }

  const sitemapCandidates = candidates
    .map((url) => ({ url, score: scoreProductCandidate(product, url) }))
    .filter((candidate) => candidate.score >= MINIMUM_SCORE)
    .sort((a, b) => b.score - a.score);
  const sitemapCandidate = await verifyCandidates(
    sitemapCandidates,
    "sitemap",
  );
  if (sitemapCandidate) return sitemapCandidate;
  if (!successfulSource && errors.length) {
    throw new Error(Array.from(new Set(errors)).slice(0, 2).join(" · "));
  }
  return null;
}

async function politeFetch(url: string, domain: string) {
  await wait(randomInt(2_000, 5_001));
  const page = await fetchHtmlPage(url, domain);
  if (page.status < 200 || page.status >= 300) {
    throw new Error(`HTTP ${page.status}`);
  }
  if (/challenges\.cloudflare\.com|<title>\s*just a moment/i.test(page.html)) {
    throw new Error(
      "Protection anti-bot détectée : recherche automatique non autorisée.",
    );
  }
  return page.html;
}

export async function discoverProductMatch(
  productId: string,
  competitorId: string,
): Promise<DiscoveryResult> {
  const [product, competitor, existing] = await Promise.all([
    prisma.shopifyProduct.findUnique({ where: { id: productId } }),
    prisma.competitor.findUnique({ where: { id: competitorId } }),
    prisma.productMatch.findFirst({ where: { productId, competitorId } }),
  ]);
  if (!product || product.status === "DELETED") {
    throw new Error("Produit introuvable dans Price Watch.");
  }
  if (!competitor || !competitor.active || competitor.legalStatus !== "APPROVED") {
    throw new Error("Concurrent inactif ou non approuvé.");
  }
  if (existing) {
    return {
      competitorId: competitor.id,
      competitorName: competitor.name,
      status: "ALREADY_EXISTS",
    };
  }

  try {
    const candidate = await discoverOnCompetitor(
      {
        title: product.title,
        vendor: product.vendor,
        sku: product.firstVariantSku,
      },
      competitor,
      politeFetch,
    );
    if (!candidate) {
      return {
        competitorId: competitor.id,
        competitorName: competitor.name,
        status: "NOT_FOUND",
        message: "Recherche accessible, mais aucun candidat suffisamment proche.",
      };
    }
    await prisma.productMatch.create({
      data: {
        productId: product.id,
        competitorId: competitor.id,
        url: candidate.url,
        status: "PENDING",
      },
    });
    return {
      competitorId: competitor.id,
      competitorName: competitor.name,
      status: "FOUND",
      url: candidate.url,
      message: `${candidate.source}, score ${Math.round(candidate.score * 100)} %.`,
    };
  } catch (error) {
    return {
      competitorId: competitor.id,
      competitorName: competitor.name,
      status: "ERROR",
      message: error instanceof Error ? error.message : "Erreur inconnue.",
    };
  }
}

export async function discoverProductMatches(productId: string) {
  const competitors = await prisma.competitor.findMany({
    where: { active: true, legalStatus: "APPROVED" },
    orderBy: { name: "asc" },
  });
  const results: DiscoveryResult[] = [];
  for (const competitor of competitors) {
    results.push(await discoverProductMatch(productId, competitor.id));
  }
  return results;
}
