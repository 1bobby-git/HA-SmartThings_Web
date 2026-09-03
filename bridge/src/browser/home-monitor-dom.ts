import type { BrowserPageLike } from "./keeper-page.js";

export type HomeMonitorDomResult =
  | "clicked"
  | "not_found"
  | "ambiguous"
  | "unavailable";

/**
 * Click a Home Monitor mode rendered as a text-only React pill.
 *
 * SmartThings sometimes omits native button/radio semantics from these mode
 * controls. The browser-side scan remains fail-closed: it requires one exact,
 * visible action inside the Home Monitor card (or a mode group containing at
 * least two known security modes) before dispatching a click.
 */
export async function clickTextOnlyHomeMonitorAction(
  page: BrowserPageLike,
  monitorLabels: readonly string[],
  actionLabels: readonly string[],
  modeLabelGroups: readonly (readonly string[])[]
): Promise<HomeMonitorDomResult> {
  if (!page.evaluate) return "unavailable";
  try {
    const result = await page.evaluate(
      async ({ monitorLabels, actionLabels, modeLabelGroups }) => {
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
        const elementLabels = (element: Element) => {
          const values = [
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
            element.textContent
          ];
          if (element instanceof HTMLInputElement) values.push(element.value);
          return values
            .map(normalize)
            .filter((value) => value.length > 0);
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
        const deepestExactElements = (
          elements: readonly Element[],
          labels: ReadonlySet<string>
        ) => {
          const exact = elements.filter(
            (element) =>
              element instanceof HTMLElement &&
              visible(element) &&
              elementLabels(element).some((label) => labels.has(label))
          ) as HTMLElement[];
          return exact.filter(
            (candidate) =>
              !exact.some(
                (other) => other !== candidate && candidate.contains(other)
              )
          );
        };
        const clickTargetFor = (
          element: HTMLElement,
          boundary: Element,
          actionTargets: readonly HTMLElement[]
        ) => {
          let current: HTMLElement | null = element;
          while (current) {
            const role = normalize(current.getAttribute("role"));
            const tag = current.tagName.toLocaleLowerCase();
            const interactive =
              ["button", "a", "input", "label"].includes(tag) ||
              ["button", "radio", "tab", "menuitem"].includes(role) ||
              current.hasAttribute("onclick") ||
              current.tabIndex >= 0 ||
              getComputedStyle(current).cursor === "pointer";
            const containsCompetingAction = actionTargets.some(
              (other) => other !== element && current?.contains(other)
            );
            if (interactive && !containsCompetingAction) return current;
            if (current === boundary) break;
            current = current.parentElement;
          }
          return element;
        };

        const monitorNames = new Set(monitorLabels.map(normalize));
        const actionNames = new Set(actionLabels.map(normalize));
        const modeGroups = modeLabelGroups.map(
          (labels) => new Set(labels.map(normalize))
        );
        const deadline = Date.now() + 15_000;
        let ambiguousSeen = false;

        while (Date.now() < deadline) {
          const elements = allElements();
          const titles = deepestExactElements(elements, monitorNames);
          const targets = deepestExactElements(elements, actionNames);
          const matches = new Set<HTMLElement>();

          for (const title of titles) {
            let scope: Element | null = title;
            for (
              let depth = 0;
              scope && depth < 10;
              depth += 1, scope = scope.parentElement
            ) {
              const localTargets = targets.filter((target) =>
                scope?.contains(target)
              );
              if (localTargets.length === 0) continue;
              for (const target of localTargets) {
                matches.add(clickTargetFor(target, scope, targets));
              }
              break;
            }
          }

          if (titles.length === 0) {
            for (const target of targets) {
              let scope: Element | null = target;
              for (
                let depth = 0;
                scope && depth < 8;
                depth += 1, scope = scope.parentElement
              ) {
                const modeCount = modeGroups.filter((group) =>
                  deepestExactElements(elements, group).some((item) =>
                    scope?.contains(item)
                  )
                ).length;
                if (modeCount < 2) continue;
                matches.add(clickTargetFor(target, scope, targets));
                break;
              }
            }
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
      {
        monitorLabels: [...monitorLabels],
        actionLabels: [...actionLabels],
        modeLabelGroups: modeLabelGroups.map((labels) => [...labels])
      }
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
