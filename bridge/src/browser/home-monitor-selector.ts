import type { BrowserPageLike } from "./keeper-page.js";
import { scopedHomeMonitorModeGroups } from "./home-monitor-mode-labels.js";

interface SelectorProbeInput {
  marker: string;
  monitorLabels: string[];
  modeLabelGroups: string[][];
  cleanup?: boolean;
  popupToken?: string;
}

export interface HomeMonitorSelectorProbe {
  kind: "missing" | "target" | "ambiguous" | "blocked" | "dialog" | "scan_limit";
  titles: number;
  localModes: number;
  localGroups: number;
  targets: number;
}

/** Browser-local, bounded and read-only except for an ephemeral locator marker. */
export function probeHomeMonitorSelector(input: SelectorProbeInput): HomeMonitorSelectorProbe {
  const result: HomeMonitorSelectorProbe = {
    kind: "missing", titles: 0, localModes: 0, localGroups: 0, targets: 0
  };
  const attribute = "data-stw-hm-selector";
  const elements: Element[] = [];
  const roots: ParentNode[] = [document];
  for (let index = 0; index < roots.length; index += 1) {
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
  const shown = new Map<Element, boolean>();
  const visible = (element: Element): boolean => {
    if (shown.has(element)) return shown.get(element)!;
    const rect = element.getBoundingClientRect();
    let value = rect.width > 0 && rect.height > 0;
    for (let cursor: Element | null = element; value && cursor; cursor = parent(cursor)) {
      const style = getComputedStyle(cursor);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0" ||
          cursor.hasAttribute("inert") || cursor.getAttribute("aria-hidden") === "true") value = false;
    }
    shown.set(element, value);
    return value;
  };
  if (elements.some((element) => visible(element) &&
      element.matches('dialog,[role="dialog"],[aria-modal="true"]'))) {
    return { ...result, kind: "dialog" };
  }
  const labelCache = new Map<Element, string[]>();
  const labels = (element: Element): string[] => {
    const cached = labelCache.get(element);
    if (cached) return cached;
    const root = element.getRootNode() as Document | ShadowRoot;
    const labelled = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/u)
      .map((id) => root.getElementById?.(id)?.textContent ?? "").join(" ");
    const direct = Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? "").join(" ");
    const values = [element.getAttribute("aria-label"), element.getAttribute("title"), labelled,
      direct, element instanceof HTMLElement ? element.innerText : element.textContent]
      .filter((value): value is string => typeof value === "string" && value.length <= 512)
      .map(normalize).filter(Boolean);
    labelCache.set(element, values);
    return values;
  };
  const deepest = (items: Element[]) => items.filter((candidate) =>
    !items.some((other) => other !== candidate && within(other, candidate)));
  const monitorNames = new Set(input.monitorLabels.map(normalize));
  const groups = input.modeLabelGroups.map((group) => new Set(group.map(normalize)));
  const groupOf = (element: Element): number => {
    const matches = groups.map((group, index) => labels(element).some((label) => group.has(label)) ? index : -1)
      .filter((index) => index >= 0);
    return matches.length === 1 ? matches[0]! : -1;
  };
  const titles = deepest(elements.filter((element) => visible(element) &&
    labels(element).some((label) => monitorNames.has(label))));
  result.titles = titles.length;
  if (titles.length !== 1) return { ...result, kind: titles.length > 1 ? "ambiguous" : "missing" };
  const title = titles[0]!;
  const modeElements = deepest(elements.filter((element) => visible(element) && groupOf(element) >= 0));
  const opensPopup = (element: Element) => element.matches('[role="combobox"]') ||
    ["true", "dialog", "listbox", "menu"].includes(element.getAttribute("aria-haspopup") ?? "") ||
    (element.hasAttribute("aria-expanded") && Boolean(element.getAttribute("aria-controls")));
  const popupElements = elements.filter((element) => visible(element) && opensPopup(element));
  const captions = new Set([normalize("System ready to arm")]);
  let card: Element | undefined;
  // Resolve ONE local scope, not a separate ancestor chain per page-wide mode match.
  for (let scope = parent(title), depth = 0; scope && depth < 10; scope = parent(scope), depth += 1) {
    if (scope.matches('html,body,main,[role="main"],nav,header,footer')) break;
    const foreignHeading = elements.some((element) => visible(element) && within(element, scope!) &&
      element.matches('h1,h2,h3,h4,h5,h6,[role="heading"]') &&
      !within(element, title) && !within(title, element) && groupOf(element) < 0 &&
      !labels(element).some((label) => captions.has(label)));
    if (foreignHeading) break;
    const localModes = modeElements.filter((element) => within(element, scope!));
    const localPopups = popupElements.filter((element) => within(element, scope!));
    if (localModes.length || localPopups.length) { card = scope; break; }
    // A named/semantic widget is a boundary even if its state label is unfamiliar.
    if (scope.matches('section,article,[role="region"],[role="group"]') ||
        /(?:^|[\s_-])(?:card|widget)(?:$|[\s_-])/iu.test(scope.className?.toString() ?? "")) break;
  }
  if (!card) return result;
  const localModes = modeElements.filter((element) => within(element, card!));
  result.localModes = localModes.length;
  result.localGroups = new Set(localModes.map(groupOf)).size;
  // A multi-mode action row belongs to the direct-action path, not the selector opener.
  if (result.localGroups > 1) return result;
  const stateCaptions = new Set([
    "Armed away", "Armed (Away)", "Armed stay", "Armed (Stay)", "Armed home", "Armed (Home)", "Disarmed", "Not armed", "Security off",
    "외출 중", "외출중", "집 밖에 있음", "집 밖에 있어요", "집을 비움",
    "재실 중", "재실중", "집에 있음", "집 안에 있음", "집 안에 있어요", "해제됨"
  ].map(normalize));
  const canonical = (element: Element): Element => {
    let pointer: Element | undefined;
    for (let cursor: Element | null = element; cursor && cursor !== card; cursor = parent(cursor)) {
      if (cursor instanceof HTMLLabelElement && cursor.control && within(cursor.control, card!)) return cursor.control;
      // cursor:pointer is inherited by spans. Prefer the actual owning button/role.
      if (cursor.matches('button,a[href],input,label,summary,[role="button"],[role="combobox"],[role="radio"],[onclick],[tabindex]')) return cursor;
      if (!pointer && getComputedStyle(cursor).cursor === "pointer") pointer = cursor;
    }
    return pointer ?? element;
  };
  const candidates = new Set<Element>();
  for (const element of localModes) {
    const target = canonical(element);
    // Never click a bare "Disarm"/"Off" command just to open a selector for armStay.
    const popup = opensPopup(target);
    if (!popup && !labels(element).some((label) => stateCaptions.has(label))) continue;
    if (localModes.some((other) => within(other, target) && groupOf(other) !== groupOf(element))) continue;
    candidates.add(target);
  }
  // A labelled selector may use an icon instead of displaying the current mode.
  for (const element of popupElements.filter((element) => within(element, card!))) {
    if (groupOf(element) >= 0 || labels(element).some((label) => monitorNames.has(label)) ||
        element.getAttribute("role") === "combobox") candidates.add(canonical(element));
  }
  const targets = deepest([...candidates]);
  result.targets = targets.length;
  if (targets.length > 1) return { ...result, kind: "ambiguous" };
  if (targets.length === 0) return result;
  const target = targets[0]!;
  for (let cursor: Element | null = target; cursor; cursor = parent(cursor)) {
    if (cursor.matches(':disabled,[aria-disabled="true"],[inert]')) return { ...result, kind: "blocked" };
    if (cursor === card) break;
  }
  target.setAttribute(attribute, input.marker);
  if (input.popupToken) target.setAttribute("data-stw-hm-popup-owner", input.popupToken);
  return { ...result, kind: "target" };
}

