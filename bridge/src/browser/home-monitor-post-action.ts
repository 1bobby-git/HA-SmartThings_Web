import type { BrowserPageLike } from "./keeper-page.js";

export type HomeMonitorLifecycleStage =
  | "home_monitor_action_clicked"
  | "home_monitor_confirmation_waiting"
  | "home_monitor_confirmation_submitted"
  | "home_monitor_confirmation_confirmed"
  | "home_monitor_confirmation_timed_out"
  | "home_monitor_confirmation_failed"
  | "home_monitor_post_click_dialog_unrecognized"
  | "home_monitor_post_click_dialog_ambiguous"
  | "home_monitor_post_click_dialog_disabled";

type ConfirmationProbe = {
  kind: "none" | "unrecognized" | "ambiguous" | "disabled" | "submit";
};
type ProbeInput = {
  marker: string;
  monitorLabels: string[];
  modeLabelGroups: string[][];
  requestedGroup: number;
  cleanup?: boolean;
};

/** Only submit a uniquely identified monitor/mode confirmation, never an arbitrary OK dialog. */
export function probeHomeMonitorPostAction(input: ProbeInput): ConfirmationProbe {
  const attribute = "data-stw-hm-post-action";
  const elements: Element[] = [];
  const roots: ParentNode[] = [document];
  for (let index = 0; index < roots.length; index++) {
    for (const element of roots[index]!.querySelectorAll("*")) {
      if (element.getAttribute(attribute) === input.marker) element.removeAttribute(attribute);
      if (elements.length >= 6_000) return { kind: "unrecognized" };
      elements.push(element);
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  if (input.cleanup) return { kind: "none" };
  const normalize = (value: string | null | undefined) => (value ?? "").normalize("NFKC")
    .toLowerCase().replace(/[\u200b-\u200d\u2060\ufeff]/gu, "")
    .replace(/[\s()（）:_!?-]+/gu, "");
  const parent = (element: Element): Element | null => element.parentElement ??
    (element.getRootNode() instanceof ShadowRoot ? (element.getRootNode() as ShadowRoot).host : null);
  const within = (element: Element, scope: Element): boolean => {
    for (let current: Element | null = element; current; current = parent(current)) {
      if (current === scope) return true;
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
  const labels = (element: Element): string[] => {
    const root = element.getRootNode() as Document | ShadowRoot;
    const labelledBy = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/u)
      .map((id) => root.getElementById?.(id)?.textContent ?? "").join(" ");
    const direct = Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? "").join(" ");
    return [element.getAttribute("aria-label"), element.getAttribute("title"), labelledBy, direct,
      element.textContent, element instanceof HTMLInputElement ? element.value : undefined]
      .filter((value): value is string => typeof value === "string" && value.length <= 512)
      .map(normalize).filter(Boolean);
  };
  const allDialogs = elements.filter((element) =>
    element.matches('dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"]') && visible(element));
  const dialogs = allDialogs.filter((element) => !allDialogs.some((other) =>
    other !== element && within(other, element)));
  if (dialogs.length === 0) return { kind: "none" };
  if (dialogs.length !== 1) return { kind: "ambiguous" };
  const dialog = dialogs[0]!;
  const scoped = elements.filter((element) => within(element, dialog) && visible(element));
  const monitorNames = new Set(input.monitorLabels.map(normalize));
  const groups = input.modeLabelGroups.map((group) => new Set(group.map(normalize)));
  const hasMonitor = scoped.some((element) => labels(element).some((value) => monitorNames.has(value)));
  const modeGroups = new Set<number>();
  for (const element of scoped) {
    groups.forEach((group, index) => {
      if (labels(element).some((value) => group.has(value))) modeGroups.add(index);
    });
  }
  // Selection dialogs are handled elsewhere. This path only submits the exact requested mode.
  if (!hasMonitor || modeGroups.size !== 1 || !modeGroups.has(input.requestedGroup)) {
    return { kind: "unrecognized" };
  }
  const names = new Set(["apply", "save", "done", "ok", "confirm", "적용", "저장", "완료", "확인"]);
  const buttons = scoped.filter((element) =>
    element.matches('button,[role="button"],input[type="submit"]') &&
    labels(element).some((value) => names.has(value)));
  if (buttons.length > 1) return { kind: "ambiguous" };
  if (buttons.length === 0) return { kind: "unrecognized" };
  const button = buttons[0]!;
  for (let current: Element | null = button; current; current = parent(current)) {
    if (current.matches(':disabled,[aria-disabled="true"],[inert]')) return { kind: "disabled" };
    if (current === dialog) break;
  }
  button.setAttribute(attribute, input.marker);
  return { kind: "submit" };
}

/**
 * A pointer click is not delivery/confirmation. Keep the command page and its socket alive
 * until the coordinator observes the requested security state, or its bounded wait fails.
 * The caller closes the page in finally on every outcome. No mode is retried here.
 */
export async function finishHomeMonitorInteraction(
  page: BrowserPageLike,
  input: {
    monitorLabels: readonly string[];
    modeLabelGroups: readonly (readonly string[])[];
    requestedGroup: number;
    waitForConfirmation?: () => Promise<void>;
    confirmationTimeoutMs?: number;
    diagnostic?: (stage: HomeMonitorLifecycleStage) => void;
  }
): Promise<void> {
  if (!input.waitForConfirmation) return; // Compatibility for standalone UI-only executors.
  const report = (stage: HomeMonitorLifecycleStage) => {
    try { input.diagnostic?.(stage); } catch { /* Diagnostics must not affect a command. */ }
  };
  report("home_monitor_action_clicked");
  let completed = false;
  let failed = false;
  let failure: unknown;
  // Attach both handlers before any browser await, including fast in-click security events.
  const outcome = input.waitForConfirmation().then(
    () => { completed = true; },
    (error: unknown) => { completed = true; failed = true; failure = error; }
  );
  const timeout = Math.max(1, Math.min(input.confirmationTimeoutMs ?? 30_000, 120_000));
  const deadline = Date.now() + timeout;
  const marker = `hm-post-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const probe: ProbeInput = { marker, monitorLabels: [...input.monitorLabels],
    modeLabelGroups: input.modeLabelGroups.map((group) => [...group]), requestedGroup: input.requestedGroup };
  const controls = page as BrowserPageLike & { locator?: (selector: string) => {
    click(options: { timeout: number }): Promise<unknown>;
  } };
  let submitted = false;
  let lastKind: string | undefined;
  report("home_monitor_confirmation_waiting");
  try {
    while (!completed && Date.now() < deadline) {
      if (!submitted && page.evaluate && controls.locator) {
        const result = await page.evaluate(probeHomeMonitorPostAction, probe);
        if (completed) break;
        if (result?.kind === "submit") {
          // Set before the await: a partial click must never cause an automatic second submit.
          submitted = true;
          await controls.locator(`[data-stw-hm-post-action="${marker}"]`).click({
            timeout: Math.max(1, Math.min(2_000, deadline - Date.now()))
          });
          report("home_monitor_confirmation_submitted");
        } else if (result?.kind !== lastKind) {
          if (result?.kind === "unrecognized") report("home_monitor_post_click_dialog_unrecognized");
          if (result?.kind === "ambiguous") report("home_monitor_post_click_dialog_ambiguous");
          if (result?.kind === "disabled") report("home_monitor_post_click_dialog_disabled");
        }
        lastKind = result?.kind;
      }
      if (!completed) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([outcome, new Promise<void>((resolve) => {
            timer = setTimeout(resolve, Math.max(1, Math.min(200, deadline - Date.now())));
          })]);
        } finally { if (timer) clearTimeout(timer); }
      }
    }
    if (!completed) throw new Error("command_confirmation_timeout");
    if (failed) throw failure;
    report("home_monitor_confirmation_confirmed");
  } catch (error) {
    report(error instanceof Error && error.message === "command_confirmation_timeout"
      ? "home_monitor_confirmation_timed_out" : "home_monitor_confirmation_failed");
    throw error;
  } finally {
    await page.evaluate?.(probeHomeMonitorPostAction, { ...probe, cleanup: true }).catch(() => undefined);
  }
}
