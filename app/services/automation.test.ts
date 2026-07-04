import { describe, expect, it } from "vitest";
import { isAutomationDue } from "./automation.server";

describe("automation scheduling", () => {
  const now = new Date("2026-07-04T08:00:00.000Z");

  it("lance lorsque l’échéance est atteinte", () => {
    expect(
      isAutomationDue(
        { enabled: true, nextRunAt: new Date("2026-07-04T08:00:00.000Z") },
        now,
      ),
    ).toBe(true);
  });

  it("attend lorsque la prochaine date est future", () => {
    expect(
      isAutomationDue(
        { enabled: true, nextRunAt: new Date("2026-07-09T08:00:00.000Z") },
        now,
      ),
    ).toBe(false);
  });

  it("ne lance jamais une automatisation désactivée", () => {
    expect(isAutomationDue({ enabled: false, nextRunAt: null }, now)).toBe(
      false,
    );
  });
});
