import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";

import { clickTextOnlyHomeMonitorAction } from "../../src/browser/home-monitor-dom.js";

function pageWithResult(result: unknown) {
  return {
    url: () => "https://my.smartthings.com/location/raw-sparkplus",
    isClosed: () => false,
    goto: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => result)
  };
}

const monitorLabels = ["SmartThings Home Monitor", "Home Monitor"];
const actionLabels = ["보안(외출)", "외출"];
const modeLabelGroups = [
  ["보안(외출)", "외출"],
  ["보안(실내)", "실내"],
  ["해제", "보안 해제"]
];

describe("text-only Home Monitor DOM control", () => {
  test("accepts one exact text-pill click", async () => {
    const page = pageWithResult("clicked");

    await expect(
      clickTextOnlyHomeMonitorAction(
        page,
        monitorLabels,
        actionLabels,
        modeLabelGroups
      )
    ).resolves.toBe("clicked");

    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  test("preserves fail-closed ambiguous and missing outcomes", async () => {
    await expect(
      clickTextOnlyHomeMonitorAction(
        pageWithResult("ambiguous"),
        monitorLabels,
        actionLabels,
        modeLabelGroups
      )
    ).resolves.toBe("ambiguous");
    await expect(
      clickTextOnlyHomeMonitorAction(
        pageWithResult("not_found"),
        monitorLabels,
        actionLabels,
        modeLabelGroups
      )
    ).resolves.toBe("not_found");
    await expect(
      clickTextOnlyHomeMonitorAction(
        pageWithResult("unexpected"),
        monitorLabels,
        actionLabels,
        modeLabelGroups
      )
    ).resolves.toBe("not_found");
  });

  test("scans exact labels, delegated targets, and open shadow roots", () => {
    const source = readFileSync(
      "bridge/src/browser/home-monitor-dom.ts",
      "utf8"
    );

    expect(source).toContain('element.getAttribute("title")');
    expect(source).toContain(
      "if (element.shadowRoot) roots.push(element.shadowRoot)"
    );
    expect(source).toContain(
      'getComputedStyle(current).cursor === "pointer"'
    );
    expect(source).toContain("containsCompetingAction");
    expect(source).toContain("Date.now() + 15_000");
    expect(source).toContain('return ambiguousSeen ? "ambiguous" : "not_found"');
  });
});
