import type { RobotsAccessStatus } from "@prisma/client";
import { fetchHtmlPage } from "./page-fetcher.server";

type Rule = { type: "allow" | "disallow"; path: string };

function applicableRules(content: string) {
  const lines = content.split(/\r?\n/);
  const rules: Rule[] = [];
  let applies = false;
  let groupHasRules = false;

  for (const rawLine of lines) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      if (groupHasRules) {
        applies = false;
        groupHasRules = false;
      }
      const agent = value.toLowerCase();
      applies =
        applies ||
        agent === "*" ||
        agent.includes("besanconarcheriepricewatch");
      continue;
    }

    if (field === "allow" || field === "disallow") {
      groupHasRules = true;
      if (applies && value) {
        rules.push({ type: field, path: value });
      }
    }
  }
  return rules;
}

export function robotsAllowsPath(content: string | null, pathname: string) {
  if (!content) return true;
  const matches = applicableRules(content)
    .filter((rule) => pathname.startsWith(rule.path.replace(/\*.*$/, "")))
    .sort((a, b) => b.path.length - a.path.length);
  return matches[0]?.type !== "disallow";
}

export function summarizeRobots(content: string | null): RobotsAccessStatus {
  if (!content) return "UNKNOWN";
  return robotsAllowsPath(content, "/") ? "ALLOWED" : "DISALLOWED";
}

export async function fetchRobotsTxt(domain: string) {
  const url = `https://${domain}/robots.txt`;
  try {
    const page = await fetchHtmlPage(url, domain);
    if (page.status === 404) {
      return {
        content: "",
        access: "ALLOWED" as RobotsAccessStatus,
        checkedAt: new Date(),
      };
    }
    if (page.status < 200 || page.status >= 300) {
      return {
        content: `# HTTP ${page.status} lors de la vérification`,
        access: "UNKNOWN" as RobotsAccessStatus,
        checkedAt: new Date(),
      };
    }
    return {
      content: page.html,
      access: summarizeRobots(page.html),
      checkedAt: new Date(),
    };
  } catch (error) {
    return {
      content: `# Vérification impossible: ${
        error instanceof Error ? error.message : "erreur inconnue"
      }`,
      access: "UNKNOWN" as RobotsAccessStatus,
      checkedAt: new Date(),
    };
  }
}
