import { chromium } from "playwright-core";
import { assertPublicResolution, validateTargetUrl } from "./url-safety.server";

const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_REDIRECTS = 4;
const REQUEST_TIMEOUT_MS = 15_000;

export type FetchedPage = {
  html: string;
  status: number;
  finalUrl: string;
};

export function scraperUserAgent() {
  const email = process.env.SCRAPER_CONTACT_EMAIL?.trim();
  if (!email) {
    throw new Error(
      "SCRAPER_CONTACT_EMAIL doit être configuré avant tout relevé.",
    );
  }
  return `BesanconArcheriePriceWatch/1.0 (+mailto:${email})`;
}

async function readLimitedBody(response: Response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let html = "";

  let done = false;
  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    if (done) break;
    const { value } = chunk;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("La page dépasse la taille maximale autorisée.");
    }
    html += decoder.decode(value, { stream: true });
  }
  html += decoder.decode();
  return html;
}

export async function fetchHtmlPage(
  rawUrl: string,
  allowedDomain: string,
): Promise<FetchedPage> {
  let url = validateTargetUrl(rawUrl, allowedDomain);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await assertPublicResolution(url);
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "user-agent": scraperUserAgent(),
        accept: "text/html,application/xhtml+xml",
        "accept-language": "fr-FR,fr;q=0.9,en;q=0.5",
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirection sans destination.");
      url = validateTargetUrl(new URL(location, url).toString(), allowedDomain);
      continue;
    }

    return {
      html: await readLimitedBody(response),
      status: response.status,
      finalUrl: url.toString(),
    };
  }

  throw new Error("Trop de redirections.");
}

export async function fetchRenderedPage(
  rawUrl: string,
  allowedDomain: string,
): Promise<FetchedPage> {
  const target = validateTargetUrl(rawUrl, allowedDomain);
  await assertPublicResolution(target);

  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
  if (!executablePath) {
    throw new Error(
      "CHROMIUM_EXECUTABLE_PATH est requis pour les concurrents dynamiques.",
    );
  }

  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--disable-dev-shm-usage"],
  });

  try {
    const context = await browser.newContext({ userAgent: scraperUserAgent() });
    const page = await context.newPage();
    const checkedHosts = new Map<string, Promise<void>>();

    await page.route("**/*", async (route) => {
      try {
        const requestUrl = validateTargetUrl(route.request().url());
        let check = checkedHosts.get(requestUrl.hostname);
        if (!check) {
          check = assertPublicResolution(requestUrl);
          checkedHosts.set(requestUrl.hostname, check);
        }
        await check;
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });

    const response = await page.goto(target.toString(), {
      waitUntil: "domcontentloaded",
      timeout: REQUEST_TIMEOUT_MS,
    });
    await page
      .waitForLoadState("networkidle", { timeout: 3_000 })
      .catch(() => undefined);

    const finalUrl = validateTargetUrl(page.url(), allowedDomain);
    await assertPublicResolution(finalUrl);
    const html = await page.content();
    if (Buffer.byteLength(html) > MAX_RESPONSE_BYTES) {
      throw new Error("La page rendue dépasse la taille maximale autorisée.");
    }

    return {
      html,
      status: response?.status() || 200,
      finalUrl: finalUrl.toString(),
    };
  } finally {
    await browser.close();
  }
}
