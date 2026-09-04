import type { BrowserPageLike } from "./keeper-page.js";

export interface HomeMonitorDialogDiagnostics {
  outcome: string;
  dialogs: number;
  selects: number;
  options: number;
  modeGroups: number;
  targets: number;
}

type ProbeInput = {
  token: string;
  monitorLabels: string[];
  modeLabelGroups: string[][];
  requestedGroup: number;
  phase: "select" | "commit" | "cleanup";
};

type ProbeResult = Omit<HomeMonitorDialogDiagnostics, "outcome"> & {
  kind: "missing" | "unrecognized" | "ambiguous" | "disabled" | "select" | "click" | "expand" | "commit";
  optionIndex?: number;
};

/** Runs inside Chromium. Never returns page text, IDs, URLs, or option values. */
export function probeHomeMonitorDialog(input: ProbeInput): ProbeResult {
  const result: ProbeResult = { kind: "missing", dialogs: 0, selects: 0, options: 0, modeGroups: 0, targets: 0 };
  const normalize = (text: string | null | undefined) => (text ?? "").normalize("NFKC")
    .toLowerCase().replace(/[\u200b-\u200d\u2060\ufeff]/gu, "")
    .replace(/[\s()（）:_-]+/gu, "");
  const elements: Element[] = [];
  const roots: ParentNode[] = [document];
  for (let index = 0; index < roots.length && elements.length < 25_000; index++) {
    for (const element of roots[index]!.querySelectorAll("*")) {
      elements.push(element);
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  const targetAttribute = "data-stw-hm-target";
  const dialogAttribute = "data-stw-hm-dialog";
  for (const element of elements) {
    if (element.getAttribute(targetAttribute) === input.token) element.removeAttribute(targetAttribute);
    if (input.phase === "cleanup" && element.getAttribute(dialogAttribute) === input.token) {
      element.removeAttribute(dialogAttribute);
    }
  }
  if (input.phase === "cleanup") return result;
  const parent = (element: Element): Element | null => {
    const root = element.getRootNode();
    return element.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  };
  const within = (element: Element, boundary: Element): boolean => {
    for (let current: Element | null = element; current; current = parent(current)) {
      if (current === boundary) return true;
    }
    return false;
  };
  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let current: Element | null = element; current; current = parent(current)) {
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0" ||
          current.hasAttribute("inert") || current.getAttribute("aria-hidden") === "true") return false;
    }
    return true;
  };
  const disabled = (element: Element): boolean => element.matches(":disabled") ||
    (element instanceof HTMLLabelElement && element.control?.matches(":disabled") === true) ||
    element.closest('[aria-disabled="true"]') !== null;
  const labels = (element: Element): string[] => {
    const root = element.getRootNode() as Document | ShadowRoot;
    const labelledBy = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/u)
      .map((id) => root.getElementById?.(id)?.textContent ?? "").join(" ");
    const direct = Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? "").join(" ");
    return [element.getAttribute("aria-label"), element.getAttribute("title"), labelledBy,
      direct, element.textContent].map(normalize).filter(Boolean);
  };
  const groups = input.modeLabelGroups.map((group) => new Set(group.map(normalize)));
  // These are values read from actual form controls, never guessed remote commands.
  const nativeValues = [new Set(["armaway", "armedaway", "away"]),
    new Set(["armstay", "armedstay", "stay", "armhome", "armedhome"]),
    new Set(["disarm", "disarmed", "off"])];
  const groupOf = (element: Element, formValue?: string): number => {
    const values = labels(element);
    const matches = groups.map((group, index) => values.some((value) => group.has(value)) ? index : -1)
      .filter((index) => index >= 0);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) return -1;
    if (formValue !== undefined) {
      const index = nativeValues.findIndex((set) => set.has(normalize(formValue)));
      return index;
    }
    return -1;
  };
  const dialogs = elements.filter((element) =>
    (element.matches('dialog,[role="dialog"]')) && visible(element));
  result.dialogs = dialogs.length;
  if (dialogs.length === 0) return result;
  if (dialogs.length !== 1) return { ...result, kind: "ambiguous" };
  const dialog = dialogs[0]!;
  if (input.phase === "commit" && dialog.getAttribute(dialogAttribute) !== input.token) {
    return { ...result, kind: "unrecognized" };
  }
  let scoped = elements.filter((element) => within(element, dialog));
  // A combobox may portal its listbox outside the dialog. Only follow its own aria-controls.
  for (const combo of scoped.filter((element) => element.getAttribute("role") === "combobox")) {
    if (combo.getAttribute("aria-expanded") !== "true") continue;
    const root = combo.getRootNode() as Document | ShadowRoot;
    for (const id of (combo.getAttribute("aria-controls") ?? "").split(/\s+/u)) {
      const controlled = root.getElementById?.(id);
      if (controlled?.getAttribute("role") !== "listbox" || !visible(controlled)) continue;
      scoped.push(...elements.filter((element) => within(element, controlled)));
    }
  }
  scoped = [...new Set(scoped)];
  const selects = scoped.filter((element): element is HTMLSelectElement =>
    element instanceof HTMLSelectElement && visible(element));
  result.selects = selects.length;
  result.options = selects.reduce((total, select) => total + select.options.length, 0);
  const seenGroups = new Set<number>();
  for (const element of scoped) {
    if (!visible(element)) continue;
    const group = groupOf(element);
    if (group >= 0) seenGroups.add(group);
  }
  for (const select of selects) {
    // Native <option> elements have zero bounds when closed. Test the owning select instead.
    for (const option of select.options) {
      const group = groupOf(option, option.value);
      if (group >= 0) seenGroups.add(group);
    }
  }
  result.modeGroups = seenGroups.size;
  const monitorNames = new Set(input.monitorLabels.map(normalize));
  const identified = scoped.some((element) => visible(element) &&
    labels(element).some((label) => monitorNames.has(label)));
  // Only a monitor-labelled dialog or a complete three-mode selector is eligible.
  if (!identified && seenGroups.size !== 3) return { ...result, kind: "unrecognized" };
  if (input.phase === "commit") {
    const submitLabels = new Set(["apply", "save", "done", "ok", "confirm", "적용", "저장", "완료", "확인"]);
    const buttons = scoped.filter((element) => within(element, dialog) && visible(element) &&
      element.matches('button,[role="button"],input[type="submit"]') &&
      labels(element).some((label) => submitLabels.has(label)));
    result.targets = buttons.length;
    if (buttons.length > 1) return { ...result, kind: "ambiguous" };
    if (buttons.length === 0) return { ...result, kind: "missing" };
    if (disabled(buttons[0]!)) return { ...result, kind: "disabled" };
    buttons[0]!.setAttribute(targetAttribute, input.token);
    return { ...result, kind: "commit" };
  }
  const nativeTargets: { select: HTMLSelectElement; option: HTMLOptionElement }[] = [];
  for (const select of selects) {
    for (const option of select.options) {
      if (groupOf(option, option.value) === input.requestedGroup) nativeTargets.push({ select, option });
    }
  }
  const interactive = (element: Element) => element.matches(
    'button,a[href],input[type="radio"],label,[role="button"],[role="radio"],[role="option"],[role="menuitemradio"], [role="tab"]'
  ) || (element instanceof HTMLElement && (element.tabIndex >= 0 || element.hasAttribute("onclick")));
  const candidates = new Set<Element>();
  for (const element of scoped) {
    if (!visible(element) || element instanceof HTMLSelectElement || element instanceof HTMLOptionElement) continue;
    // Heading/direct text or aria-labelledby may supply the label, even with a description beside it.
    if (groupOf(element) !== input.requestedGroup) continue;
    let target: Element | null = element;
    while (target && scoped.includes(target) && !interactive(target) && target !== dialog) target = parent(target);
    if (!target || target === dialog || !scoped.includes(target)) {
      // An exact text-only pill may delegate clicks to React. Do not guess by position.
      target = element;
      if (element.matches("h1,h2,h3,h4,h5,h6")) continue;
    }
    if (scoped.some((other) => within(other, target!) && visible(other) &&
      groupOf(other) >= 0 && groupOf(other) !== input.requestedGroup)) continue;
    candidates.add(target);
  }
  // A labelled radio and its wrapping label refer to the same control.
  const targets = [...candidates].filter((candidate) => ![...candidates].some((other) =>
    other !== candidate && within(other, candidate)));
  result.targets = nativeTargets.length + targets.length;
  if (result.targets > 1) return { ...result, kind: "ambiguous" };
  if (nativeTargets.length === 1) {
    const { select, option } = nativeTargets[0]!;
    if (disabled(select) || option.disabled || option.parentElement?.matches("optgroup:disabled")) {
      return { ...result, kind: "disabled" };
    }
    dialog.setAttribute(dialogAttribute, input.token);
    select.setAttribute(targetAttribute, input.token);
    return { ...result, kind: "select", optionIndex: option.index };
  }
  if (targets.length === 1) {
    if (disabled(targets[0]!)) return { ...result, kind: "disabled" };
    dialog.setAttribute(dialogAttribute, input.token);
    targets[0]!.setAttribute(targetAttribute, input.token);
    return { ...result, kind: "click" };
  }
  const combos = scoped.filter((element) => within(element, dialog) && visible(element) &&
    element.getAttribute("role") === "combobox" && element.getAttribute("aria-expanded") !== "true" &&
    Boolean(element.getAttribute("aria-controls")) && !disabled(element));
  if (identified && combos.length === 1) {
    combos[0]!.setAttribute(targetAttribute, input.token);
    return { ...result, kind: "expand" };
  }
  return { ...result, kind: combos.length > 1 ? "ambiguous" : "unrecognized" };
}

