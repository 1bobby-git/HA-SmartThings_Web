import type { BrowserPageLike } from "./keeper-page.js";

type ModeProbeInput = {
  marker: string;
  monitorLabels: string[];
  modeLabelGroups: string[][];
  cleanup?: boolean;
  currentModeGroup?: number;
};
type ModeProbeResult = { kind: "missing" | "target" | "ambiguous" | "blocked"; targets: number };

/** Browser-local, exact-card selector. Text and raw identifiers never leave the page. */
export function probeCurrentHomeMonitorMode(input: ModeProbeInput): ModeProbeResult {
  const attribute = "data-stw-hm-current-mode";
  const result: ModeProbeResult = { kind: "missing", targets: 0 };
  const elements: Element[] = [];
  const roots: ParentNode[] = [document];
  for (let index = 0; index < roots.length; index++) {
    for (const element of roots[index]!.querySelectorAll("*")) {
      if (element.getAttribute(attribute) === input.marker) element.removeAttribute(attribute);
      if (elements.length >= 6_000) return { ...result, kind: "blocked" };
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
  const within = (element: Element, boundary: Element): boolean => {
    for (let cursor: Element | null = element; cursor; cursor = parent(cursor)) {
      if (cursor === boundary) return true;
    }
    return false;
  };
  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let cursor: Element | null = element; cursor; cursor = parent(cursor)) {
      const style = getComputedStyle(cursor);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" ||
          style.opacity === "0" || cursor.hasAttribute("inert") || cursor.getAttribute("aria-hidden") === "true") return false;
    }
    return true;
  };
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
  const shown = elements.filter(visible);
  if (shown.some((element) => element.matches('dialog,[role="dialog"],[aria-modal="true"]'))) {
    return { ...result, kind: "blocked" };
  }
  const deepest = (items: Element[]) => items.filter((candidate) =>
    !items.some((other) => other !== candidate && within(other, candidate)));
  const names = new Set(input.monitorLabels.map(normalize));
  const groups = input.modeLabelGroups.map((group) => new Set(group.map(normalize)));
  const titles = deepest(shown.filter((element) => labels(element).some((label) => names.has(label))));
  if (titles.length !== 1) return { ...result, kind: titles.length > 1 ? "ambiguous" : "missing" };
  const title = titles[0]!;
  const groupOf = (element: Element): number => {
    const matched = groups.map((group, index) => labels(element).some((label) => group.has(label)) ? index : -1)
      .filter((index) => index >= 0);
    return matched.length === 1 ? matched[0]! : -1;
  };
  const modes = deepest(shown.filter((element) => groupOf(element) >= 0));
  let scope: Element | null = parent(title);
  let card: Element | undefined;
  let local: Element[] = [];
  for (let depth = 0; scope && depth < 10; depth++, scope = parent(scope)) {
    if (scope.matches('html,body,main,[role="main"]')) break;
    const foreignHeading = shown.some((element) => within(element, scope!) &&
      element.matches('h1,h2,h3,h4,h5,h6,[role="heading"]') &&
      !within(element, title) && !within(title, element) && groupOf(element) < 0 &&
      !labels(element).includes(normalize("System ready to arm")));
    if (foreignHeading) break;
    local = modes.filter((element) => within(element, scope!));
    if (local.length) { card = scope; break; }
    // A recognized card boundary with no mode must not borrow a neighbour's Off label.
    if (scope.matches('section,article,[role="region"]')) break;
  }
  if (!card) return result;
  if (new Set(local.map(groupOf)).size !== 1) return { ...result, kind: "ambiguous" };
  // A Disarm command on an armed card is NOT a current-state selector.
  // Production supplies the latest observed state, not the requested next state.
  if (input.currentModeGroup !== undefined && groupOf(local[0]!) !== input.currentModeGroup) return result;
  const targets = new Set<Element>();
  for (const mode of local) {
    let target = mode;
    let pointerTarget: Element | undefined;
    for (let cursor: Element | null = mode; cursor && cursor !== card; cursor = parent(cursor)) {
      // Prefer a real control over inherited cursor:pointer on its text/icon descendants.
      if (cursor.matches('button,a[href],input,label,summary,[role="button"],[role="combobox"],[role="radio"],[onclick],[tabindex],[aria-haspopup]') ||
          (cursor instanceof HTMLElement && typeof cursor.onclick === "function")) { target = cursor; break; }
      if (getComputedStyle(cursor).cursor === "pointer") pointerTarget = cursor;
    }
    if (target === mode && pointerTarget) target = pointerTarget;
    // Sibling text/icon/aria labels collapse only when they resolve to the SAME control.
    targets.add(target);
  }
  const unique = [...targets];
  if (unique.length !== 1) return { kind: "ambiguous", targets: unique.length };
  const target = unique[0]!;
  if (input.currentModeGroup === undefined &&
      !target.matches('[role="combobox"],[aria-haspopup="dialog"],[aria-haspopup="listbox"],[aria-haspopup="menu"],[aria-haspopup="true"]')) return result;
  for (let cursor: Element | null = target; cursor; cursor = parent(cursor)) {
    if (cursor.matches(':disabled,[aria-disabled="true"],[inert]')) return { kind: "blocked", targets: 1 };
    if (cursor === card) break;
  }
  if (target instanceof HTMLLabelElement && target.control?.matches(":disabled")) return { kind: "blocked", targets: 1 };
  target.setAttribute(attribute, input.marker);
  return { kind: "target", targets: 1 };
}

/** A trusted, bounded pointer click; never choose an arbitrary first match. */
export async function clickScopedCurrentHomeMonitorMode(
  page: BrowserPageLike,
  monitorLabels: readonly string[],
  modeLabelGroups: readonly (readonly string[])[],
  timeoutMs = 3_000,
  currentModeGroup?: number
): Promise<"clicked" | "not_found" | "ambiguous" | "unavailable"> {
  const controls = page as BrowserPageLike & { locator?: (selector: string) => {
    click(options: { timeout: number }): Promise<unknown>;
  } };
  if (!page.evaluate || !controls.locator) return "unavailable";
  const input: ModeProbeInput = {
    marker: `hm-mode-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    monitorLabels: [...monitorLabels], modeLabelGroups: modeLabelGroups.map((group) => [...group]),
    ...(currentModeGroup === undefined ? {} : { currentModeGroup })
  };
  const deadline = Date.now() + Math.max(1, Math.min(timeoutMs, 3_000));
  let ambiguous = false;
  try {
    do {
      const result = await page.evaluate(probeCurrentHomeMonitorMode, input);
      if (!result || typeof result !== "object") return "not_found";
      if (result.kind === "blocked") return "not_found";
      if (result.kind === "target") {
        await controls.locator(`[data-stw-hm-current-mode="${input.marker}"]`).click({ timeout: Math.max(1, deadline - Date.now()) });
        return "clicked";
      }
      if (result.kind === "ambiguous") ambiguous = true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, remaining)));
    } while (Date.now() < deadline);
    return ambiguous ? "ambiguous" : "not_found";
  } catch {
    // A pointer failure may have delivered a click. Stop; do not retry another target.
    throw new Error("command_control_not_found");
  } finally {
    await page.evaluate(probeCurrentHomeMonitorMode, { ...input, cleanup: true }).catch(() => undefined);
  }
}
