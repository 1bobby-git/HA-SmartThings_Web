import type { BrowserPageLike } from "./keeper-page.js";

export type HomeMonitorDomResult =
  | "clicked"
  | "not_found"
  | "ambiguous"
  | "unavailable";

export type HomeMonitorDomPhase =
  | "before_card_open"
  | "after_card_open"
  | "final_failure";

/** Privacy-safe structural counters only. No page text, URL, account or raw ID is returned. */
export interface HomeMonitorDomDiagnostics {
  phase: HomeMonitorDomPhase;
  monitorExactCount: number;
  actionExactCount: number;
  actionClickableCount: number;
  modeGroupCount: number;
  visibleDialogCount: number;
  visibleIframeCount: number;
  openShadowRootCount: number;
}

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
  modeLabelGroups: readonly (readonly string[])[],
  timeoutMs = 15_000
): Promise<HomeMonitorDomResult> {
  if (!page.evaluate) return "unavailable";
  try {
    const result = await page.evaluate(
      async ({ monitorLabels, actionLabels, modeLabelGroups, timeoutMs }) => {
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
        const parentOrHost = (element: Element): HTMLElement | null => {
          if (element.parentElement) return element.parentElement;
          const root = element.getRootNode();
          return root instanceof ShadowRoot && root.host instanceof HTMLElement
            ? root.host
            : null;
        };
        const isWithin = (element: Element, boundary: Element) => {
          let current: Element | null = element;
          for (let depth = 0; current && depth < 24; depth += 1) {
            if (current === boundary) return true;
            current = parentOrHost(current);
          }
          return false;
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
                (other) => other !== candidate && isWithin(other, candidate)
              )
          );
        };
        const clickTargetFor = (
          element: HTMLElement,
          boundary: Element,
          actionTargets: readonly HTMLElement[]
        ) => {
          let current: HTMLElement | null = element;
          for (let depth = 0; current && depth < 12; depth += 1) {
            const role = normalize(current.getAttribute("role"));
            const tag = current.tagName.toLocaleLowerCase();
            const interactive =
              ["button", "a", "input", "label", "summary"].includes(tag) ||
              [
                "button",
                "link",
                "radio",
                "tab",
                "menuitem",
                "menuitemradio",
                "option",
                "switch"
              ].includes(role) ||
              current.hasAttribute("onclick") ||
              current.tabIndex >= 0 ||
              getComputedStyle(current).cursor === "pointer";
            const containsCompetingAction = actionTargets.some(
              (other) => other !== element && isWithin(other, current as Element)
            );
            if (interactive && !containsCompetingAction) return current;
            if (current === boundary) break;
            current = parentOrHost(current);
          }
          return element;
        };

        const monitorNames = new Set(monitorLabels.map(normalize));
        const actionNames = new Set(actionLabels.map(normalize));
        const modeGroups = modeLabelGroups.map(
          (labels) => new Set(labels.map(normalize))
        );
        const deadline = Date.now() + Math.max(1, timeoutMs);
        let ambiguousSeen = false;

        while (Date.now() < deadline) {
          const elements = allElements();
          const titles = deepestExactElements(elements, monitorNames);
          const targets = deepestExactElements(elements, actionNames);
          const matches = new Set<HTMLElement>();

          for (const title of titles) {
            let scope: Element | null = title;
            for (let depth = 0; scope && depth < 12; depth += 1) {
              const localTargets = targets.filter((target) =>
                isWithin(target, scope as Element)
              );
              if (localTargets.length > 0) {
                for (const target of localTargets) {
                  matches.add(clickTargetFor(target, scope, targets));
                }
                break;
              }
              scope = parentOrHost(scope);
            }
          }

          if (titles.length === 0) {
            for (const target of targets) {
              let scope: Element | null = target;
              for (let depth = 0; scope && depth < 10; depth += 1) {
                const modeCount = modeGroups.filter((group) =>
                  deepestExactElements(elements, group).some((item) =>
                    isWithin(item, scope as Element)
                  )
                ).length;
                if (modeCount >= 2) {
                  matches.add(clickTargetFor(target, scope, targets));
                  break;
                }
                scope = parentOrHost(scope);
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
        modeLabelGroups: modeLabelGroups.map((labels) => [...labels]),
        timeoutMs: Math.max(1, timeoutMs)
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

/**
 * Click the one current Home Monitor mode shown beside the exact card title.
 *
 * The live SmartThings layout initially exposes only the current mode pill.
 * Clicking the title does not open its selector, so the exact current-mode
 * text inside that card is clicked and allowed to bubble to React.
 */
export async function clickCurrentHomeMonitorMode(
  page: BrowserPageLike,
  monitorLabels: readonly string[],
  modeLabelGroups: readonly (readonly string[])[],
  timeoutMs = 3_000
): Promise<HomeMonitorDomResult> {
  if (!page.evaluate) return "unavailable";
  try {
    const result = await page.evaluate(
      async ({ monitorLabels, modeLabelGroups, timeoutMs }) => {
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
        const parentOrHost = (element: Element): HTMLElement | null => {
          if (element.parentElement) return element.parentElement;
          const root = element.getRootNode();
          return root instanceof ShadowRoot && root.host instanceof HTMLElement
            ? root.host
            : null;
        };
        const isWithin = (element: Element, boundary: Element) => {
          let current: Element | null = element;
          for (let depth = 0; current && depth < 24; depth += 1) {
            if (current === boundary) return true;
            current = parentOrHost(current);
          }
          return false;
        };
        const deepestExact = (
          elements: readonly Element[],
          names: ReadonlySet<string>
        ) => {
          const exact = elements.filter(
            (element) =>
              element instanceof HTMLElement &&
              visible(element) &&
              labels(element).some((label) => names.has(label))
          ) as HTMLElement[];
          return exact.filter(
            (candidate) =>
              !exact.some(
                (other) => other !== candidate && isWithin(other, candidate)
              )
          );
        };

        const monitorNames = new Set(monitorLabels.map(normalize));
        const modeGroups = modeLabelGroups.map(
          (group) => new Set(group.map(normalize))
        );
        const deadline = Date.now() + Math.max(1, timeoutMs);
        let ambiguousSeen = false;

        while (Date.now() < deadline) {
          const elements = allElements();
          const titles = deepestExact(elements, monitorNames);
          const visibleGroups = modeGroups
            .map((group) => deepestExact(elements, group))
            .filter((group) => group.length > 0);
          if (titles.length === 1 && visibleGroups.length === 1) {
            const title = titles[0];
            const matches = new Set<HTMLElement>();
            for (const target of visibleGroups[0] ?? []) {
              let scope: Element | null = title ?? null;
              for (let depth = 0; scope && depth < 12; depth += 1) {
                if (isWithin(target, scope)) {
                  matches.add(target);
                  break;
                }
                scope = parentOrHost(scope);
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
          } else if (titles.length > 1 || visibleGroups.length > 1) {
            ambiguousSeen = true;
          }
          await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
        }
        return ambiguousSeen ? "ambiguous" : "not_found";
      },
      {
        monitorLabels: [...monitorLabels],
        modeLabelGroups: modeLabelGroups.map((labels) => [...labels]),
        timeoutMs: Math.max(1, timeoutMs),
        currentModeProbe: true
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

/**
 * Open the exact Home Monitor card even when Cake renders it as a roleless
 * React card. Clicking the exact title itself is allowed as the final target;
 * the event then bubbles to a delegated parent handler without guessing a
 * neighbouring dashboard control.
 */
export async function clickTextOnlyHomeMonitorCard(
  page: BrowserPageLike,
  monitorLabels: readonly string[],
  timeoutMs = 3_000
): Promise<HomeMonitorDomResult> {
  if (!page.evaluate) return "unavailable";
  try {
    const result = await page.evaluate(
      async ({ monitorLabels, timeoutMs }) => {
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
        const parentOrHost = (element: Element): HTMLElement | null => {
          if (element.parentElement) return element.parentElement;
          const root = element.getRootNode();
          return root instanceof ShadowRoot && root.host instanceof HTMLElement
            ? root.host
            : null;
        };
        const isWithin = (element: Element, boundary: Element) => {
          let current: Element | null = element;
          for (let depth = 0; current && depth < 24; depth += 1) {
            if (current === boundary) return true;
            current = parentOrHost(current);
          }
          return false;
        };
        const monitorNames = new Set(monitorLabels.map(normalize));
        const deadline = Date.now() + Math.max(1, timeoutMs);
        let ambiguousSeen = false;

        while (Date.now() < deadline) {
          const elements = allElements();
          const exact = elements.filter(
            (element) =>
              element instanceof HTMLElement &&
              visible(element) &&
              elementLabels(element).some((label) => monitorNames.has(label))
          ) as HTMLElement[];
          const deepest = exact.filter(
            (candidate) =>
              !exact.some(
                (other) => other !== candidate && isWithin(other, candidate)
              )
          );
          const matches = new Set<HTMLElement>();
          for (const title of deepest) {
            let current: HTMLElement | null = title;
            let selected = title;
            for (let depth = 0; current && depth < 12; depth += 1) {
              const role = normalize(current.getAttribute("role"));
              const tag = current.tagName.toLocaleLowerCase();
              const interactive =
                ["button", "a", "input", "label", "summary"].includes(tag) ||
                [
                  "button",
                  "link",
                  "menuitem",
                  "menuitemradio",
                  "radio",
                  "tab"
                ].includes(role) ||
                current.hasAttribute("onclick") ||
                current.tabIndex >= 0 ||
                getComputedStyle(current).cursor === "pointer";
              const containsCompetingTitle = deepest.some(
                (other) => other !== title && isWithin(other, current as Element)
              );
              if (interactive && !containsCompetingTitle) {
                selected = current;
                break;
              }
              current = parentOrHost(current);
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
      { monitorLabels: [...monitorLabels], timeoutMs: Math.max(1, timeoutMs) }
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

/** Collect failure-only, bounded structural evidence without page content. */
export async function inspectHomeMonitorDom(
  page: BrowserPageLike,
  monitorLabels: readonly string[],
  actionLabels: readonly string[],
  modeLabelGroups: readonly (readonly string[])[],
  phase: HomeMonitorDomPhase
): Promise<HomeMonitorDomDiagnostics | undefined> {
  if (!page.evaluate) return undefined;
  try {
    const result = await page.evaluate(
      ({ monitorLabels, actionLabels, modeLabelGroups, phase }) => {
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
        const elements: Element[] = [];
        const roots: ParentNode[] = [document];
        let openShadowRootCount = 0;
        for (let index = 0; index < roots.length; index += 1) {
          const root = roots[index];
          if (!root) continue;
          for (const element of root.querySelectorAll("*")) {
            elements.push(element);
            if (element.shadowRoot) {
              openShadowRootCount += 1;
              roots.push(element.shadowRoot);
            }
          }
        }
        const monitorNames = new Set(monitorLabels.map(normalize));
        const actionNames = new Set(actionLabels.map(normalize));
        const modeGroups = modeLabelGroups.map(
          (group) => new Set(group.map(normalize))
        );
        const exactVisible = (set: ReadonlySet<string>) =>
          elements.filter(
            (element) =>
              element instanceof HTMLElement &&
              visible(element) &&
              labels(element).some((label) => set.has(label))
          ) as HTMLElement[];
        const actionMatches = exactVisible(actionNames);
        const actionClickableCount = actionMatches.filter((element) => {
          const role = normalize(element.getAttribute("role"));
          const tag = element.tagName.toLocaleLowerCase();
          return (
            ["button", "a", "input", "label", "summary"].includes(tag) ||
            [
              "button",
              "link",
              "radio",
              "tab",
              "menuitem",
              "menuitemradio",
              "option",
              "switch"
            ].includes(role) ||
            element.hasAttribute("onclick") ||
            element.tabIndex >= 0 ||
            getComputedStyle(element).cursor === "pointer"
          );
        }).length;
        return {
          phase,
          monitorExactCount: exactVisible(monitorNames).length,
          actionExactCount: actionMatches.length,
          actionClickableCount,
          modeGroupCount: modeGroups.filter((group) => exactVisible(group).length > 0).length,
          visibleDialogCount: elements.filter(
            (element) =>
              visible(element) &&
              (element.tagName.toLocaleLowerCase() === "dialog" ||
                normalize(element.getAttribute("role")) === "dialog")
          ).length,
          visibleIframeCount: elements.filter(
            (element) =>
              visible(element) && element.tagName.toLocaleLowerCase() === "iframe"
          ).length,
          openShadowRootCount
        };
      },
      {
        monitorLabels: [...monitorLabels],
        actionLabels: [...actionLabels],
        modeLabelGroups: modeLabelGroups.map((labels) => [...labels]),
        phase
      }
    );
    if (!result || typeof result !== "object") return undefined;
    const record = result as Record<string, unknown>;
    const bounded = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value)
        ? Math.max(0, Math.min(999, Math.trunc(value)))
        : 0;
    return {
      phase,
      monitorExactCount: bounded(record.monitorExactCount),
      actionExactCount: bounded(record.actionExactCount),
      actionClickableCount: bounded(record.actionClickableCount),
      modeGroupCount: bounded(record.modeGroupCount),
      visibleDialogCount: bounded(record.visibleDialogCount),
      visibleIframeCount: bounded(record.visibleIframeCount),
      openShadowRootCount: bounded(record.openShadowRootCount)
    };
  } catch {
    return undefined;
  }
}
