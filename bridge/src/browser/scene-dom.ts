import type { BrowserPageLike } from "./keeper-page.js";

export type SceneDomResult =
  | "clicked"
  | "not_found"
  | "ambiguous"
  | "unavailable";

/** Click one exact visible SmartThings scene card, including roleless React cards. */
export async function clickExactSceneCard(
  page: BrowserPageLike,
  sceneName: string,
  timeoutMs = 15_000
): Promise<SceneDomResult> {
  if (!page.evaluate) return "unavailable";
  try {
    const result = await page.evaluate(
      async ({ sceneName, timeoutMs }) => {
        const normalize = (value: string | null | undefined) =>
          (value ?? "")
            .normalize("NFKC")
            .replace(/[\u200b-\u200d\u2060\ufeff]/gu, "")
            .replace(/\s+/gu, " ")
            .trim()
            .toLocaleLowerCase();
        const visible = (element: Element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0" &&
            rect.width > 0 &&
            rect.height > 0
          );
        };
        const labels = (element: Element) => {
          const values = [
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
            element.textContent
          ];
          if (element instanceof HTMLInputElement) values.push(element.value);
          return values.map(normalize).filter((value) => value.length > 0);
        };
        const allElements = () => {
          const result: Element[] = [];
          const roots: ParentNode[] = [document];
          for (let index = 0; index < roots.length; index += 1) {
            const root = roots[index];
            if (!root) continue;
            for (const element of root.querySelectorAll("*")) {
              result.push(element);
              if (element.shadowRoot) roots.push(element.shadowRoot);
            }
          }
          return result;
        };
        const targetName = normalize(sceneName);
        if (!targetName) return "not_found";
        const deadline = Date.now() + Math.max(1, timeoutMs);
        let ambiguousSeen = false;

        while (Date.now() < deadline) {
          const elements = allElements();
          const exact = elements.filter(
            (element) =>
              element instanceof HTMLElement &&
              visible(element) &&
              labels(element).includes(targetName)
          ) as HTMLElement[];
          const deepest = exact.filter(
            (candidate) =>
              !exact.some(
                (other) => other !== candidate && candidate.contains(other)
              )
          );
          const matches = new Set<HTMLElement>();
          for (const element of deepest) {
            let current: HTMLElement | null = element;
            let selected = element;
            for (let depth = 0; current && depth < 10; depth += 1) {
              const role = normalize(current.getAttribute("role"));
              const tag = current.tagName.toLocaleLowerCase();
              const interactive =
                ["button", "a", "input", "label"].includes(tag) ||
                ["button", "link", "menuitem"].includes(role) ||
                current.hasAttribute("onclick") ||
                current.tabIndex >= 0 ||
                getComputedStyle(current).cursor === "pointer";
              const containsCompetingScene = deepest.some(
                (other) => other !== element && current?.contains(other)
              );
              if (interactive && !containsCompetingScene) {
                selected = current;
                break;
              }
              current = current.parentElement;
            }
            matches.add(selected);
          }

          if (matches.size === 1) {
            const target = [...matches][0];
            if (!target) return "not_found";
            target.scrollIntoView({ block: "center", inline: "center" });
            target.focus?.({ preventScroll: true });
            target.click();
            return "clicked";
          }
          if (matches.size > 1) ambiguousSeen = true;
          await new Promise<void>((resolve) => window.setTimeout(resolve, 200));
        }
        return ambiguousSeen ? "ambiguous" : "not_found";
      },
      { sceneName, timeoutMs: Math.max(1, timeoutMs) }
    );
    return result === "clicked" ||
      result === "not_found" ||
      result === "ambiguous"
      ? result
      : "not_found";
  } catch {
    return "not_found";
  }
}
