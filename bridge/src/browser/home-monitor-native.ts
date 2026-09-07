import type { BrowserPageLike } from "./keeper-page.js";

export type NativeSecurityAction = "armAway" | "armStay" | "disarm";
type SecurityMode = "ARMED_AWAY" | "ARMED_STAY" | "DISARMED";
export type NativeSecurityStage = `home_monitor_native_${string}`;
export interface NativeSecurityInput {
  action: NativeSecurityAction;
  monitorLabels: readonly string[];
  modeLabelGroups: readonly (readonly string[])[];
  disarmForTransition?: (dispatch: () => Promise<void>) => Promise<void>;
  remainingTransitionMs?: () => number;
  diagnostic?: (stage: NativeSecurityStage) => void;
}
interface NativeProbeInput {
  marker: string;
  monitorLabels: string[];
  modeLabelGroups: string[][];
  requested: SecurityMode;
  cleanup?: boolean;
}
export interface NativeSecurityProbe {
  kind: "absent" | "pending" | "ready" | "ambiguous" | "blocked";
  state?: SecurityMode;
  target: boolean;
  attribute?: string;
}

/** The native .homecard.security structure was supplied by the user, not inferred
 * from a page-wide Home/Off match. Only a real action button receives a marker. */
export function probeNativeSecurityCard(input: NativeProbeInput): NativeSecurityProbe {
  const attr = "data-stw-hm-native";
  for (const element of document.querySelectorAll(`[${attr}]`)) {
    if (element.getAttribute(attr) === input.marker) element.removeAttribute(attr);
  }
  const empty: NativeSecurityProbe = { kind: "absent", target: false };
  if (input.cleanup) return empty;
  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0" ||
          node.hasAttribute("inert") || node.getAttribute("aria-hidden") === "true") return false;
    }
    return true;
  };
  const cards = Array.from(document.querySelectorAll("section.homecard.security")).filter(visible);
  if (!cards.length) return empty;
  if (cards.length !== 1) return { kind: "ambiguous", target: false };
  if (Array.from(document.querySelectorAll('dialog,[role="dialog"],[aria-modal="true"],[role="listbox"],[role="menu"]')).some(visible)) {
    return { kind: "blocked", target: false };
  }
  const card = cards[0]!;
  const normalize = (text: string | null) => (text ?? "").normalize("NFKC").toLowerCase()
    .replace(/[\u200b-\u200d\u2060\ufeff\s()（）:_-]+/gu, "");
  const titles = Array.from(card.querySelectorAll(":scope > h2")).filter(visible);
  const titleLabels = new Set(input.monitorLabels.map(normalize));
  if (titles.length !== 1 || !titleLabels.has(normalize(titles[0]!.textContent))) return { kind: "pending", target: false };
  const captions = Array.from(card.querySelectorAll(":scope > .status-container > .status")).filter(visible);
  if (captions.length !== 1) return { kind: "pending", target: false };
  const state = ({ systemreadytoarm: "DISARMED", systemarmedaway: "ARMED_AWAY", systemarmedstay: "ARMED_STAY" } as const)[
    normalize(captions[0]!.textContent) as "systemreadytoarm" | "systemarmedaway" | "systemarmedstay"
  ];
  if (!state) return { kind: "pending", target: false };
  const modes: readonly SecurityMode[] = ["ARMED_AWAY", "ARMED_STAY", "DISARMED"];
  const groups = input.modeLabelGroups.map((group) => new Set(group.map(normalize)));
  const modeOfAttribute = (value: string | null): SecurityMode | undefined => {
    switch (value) {
      case "ARMED_AWAY": case "AWAY": return "ARMED_AWAY";
      case "ARMED_STAY": case "STAY": return "ARMED_STAY";
      case "DISARMED": case "OFF": return "DISARMED";
      default: return undefined;
    }
  };
  const buttons = Array.from(card.querySelectorAll(":scope > .status-container > .actions > button")).filter(visible);
  const actions: { button: Element; mode: SecurityMode; attribute?: string }[] = [];
  for (const button of buttons) {
    const data = button.getAttribute("data-armstate");
    const semantic = modeOfAttribute(data);
    const label = normalize(button.textContent);
    const labelModes = modes.filter((_mode, index) => groups[index]?.has(label));
    // Existing attributes are authoritative; conflicting/unknown values never fall back to text.
    if ((data !== null && !semantic) || labelModes.length > 1 ||
        (semantic && labelModes.length === 1 && labelModes[0] !== semantic)) return { kind: "blocked", state, target: false };
    const mode = semantic ?? labelModes[0];
    if (!mode) return { kind: "pending", state, target: false };
    actions.push({ button, mode, ...(data !== null ? { attribute: data } : {}) });
  }
  if (new Set(actions.map((item) => item.mode)).size !== actions.length) return { kind: "ambiguous", state, target: false };
  const expected: SecurityMode[] = state === "DISARMED" ? ["ARMED_AWAY", "ARMED_STAY"] : ["DISARMED"];
  if (actions.length !== expected.length || !expected.every((mode) => actions.some((item) => item.mode === mode))) {
    return { kind: "pending", state, target: false };
  }
  const action = actions.find((item) => item.mode === input.requested);
  if (!action) return { kind: "ready", state, target: false };
  // A temporary disabled button may become actionable. Never force a click.
  for (let node: Element | null = action.button; node; node = node.parentElement) {
    if (node.matches(':disabled,[aria-disabled="true"],[inert]')) return { kind: "pending", state, target: false };
    if (node === card) break;
  }
  action.button.setAttribute(attr, input.marker);
  return { kind: "ready", state, target: true, ...(action.attribute ? { attribute: action.attribute } : {}) };
}

