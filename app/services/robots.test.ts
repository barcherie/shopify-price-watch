import { describe, expect, it } from "vitest";
import { robotsAllowsPath, summarizeRobots } from "./robots.server";

describe("robots.txt", () => {
  it("autorise un chemin non interdit", () => {
    expect(
      robotsAllowsPath("User-agent: *\nDisallow: /admin", "/produit/arc"),
    ).toBe(true);
  });

  it("refuse un chemin clairement interdit", () => {
    expect(
      robotsAllowsPath("User-agent: *\nDisallow: /produit", "/produit/arc"),
    ).toBe(false);
  });

  it("respecte une règle Allow plus spécifique", () => {
    expect(
      robotsAllowsPath(
        "User-agent: *\nDisallow: /produit\nAllow: /produit/public",
        "/produit/public/arc",
      ),
    ).toBe(true);
  });

  it("détecte une interdiction globale", () => {
    expect(summarizeRobots("User-agent: *\nDisallow: /")).toBe("DISALLOWED");
  });

  it("ne transforme pas un joker de paramètre en interdiction globale", () => {
    const content = [
      "User-agent: *",
      "Disallow: /*?order=",
      "Disallow: /*&search_query=",
      "Disallow: /cart",
    ].join("\n");

    expect(
      robotsAllowsPath(
        content,
        "/Stabilisateur-central-pour-arc-classique-ou-a-poulies/154",
      ),
    ).toBe(true);
    expect(robotsAllowsPath(content, "/categorie?order=price.asc")).toBe(false);
    expect(
      robotsAllowsPath(content, "/categorie?page=2&search_query=arc"),
    ).toBe(false);
  });
});
