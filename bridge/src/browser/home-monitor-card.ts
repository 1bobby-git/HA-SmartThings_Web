import type { BrowserPageLike } from "./keeper-page.js";

export interface HomeMonitorCardDiagnostics {
  outcome: string;
  titles: number;
  modeGroups: number;
  htmlModes: number;
  svgModes: number;
  pseudoModes: number;
  canvases: number;
  dialogs: number;
  targets: number;
}

type CardProbeInput = {
  marker: string;
  monitorLabels: string[];
  modeLabelGroups: string[][];
  requestedGroup: number;
  cleanup?: boolean;
};
type CardProbeResult = Omit<HomeMonitorCardDiagnostics, "outcome"> & {
  kind: "missing" | "target" | "ambiguous" | "disabled" | "dialog" | "scan_limit";
};

/** Browser-local probe. No account text, selectors, URLs or identifiers leave this function. */
export function probeHomeMonitorCard(input: CardProbeInput): CardProbeResult {
  const result: CardProbeResult = { kind: "missing", titles: 0, modeGroups: 0,
    htmlModes: 0, svgModes: 0, pseudoModes: 0, canvases: 0, dialogs: 0, targets: 0 };
  const attribute = "data-stw-hm-card-action";
  const elements: Element[] = [];
  const roots: ParentNode[] = [document];
  for (let index = 0; index < roots.length; index++) {
    for (const element of roots[index]!.querySelectorAll("*")) {
      if (element.getAttribute(attribute) === input.marker) element.removeAttribute(attribute);
      if (elements.length >= 6_000) return { ...result, kind: "scan_limit" };
      elements.push(element);
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  if (input.cleanup) return result;
  const normalize = (value: string | null | undefined) => (value ?? "").normalize("NFKC")
    .toLowerCase().replace(/[\u200b-\u200d\u2060\ufeff]/gu, "")
    .replace(/[\s()（）:_-]+/gu, "");
  const parent = (element: Element): Element | null => {
    const root = element.getRootNode();
    return element.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  };
  const within = (element: Element, scope: Element): boolean => {
    for (let cursor: Element | null = element; cursor; cursor = parent(cursor)) {
      if (cursor === scope) return true;
    }
    return false;
  };
  const visibleCache = new Map<Element, boolean>();
  const visible = (element: Element): boolean => {
    if (visibleCache.has(element)) return visibleCache.get(element)!;
    const rect = element.getBoundingClientRect();
    let shown = rect.width > 0 && rect.height > 0;
    for (let cursor: Element | null = element; shown && cursor; cursor = parent(cursor)) {
      const style = getComputedStyle(cursor);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0" ||
          cursor.hasAttribute("inert") || cursor.getAttribute("aria-hidden") === "true") shown = false;
    }
    visibleCache.set(element, shown);
    return shown;
  };
  const dialogs = elements.filter((element) => element.matches('dialog,[role="dialog"],[aria-modal="true"]') && visible(element));
  result.dialogs = dialogs.length;
  if (dialogs.length) return { ...result, kind: "dialog" };
  result.canvases = elements.filter((element) => element instanceof HTMLCanvasElement && visible(element)).length;

  const modeSets = input.modeLabelGroups.map((group) => new Set(group.map(normalize)));
  const monitorNames = new Set(input.monitorLabels.map(normalize));
  const labelCache = new Map<Element, string[]>();
  const labels = (element: Element): string[] => {
    const cached = labelCache.get(element);
    if (cached) return cached;
    const root = element.getRootNode() as Document | ShadowRoot;
    const labelledBy = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/u)
      .map((id) => root.getElementById?.(id)?.textContent ?? "").join(" ");
    const direct = Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? "").join(" ");
    const values = [element.getAttribute("aria-label"), element.getAttribute("title"), labelledBy,
      direct, element instanceof HTMLElement ? element.innerText : element.textContent]
      .filter((value): value is string => typeof value === "string" && value.length <= 512)
      .map(normalize).filter(Boolean);
    labelCache.set(element, values);
    return values;
  };
  const modeMap = new Map<Element, number>();
  const pseudoMatches = new Set<Element>();
  for (const element of elements) {
    if (!visible(element) || element.matches("script,style,template,noscript")) continue;
    const values = labels(element);
    let groups = modeSets.map((set, index) => values.some((value) => set.has(value)) ? index : -1)
      .filter((index) => index >= 0);
    // CSS-rendered text is absent from textContent. Read only literal quoted content.
    if (groups.length === 0 && element instanceof HTMLElement &&
        element.matches('button,[role="button"],a,[tabindex],div,span')) {
      const pseudoValues = ["::before", "::after"].map((pseudo) => getComputedStyle(element, pseudo).content)
        .filter((value) => /^(["']).*\1$/u.test(value)).map((value) => normalize(value.slice(1, -1)));
      groups = modeSets.map((set, index) => pseudoValues.some((value) => set.has(value)) ? index : -1)
        .filter((index) => index >= 0);
      if (groups.length === 1) pseudoMatches.add(element);
    }
    if (groups.length === 1) modeMap.set(element, groups[0]!);
  }
  const deepest = (items: Element[]) => items.filter((candidate) =>
    !items.some((other) => other !== candidate && within(other, candidate)));
  const titles = deepest(elements.filter((element) => visible(element) &&
    labels(element).some((label) => monitorNames.has(label))));
  result.titles = titles.length;
  const modes = deepest([...modeMap.keys()]);
  result.modeGroups = new Set(modes.map((element) => modeMap.get(element))).size;
  result.htmlModes = modes.filter((element) => element instanceof HTMLElement).length;
  result.svgModes = modes.filter((element) => element instanceof SVGElement).length;
  result.pseudoModes = modes.filter((element) => pseudoMatches.has(element)).length;
  if (titles.length === 0) return result;
  if (titles.length > 1) return { ...result, kind: "ambiguous" };
  // Do not widen an exact monitor card into the entire dashboard or another named widget.
  let scope: Element | null = parent(titles[0]!);
  let card: Element | undefined;
  for (let depth = 0; scope && depth < 10; depth++, scope = parent(scope)) {
    if (scope.matches("html,body,main")) break;
    const foreignHeadings = elements.some((element) => within(element, scope!) && visible(element) &&
      element.matches('h1,h2,h3,h4,h5,h6,[role="heading"]') &&
      !within(element, titles[0]!) && !within(titles[0]!, element) && !modeMap.has(element));
    if (foreignHeadings) break;
    const localModes = modes.filter((element) => within(element, scope!));
    if (new Set(localModes.map((element) => modeMap.get(element))).size >= 2) {
      card = scope;
      break;
    }
  }
  if (!card) return result; // A single current-mode pill is handled by the existing dialog path.
  const requested = modes.filter((element) => within(element, card!) && modeMap.get(element) === input.requestedGroup);
  const targets = new Set<Element>();
  let blocked = false;
  for (const element of requested) {
    let cursor: Element | null = element;
    let selected: Element = element;
    for (; cursor && cursor !== card; cursor = parent(cursor)) {
      if (cursor.matches(':disabled,[aria-disabled="true"],[inert]') ||
          (cursor instanceof HTMLLabelElement && cursor.control?.matches(":disabled"))) blocked = true;
      const interactive = cursor.matches('button,a[href],input,label,[role="button"],[role="radio"],[role="tab"],[role="option"],[role="menuitem"],[role="menuitemradio"],[onclick],[tabindex]') ||
        getComputedStyle(cursor).cursor === "pointer";
      if (interactive) {
        if (modes.some((other) => within(other, cursor!) && modeMap.get(other) !== input.requestedGroup)) {
          blocked = true;
        } else selected = cursor;
        break;
      }
    }
    // Disabled state may be on an ancestor beyond the immediate click target.
    for (let ancestor: Element | null = selected; ancestor; ancestor = parent(ancestor)) {
      if (ancestor.matches(':disabled,[aria-disabled="true"],[inert]')) blocked = true;
      if (ancestor === card) break;
    }
    targets.add(selected);
  }
  const unique = deepest([...targets]);
  result.targets = unique.length;
  if (unique.length > 1) return { ...result, kind: "ambiguous" };
  if (blocked) return { ...result, kind: "disabled" };
  if (unique.length === 0) return result;
  unique[0]!.setAttribute(attribute, input.marker);
  return { ...result, kind: "target" };
}

/** Use a trusted Playwright pointer click, including SVG text/pills; never synthesize a DOM click. */
export async function clickHomeMonitorCardAction(
  page: BrowserPageLike,
  monitorLabels: readonly string[],
  modeLabelGroups: readonly (readonly string[])[],
  requestedGroup: number,
  timeoutMs: number,
  onDiagnostic?: (value: HomeMonitorCardDiagnostics) => void
): Promise<"clicked" | "not_found" | "ambiguous" | "unavailable" | "blocked" | "dialog"> {
  const controls = page as BrowserPageLike & { locator?: (selector: string) => {
    click(options: { timeout: number }): Promise<unknown>;
  } };
  if (!page.evaluate || !controls.locator) return "unavailable";
  const input: CardProbeInput = { marker: `hm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    monitorLabels: [...monitorLabels], modeLabelGroups: modeLabelGroups.map((group) => [...group]), requestedGroup };
  let last: CardProbeResult | undefined;
  const report = (outcome: string) => {
    if (!last) return;
    const { kind: _kind, ...counts } = last;
    try { onDiagnostic?.({ outcome, ...counts }); } catch { /* Diagnostics are non-fatal. */ }
  };
  const deadline = Date.now() + Math.max(1, Math.min(timeoutMs, 1_800));
  try {
    do {
      last = await page.evaluate(probeHomeMonitorCard, input);
      if (!last || typeof last !== "object" || typeof last.kind !== "string") return "unavailable";
      if (last.kind === "ambiguous") { report(last.kind); return "ambiguous"; }
      if (last.kind === "disabled" || last.kind === "scan_limit") { report(last.kind); return "blocked"; }
      if (last.kind === "dialog") { report(last.kind); return "dialog"; }
      if (last.kind === "target") {
        await controls.locator(`[data-stw-hm-card-action="${input.marker}"]`).click({ timeout: 3_000 });
        report("clicked");
        return "clicked";
      }
      if (Date.now() >= deadline) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
    } while (Date.now() < deadline);
    report("missing");
    return "not_found";
  } catch {
    // A pointer action may already have reached the page. Do not click a second target.
    report("interaction_failed");
    return "blocked";
  } finally {
    await page.evaluate(probeHomeMonitorCard, { ...input, cleanup: true }).catch(() => undefined);
  }
}