/** Returns false only when the observed native card is absent, leaving legacy
 * layouts to their existing executor. Known native cards never open captions/logos. */
export async function executeNativeSecurityAction(
  page: BrowserPageLike, input: NativeSecurityInput, probeTimeoutMs = 2_000
): Promise<boolean> {
  const browser = page as BrowserPageLike & { locator?: (selector: string) => {
    click(options: { timeout: number; trial?: boolean }): Promise<unknown>;
  } };
  if (!page.evaluate || !browser.locator) return false;
  const url = page.url();
  const marker = `hm-native-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const desired: SecurityMode = { armAway: "ARMED_AWAY", armStay: "ARMED_STAY", disarm: "DISARMED" }[input.action] as SecurityMode;
  const base = { marker, monitorLabels: [...input.monitorLabels], modeLabelGroups: input.modeLabelGroups.map((g) => [...g]) };
  const emit = (stage: NativeSecurityStage) => { try { input.diagnostic?.(stage); } catch { /* Non-fatal. */ } };
  const remaining = (cap: number) => Math.min(cap, input.remainingTransitionMs?.() ?? cap);
  const checkRoute = () => {
    if (page.isClosed() || page.url() !== url) throw new Error("command_location_mismatch");
  };
  const probe = async (requested: SecurityMode) => {
    checkRoute();
    const result = await page.evaluate!(probeNativeSecurityCard, { ...base, requested });
    if (!result || !["absent", "pending", "ready", "ambiguous", "blocked"].includes(result.kind)) return undefined;
    if (result.kind === "ambiguous") throw new Error("command_control_ambiguous");
    if (result.kind === "blocked") throw new Error("command_control_not_found");
    return result;
  };
  const delay = async (deadline: number) => {
    const ms = Math.min(75, deadline - Date.now());
    if (ms > 0) await new Promise<void>((resolve) => setTimeout(resolve, ms));
  };
  const ready = async (requested: SecurityMode, cap: number, expectedState?: SecurityMode) => {
    const deadline = Date.now() + Math.max(0, remaining(cap));
    let last: NativeSecurityProbe | undefined;
    do {
      last = await probe(requested);
      if (!last || last.kind === "absent") return last;
      if (last.kind === "ready" && (!expectedState || (last.state === expectedState && last.target))) return last;
      if (Date.now() >= deadline) break;
      await delay(deadline);
    } while (Date.now() < deadline);
    throw new Error("command_control_not_found");
  };
  const click = async (requested: SecurityMode, expectedState: SecurityMode) => {
    const deadline = Date.now() + Math.max(0, remaining(3_000));
    do {
      const observed = await ready(requested, Math.max(0, deadline - Date.now()), expectedState);
      if (!observed?.target || observed.state !== expectedState) throw new Error("command_control_not_found");
      // Re-resolve the real button, including after React replaces it. Attributes
      // come from a small enum; no untrusted text is interpolated into a selector.
      const selector = observed.attribute
        ? `section.homecard.security:visible > .status-container > .actions > button[data-armstate="${observed.attribute}"]:visible`
        : `button[data-stw-hm-native="${marker}"]`;
      const target = browser.locator!(selector);
      try {
        const ms = Math.min(500, deadline - Date.now());
        if (ms <= 0) throw new Error("preflight_deadline");
        await target.click({ trial: true, timeout: ms });
      } catch {
        // Trial has not dispatched a click; a rerender may safely be re-probed.
        if (Date.now() >= deadline) throw new Error("command_control_not_found");
        await delay(deadline);
        continue;
      }
      const current = await probe(requested);
      if (!current?.target || current.state !== expectedState || current.attribute !== observed.attribute) {
        throw new Error("command_control_not_found");
      }
      checkRoute();
      const ms = Math.min(deadline - Date.now(), remaining(3_000));
      if (ms <= 0) throw new Error("command_control_not_found");
      try { await target.click({ timeout: ms }); }
      catch { emit("home_monitor_native_click_failed"); throw new Error("command_control_not_found"); }
      // Never replay an uncertain pointer dispatch or click a second candidate.
      emit(`home_monitor_native_clicked_${requested}`);
      return;
    } while (Date.now() < deadline);
    throw new Error("command_control_not_found");
  };
  try {
    const initial = await ready(desired, Math.max(1, Math.min(probeTimeoutMs, 3_000)));
    if (!initial || initial.kind === "absent") return false;
    if (!initial.state) throw new Error("command_control_not_found");
    emit(`home_monitor_native_observed_${initial.state}`);
    if (initial.state === desired) {
      // The service still performs authoritative confirmation; this is not an optimistic result.
      emit("home_monitor_native_current_mode");
      return true;
    }
    if (desired !== "DISARMED" && initial.state !== "DISARMED") {
      if (!input.disarmForTransition) throw new Error("command_transition_confirmation_unavailable");
      emit("home_monitor_native_transition_disarming");
      await input.disarmForTransition(() => click("DISARMED", initial.state!));
      emit("home_monitor_native_transition_rearming");
      // The callback requires fresh exact-location DISARMED evidence. Wait for
      // the same page to render the two actual arming buttons, then click once.
      await click(desired, "DISARMED");
      return true;
    }
    await click(desired, initial.state);
    return true;
  } finally {
    await page.evaluate!(probeNativeSecurityCard, { ...base, requested: desired, cleanup: true }).catch(() => undefined);
  }
}
