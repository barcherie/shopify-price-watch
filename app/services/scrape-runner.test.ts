import { describe, expect, it } from "vitest";
import { isScrapeDue, SCRAPE_COOLDOWN_MS } from "./scrape-runner.server";

describe("isScrapeDue", () => {
  const now = new Date("2026-07-03T12:00:00Z");

  it("refuse une URL relevée aujourd’hui", () => {
    expect(isScrapeDue(new Date(now.getTime() - 60_000), now)).toBe(false);
  });

  it("autorise une URL après 24 heures", () => {
    expect(isScrapeDue(new Date(now.getTime() - SCRAPE_COOLDOWN_MS), now)).toBe(
      true,
    );
  });

  it("autorise le mode force en développement", () => {
    expect(isScrapeDue(new Date(now.getTime() - 60_000), now, true)).toBe(true);
  });
});
