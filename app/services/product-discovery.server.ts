import { randomInt } from "node:crypto";
import { load } from "cheerio";
import prisma from "../db.server";
import { fetchHtmlPage } from "./page-fetcher.server";
import { robotsAllowsPath } from "./robots.server";
import { validateTargetUrl } from "./url-safety.server";

const MAX_SITEMAP_REQUESTS = 12;
const MAX_CANDIDATE_URLS = 50_000;
const MINIMUM_SCORE = 0.72;
const MAX_CANDIDATES_TO_VERIFY = 8;
const DISCOVERY_CONCURRENCY = 4;
const STOP_WORDS = new Set([
  "archery",
  "avec",
  "chez",
  "classique",
  "classiques",
  "dans",
  "des",
  "pour",
  "product",
  "products",
  "produit",
  "produits",
  "star",
  "sur",
  "the",
  "une",
  "version",
  "xml",
]);
const PRODUCT_TYPE_TOKENS = new Set([
  "arc",
  "arcs",
  "branch",
  "branches",
  "central",
  "compound",
  "grip",
  "limb",
  "limbs",
  "poignee",
  "poignees",
  "recurve",
  "stabilisateur",
  "stabilisation",
  "viseur",
]);
const MATERIAL_OR_VARIANT_TOKENS = new Set([
  "aluminium",
  "bois",
  "carbon",
  "carbone",
  "core",
  "cross",
  "foam",
  "formula",
  "grand",
  "ilf",
  "laminate",
  "mousse",
  "prix",
  "syntactic",
  "syntatic",
  "wood",
]);

type ProductIdentity = {
  title: string;
  vendor: string | null;
  sku: string | null;
  searchQuery?: string | null;
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

function isIgnoredDiscoveryToken(token: string) {
  return (
    STOP_WORDS.has(token) ||
    /^20\d{2}$/.test(token) ||
    (/^\d+$/.test(token) && token.length >= 3)
  );
}

function semanticTokens(value: string) {
  const normalized = normalize(value);
  const hasGrandPrix = /\bgrand prix\b/.test(normalized);
  const mapped = normalized
    .split(" ")
    .filter(
      (token) =>
        !(hasGrandPrix && (token === "grand" || token === "prix")),
    )
    .map((token) => {
      if (["branche", "branches", "limb", "limbs"].includes(token)) {
        return "branch";
      }
      if (token === "mousse") return "foam";
      if (["bois", "laminate"].includes(token)) return "wood";
      if (token === "syntatic") return "syntactic";
      return token;
    })
    .flatMap((token) => {
      if (/^[a-z]{2,4}x$/.test(token)) {
        return [token, token.slice(0, -1), "x"];
      }
      return [token];
    });
  if (hasGrandPrix) mapped.push("ilf");
  return mapped;
}

function compactModelAliases(tokens: string[]) {
  const aliases: string[] = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (/^[a-z]{2,4}$/.test(tokens[index]) && tokens[index + 1] === "x") {
      aliases.push(`${tokens[index]}x`);
    }
  }
  return aliases;
}

function modelTokens(product: ProductIdentity) {
  const normalizedVendor = normalize(product.vendor || "");
  const semanticTitleTokens = semanticTokens(product.title);
  return Array.from(
    new Set(
      [...semanticTitleTokens, ...compactModelAliases(semanticTitleTokens)].filter(
        (token) => {
          if (!isSignificantToken(token) || isIgnoredDiscoveryToken(token)) {
            return false;
          }
          if (normalizedVendor && token === normalizedVendor) return false;
          return (
            !PRODUCT_TYPE_TOKENS.has(token) &&
            !MATERIAL_OR_VARIANT_TOKENS.has(token)
          );
        },
      ),
    ),
  );
}

function identityTokens(product: ProductIdentity) {
  return Array.from(
    new Set(
      semanticTokens(`${product.vendor || ""} ${product.title}`).filter(
        (token) =>
          isSignificantToken(token) &&
          !isIgnoredDiscoveryToken(token),
      ),
    ),
  );
}

