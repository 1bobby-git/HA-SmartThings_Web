import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";

import { clickExactSceneCard } from "../../src/browser/scene-dom.js";

function pageWithResult(result: unknown) {
  return {
    evaluate: vi.fn(async () => result)
  };
}

describe("exact SmartThings scene DOM control", () => {
  test("accepts one exact roleless React scene card", async () => {
    const page = pageWithResult("clicked");
    await expect(clickExactSceneCard(page as never, "Evening", 500)).resolves.toBe(
      "clicked"
    );
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  test("preserves fail-closed missing and ambiguous outcomes", async () => {
    await expect(
      clickExactSceneCard(pageWithResult("ambiguous") as never, "Evening", 500)
    ).resolves.toBe("ambiguous");
    await expect(
      clickExactSceneCard(pageWithResult("not_found") as never, "Evening", 500)
    ).resolves.toBe("not_found");
    await expect(
      clickExactSceneCard({} as never, "Evening", 500)
    ).resolves.toBe("unavailable");
  });

  test("uses exact labels, open shadow roots and delegated click ancestors", () => {
    const source = readFileSync("bridge/src/browser/scene-dom.ts", "utf8");
    expect(source).toContain('.normalize("NFKC")');
    expect(source).toContain("if (element.shadowRoot) roots.push(element.shadowRoot)");
    expect(source).toContain('["button", "link", "menuitem"].includes(role)');
    expect(source).toContain("containsCompetingScene");
    expect(source).toContain('return ambiguousSeen ? "ambiguous" : "not_found"');
  });
});