export async function clickHomeMonitorDialogAction(
  page: BrowserPageLike,
  monitorLabels: readonly string[],
  actionLabels: readonly string[],
  modeLabelGroups: readonly (readonly string[])[],
  timeoutMs: number,
  waitForDialog: boolean,
  onDiagnostic?: (value: HomeMonitorDialogDiagnostics) => void
): Promise<"clicked" | "not_found" | "ambiguous" | "unavailable"> {
  const controls = page as BrowserPageLike & { locator?: (selector: string) => {
    click(options: { timeout: number }): Promise<unknown>;
    selectOption(option: { index: number }, options: { timeout: number }): Promise<unknown>;
  } };
  if (!page.evaluate || !controls.locator) return "unavailable";
  const requestedGroup = modeLabelGroups.findIndex((group) => actionLabels.some((label) => group.includes(label)));
  if (requestedGroup < 0) return "not_found";
  const token = `stw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const input: ProbeInput = { token, monitorLabels: [...monitorLabels],
    modeLabelGroups: modeLabelGroups.map((group) => [...group]), requestedGroup, phase: "select" };
  const deadline = Date.now() + Math.max(1, Math.min(timeoutMs, 10_000));
  let last: ProbeResult | undefined;
  let expanded = false;
  const report = (outcome: string) => {
    if (!last) return;
    try { onDiagnostic?.({ outcome, dialogs: last.dialogs, selects: last.selects,
      options: last.options, modeGroups: last.modeGroups, targets: last.targets }); } catch { /* Non-fatal. */ }
  };
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 100));
  try {
    do {
      last = await page.evaluate(probeHomeMonitorDialog, input);
      if (!last || typeof last !== "object" || typeof last.kind !== "string") return "unavailable";
      if (last.kind === "missing" && !waitForDialog) return "unavailable";
      if (last.kind === "ambiguous") { report("ambiguous"); return "ambiguous"; }
      if (last.kind === "select" || last.kind === "click") {
        report(last.kind);
        const target = controls.locator(`[data-stw-hm-target="${token}"]`);
        if (last.kind === "select") {
          await target.selectOption({ index: last.optionIndex! }, { timeout: 3_000 });
        } else {
          await target.click({ timeout: 3_000 });
        }
        // Some dialogs submit on selection; others require an explicit apply button.
        const commitDeadline = Date.now() + 1_500;
        do {
          last = await page.evaluate(probeHomeMonitorDialog, { ...input, phase: "commit" });
          if (last.kind === "ambiguous") { report("ambiguous_apply"); return "ambiguous"; }
          if (last.kind === "commit") {
            await controls.locator(`[data-stw-hm-target="${token}"]`).click({ timeout: 3_000 });
            report("submitted");
            return "clicked";
          }
          if (last.dialogs === 0 || last.kind === "unrecognized") break;
          await pause();
        } while (Date.now() < commitDeadline);
        report("selected");
        return "clicked"; // Existing security-arm-state confirmation still decides success.
      }
      if (last.kind === "expand" && !expanded) {
        await controls.locator(`[data-stw-hm-target="${token}"]`).click({ timeout: 3_000 });
        expanded = true;
      }
      await pause();
    } while (Date.now() < deadline);
    report(last?.kind ?? "missing");
    return last?.dialogs === 0 ? "unavailable" : "not_found";
  } catch {
    report("interaction_failed");
    return "not_found";
  } finally {
    await page.evaluate(probeHomeMonitorDialog, { ...input, phase: "cleanup" }).catch(() => undefined);
  }
}
