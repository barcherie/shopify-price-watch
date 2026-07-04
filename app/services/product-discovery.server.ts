import { randomInt } from "node:crypto";
import { load } from "cheerio";
import prisma from "../db.server";
import { fetchHtmlPage } from "./page-fetcher.server";
import { robotsAllowsPath } from "./robots.server";
import { validateTargetUrl } from "./url-safety.server";

const MAX_SITEMAP_REQUESTS = 3;
const MAX_CANDIDATE_URLS = 50_000;
const MINIMUM_SCORE = 0.5;
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

function identityTokens(product: ProductIdentity) {
  return Array.from(
    new Set(
      normalize(`${product.vendor || ""} ${product.title}`)
        .split(" ")
        .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
    ),
  );
}

export function scoreProductCandidate(
  product: ProductIdentity,
  candidateUrl: string,
  candidateLabel = "",
) {
  const pathname = decodeURIComponent(new URL(candidateUrl).pathname);
  const candidate = normalize(candidateLabel || pathname);
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
    candidate.split(" ").filter((token) => token.length > 2),
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
  const encodedQuery = encodeURIComponent(
    `${product.vendor || ""} ${product.title}`.trim(),
  );
  const searchTemplates = Array.from(
    new Set(
      [
        competitor.searchUrlTemplate,
        `https://${competitor.domain}/recherche?s={query}`,
        `https://${competitor.domain}/search?q={query}&type=product`,
        `https://${competitor.domain}/catalogsearch/result/?q={query}`,
      ].filter((template): template is string => Boolean(template)),
    ),
  ).slice(0, competitor.searchUrlTemplate ? 2 : 3);

  for (const template of searchTemplates) {
    try {
      const searchUrl = validateTargetUrl(
        template.replace("{query}", encodedQuery),
        competitor.domain,
      );
      const searchAllowed =
        robotsAllowsPath(
          competitor.robotsContent,
          `${searchUrl.pathname}${searchUrl.search}`,
        ) || competitor.robotsOverrideConfirmed;
      if (!searchAllowed) continue;

      const html = await politeFetch(searchUrl.toString(), competitor.domain);
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
            if (
              /\/(?:recherche|search|catalogsearch)(?:\/|$)/i.test(
                target.pathname,
              )
            ) {
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
      if (searchCandidates[0]) return searchCandidates[0];
    } catch {
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
    } catch {
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

  return candidates
    .map((url) => ({ url, score: scoreProductCandidate(product, url) }))
    .filter((candidate) => candidate.score >= MINIMUM_SCORE)
    .sort((a, b) => b.score - a.score)[0];
}

export async function discoverProductMatches(productId: string) {
  const product = await prisma.shopifyProduct.findUnique({
    where: { id: productId },
    include: { matches: true },
  });
  if (!product || product.status === "DELETED") {
    throw new Error("Produit introuvable dans Price Watch.");
  }

  const competitors = await prisma.competitor.findMany({
    where: { active: true, legalStatus: "APPROVED" },
    orderBy: { name: "asc" },
  });
  const existingCompetitors = new Set(
    product.matches.map((match) => match.competitorId),
  );
  let hasFetched = false;
  const politeFetch = async (url: string, domain: string) => {
    if (hasFetched) await wait(randomInt(2_000, 5_001));
    hasFetched = true;
    const page = await fetchHtmlPage(url, domain);
    if (page.status < 200 || page.status >= 300) {
      throw new Error(`HTTP ${page.status}`);
    }
    return page.html;
  };

  const results: DiscoveryResult[] = [];
  for (const competitor of competitors) {
    if (existingCompetitors.has(competitor.id)) {
      results.push({
        competitorId: competitor.id,
        competitorName: competitor.name,
        status: "ALREADY_EXISTS",
      });
      continue;
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
        results.push({
          competitorId: competitor.id,
          competitorName: competitor.name,
          status: "NOT_FOUND",
          message: "Aucun candidat suffisamment proche dans les sitemaps.",
        });
        continue;
      }
      await prisma.productMatch.create({
        data: {
          productId: product.id,
          competitorId: competitor.id,
          url: candidate.url,
          status: "PENDING",
        },
      });
      results.push({
        competitorId: competitor.id,
        competitorName: competitor.name,
        status: "FOUND",
        url: candidate.url,
      });
    } catch (error) {
      results.push({
        competitorId: competitor.id,
        competitorName: competitor.name,
        status: "ERROR",
        message: error instanceof Error ? error.message : "Erreur inconnue.",
      });
    }
  }
  return results;
}