function compactTokensToQuery(tokens: string[]) {
  return tokens
    .filter((token) => {
      if (token === "x" && tokens.length > 3) return false;
      if (
        /^[a-z]{2,4}x$/.test(token) &&
        tokens.includes(token.slice(0, -1)) &&
        tokens.includes("x")
      ) {
        return false;
      }
      return true;
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildSearchQueries(product: ProductIdentity) {
  const manualQuery = product.searchQuery?.trim();
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
  const modelQuery = compactTokensToQuery(modelTokens(product));
  const vendorModelQuery =
    product.vendor && modelQuery ? `${product.vendor} ${modelQuery}` : null;
  const queries = [
    manualQuery,
    product.sku?.trim(),
    vendorModelQuery,
    modelQuery,
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

function tokenWeight(token: string) {
  if (PRODUCT_TYPE_TOKENS.has(token)) return 0.35;
  if (MATERIAL_OR_VARIANT_TOKENS.has(token)) return 0.65;
  if (token === "x") return 0.45;
  if (/\d/.test(token)) return 1.25;
  return 1;
}

function weightedCoverage(tokens: string[], candidateTokens: Set<string>) {
  const total = tokens.reduce((sum, token) => sum + tokenWeight(token), 0);
  if (total <= 0) return 0;
  const matched = tokens
    .filter((token) => candidateTokens.has(token))
    .reduce((sum, token) => sum + tokenWeight(token), 0);
  return matched / total;
}

export function scoreProductCandidate(
  product: ProductIdentity,
  candidateUrl: string,
  candidateLabel = "",
) {
  const pathname = decodeURIComponent(new URL(candidateUrl).pathname);
  const expected = normalize(`${product.vendor || ""} ${product.title}`);
  const candidate = normalize(`${candidateLabel} ${pathname}`);
  const expectedKit = /\bkit\b/.test(expected);
  const candidateKit = /\bkit\b/.test(candidate);
  if (!expectedKit && candidateKit) return 0;

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

  const expectedIlf = /\bilf\b|\bgrand prix\b/.test(expected);
  const expectedFormula = /\bformula\b/.test(expected);
  const candidateIlf = /\bilf\b|\bgrand prix\b/.test(candidate);
  const candidateFormula = /\bformula\b/.test(candidate);
  if (expectedIlf && candidateFormula && !candidateIlf) return 0;
  if (expectedFormula && candidateIlf && !candidateFormula) return 0;

  const expectedFoam = /\bfoam\b|\bmousse\b/.test(expected);
  const expectedWood = /\bwood\b|\bbois\b|\blaminate\b/.test(expected);
  const candidateFoam = /\bfoam\b|\bmousse\b/.test(candidate);
  const candidateWood = /\bwood\b|\bbois\b|\blaminate\b/.test(candidate);
  if (expectedFoam && candidateWood && !candidateFoam) return 0;
  if (expectedWood && candidateFoam && !candidateWood) return 0;

  const normalizedSku = normalize(product.sku || "").replace(/\s/g, "");
  if (
    normalizedSku.length >= 3 &&
    candidate.replace(/\s/g, "").includes(normalizedSku)
  ) {
    return 1;
  }

  const tokens = identityTokens(product);
  if (!tokens.length) return 0;
  const candidateTokens = new Set(
    semanticTokens(candidate).filter(
      (token) =>
        isSignificantToken(token) &&
        !isIgnoredDiscoveryToken(token),
    ),
  );
  const matched = tokens.filter((token) => candidateTokens.has(token)).length;
  if (matched < Math.min(2, tokens.length)) return 0;
  const importantModelTokens = modelTokens(product);
  const matchedModelTokens = importantModelTokens.filter((token) =>
    candidateTokens.has(token),
  );
  if (
    importantModelTokens.length >= 2 &&
    matchedModelTokens.length < Math.ceil(importantModelTokens.length * 0.6)
  ) {
    return 0;
  }
  if (importantModelTokens.length === 1 && matchedModelTokens.length === 0) {
    return 0;
  }

  const coverage = weightedCoverage(tokens, candidateTokens);
  const modelCoverage = importantModelTokens.length
    ? weightedCoverage(importantModelTokens, candidateTokens)
    : coverage;
  const precision = matched / Math.max(1, candidateTokens.size);
  const vendorToken = normalize(product.vendor || "");
  const vendorMatched = vendorToken ? candidateTokens.has(vendorToken) : false;
  const strongModelMatch = modelCoverage >= 0.95;
  const compactAliasMatched = importantModelTokens.some(
    (token) => /^[a-z]{2,4}x$/.test(token) && candidateTokens.has(token),
  );
  const brandModelBonus = strongModelMatch && vendorMatched ? 0.13 : 0;
  const score =
    coverage * 0.55 + modelCoverage * 0.35 + precision * 0.1 + brandModelBonus;
  if (vendorMatched && compactAliasMatched) {
    return Math.max(score, 0.78);
  }
  if (score <= 1) return score;

  const extraTokens = Array.from(candidateTokens).filter(
    (token) => !tokens.includes(token),
  ).length;
  return Math.max(0, 1 - Math.min(0.08, extraTokens * 0.01));
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
      const candidateLabel = (element: Parameters<typeof $>[0]) => {
        const linkText = $(element).text();
        const cardText = $(element)
          .closest(
            [
              "article",
              ".product-miniature",
              ".product-card",
              ".product-item",
              ".product",
              ".card",
              "li",
            ].join(","),
          )
          .text();
        return `${linkText} ${cardText}`.slice(0, 2_000);
      };
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
                candidateLabel(element),
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
  searchQuery?: string | null,
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
  const existingIsSearchPage =
    existing && isSearchResultsUrl(existing.url);
  if (existing && !existingIsSearchPage) {
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
        searchQuery,
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
    if (existingIsSearchPage) {
      await prisma.productMatch.update({
        where: { id: existing.id },
        data: {
          url: candidate.url,
          searchQuery: searchQuery?.trim() || existing.searchQuery,
          status: "PENDING",
          lastScrapedAt: null,
        },
      });
    } else {
      await prisma.productMatch.create({
        data: {
          productId: product.id,
          competitorId: competitor.id,
          url: candidate.url,
          searchQuery: searchQuery?.trim() || null,
          status: "PENDING",
        },
      });
    }
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

export async function discoverProductMatches(
  productId: string,
  searchQuery?: string | null,
) {
  const competitors = await prisma.competitor.findMany({
    where: { active: true, legalStatus: "APPROVED" },
    orderBy: { name: "asc" },
  });
  const results: DiscoveryResult[] = [];
  for (let index = 0; index < competitors.length; index += DISCOVERY_CONCURRENCY) {
    const chunk = competitors.slice(index, index + DISCOVERY_CONCURRENCY);
    results.push(
      ...(await Promise.all(
        chunk.map((competitor) =>
          discoverProductMatch(productId, competitor.id, searchQuery),
        ),
      )),
    );
  }
  return results;
}