/** Detect only: callers may skip impossible direct-action polling once a selector is ready. */
export async function hasHomeMonitorSelector(
  page: BrowserPageLike, monitorLabels: readonly string[], modeLabelGroups: readonly (readonly string[])[]
): Promise<boolean> {
  if (!page.evaluate) return false;
  const input: SelectorProbeInput = { marker: `hm-probe-${Date.now().toString(36)}`,
    monitorLabels: [...monitorLabels], modeLabelGroups: scopedHomeMonitorModeGroups(modeLabelGroups) };
  try { return (await page.evaluate(probeHomeMonitorSelector, input))?.kind === "target"; }
  catch { return false; }
  finally { await page.evaluate(probeHomeMonitorSelector, { ...input, cleanup: true }).catch(() => undefined); }
}

export async function clickScopedHomeMonitorSelector(
  page: BrowserPageLike, monitorLabels: readonly string[], modeLabelGroups: readonly (readonly string[])[], timeoutMs: number, popupToken?: string
): Promise<"clicked" | "not_found" | "ambiguous" | "unavailable" | "blocked"> {
  const controls = page as BrowserPageLike & { locator?: (selector: string) => {
    click(options: { timeout: number }): Promise<unknown>;
  } };
  if (!page.evaluate || !controls.locator) return "unavailable";
  const input: SelectorProbeInput = { marker: `hm-open-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    monitorLabels: [...monitorLabels], modeLabelGroups: scopedHomeMonitorModeGroups(modeLabelGroups),
    ...(popupToken ? { popupToken } : {}) };
  const deadline = Date.now() + Math.max(1, Math.min(timeoutMs, 3_000));
  try {
    do {
      const probe = await page.evaluate(probeHomeMonitorSelector, input);
      if (probe?.kind === "ambiguous") return "ambiguous";
      if (["blocked", "dialog"].includes(probe?.kind)) return "blocked";
      if (probe?.kind === "scan_limit") return "not_found";
      if (probe?.kind === "target") {
        await controls.locator(`[data-stw-hm-selector="${input.marker}"]`).click({ timeout: Math.max(1, deadline - Date.now()) });
        return "clicked";
      }
      if (Date.now() >= deadline) break;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
    } while (Date.now() < deadline);
    return "not_found";
  } catch {
    // Do not try another target after an uncertain pointer dispatch.
    return "blocked";
  } finally {
    await page.evaluate(probeHomeMonitorSelector, { ...input, cleanup: true }).catch(() => undefined);
  }
}
