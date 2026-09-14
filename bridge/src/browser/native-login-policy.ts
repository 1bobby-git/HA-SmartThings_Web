import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";
import type { BrowserPageLike } from "./keeper-page.js";

export type NativeLoginPolicyState = "disabled" | "pending" | "enabled" | "attention";
export type NativeLoginPolicyReason =
  | "not_checked" | "automation_disabled" | "already_enabled" | "enabled_and_verified"
  | "observed_enabled" | "observed_disabled" | "session_verified"
  | "browser_unsupported" | "invalid_target" | "settings_not_found" | "control_not_found"
  | "ambiguous" | "blocked" | "auth_input_present" | "challenge_present" | "other_dialog_present" | "control_disabled" | "command_busy" | "state_unknown" | "not_saved" | "page_changed" | "ui_timeout";
export interface NativeLoginPolicyReport {
  state: NativeLoginPolicyState;
  reason: NativeLoginPolicyReason;
}
export interface NativeLoginPolicyResult {
  report: NativeLoginPolicyReport;
  /** Only a clean Location document may proceed to the existing auth verifier. */
  clean: boolean;
}

type SettingsPage = BrowserPageLike & Pick<Page, "locator">;
type DomProbe = { result: "clear" | "opener" | "menu" | "on" | "off" | "missing" | "ambiguous" | "blocked" | "unknown"; native?: boolean; reason?: NativeLoginPolicyReason; settingsOpen?: boolean };
const MARKER = "data-stw-login-policy";

export function supportsNativeLoginPolicy(page: BrowserPageLike): page is SettingsPage {
  return typeof (page as Partial<SettingsPage>).locator === "function" && typeof page.evaluate === "function";
}

export function nativeLoginTarget(url: string): boolean {
  try {
    const value = new URL(url);
    return value.origin === "https://my.smartthings.com" && /^\/location\/[^/]+\/?$/u.test(value.pathname) &&
      !value.search && !value.hash && !value.username && !value.password;
  } catch { return false; }
}

/** Observe a user-opened settings dialog without interacting with the live tab.
 * An observed preference is not authentication or reload-persistence proof.
 * Only enum values leave the browser; no account text or storage is returned.
 */
export async function readNativeKeepSignedIn(page: BrowserPageLike): Promise<NativeLoginPolicyReport | undefined> {
  const target = page.url();
  if (!page.evaluate || page.isClosed() || !nativeLoginTarget(target)) return undefined;
  try {
    const probe = await bounded(page.evaluate(inspectLoginSettingsDom, { action: "read", marker: "", target }), 1_500);
    if (page.isClosed() || page.url() !== target) return undefined;
    if (probe.result === "on") return { state: "enabled", reason: "observed_enabled" };
    if (probe.result === "off") return { state: "attention", reason: "observed_disabled" };
    if (probe.result === "unknown") return { state: "attention", reason: "state_unknown" };
    if (probe.result === "ambiguous") return { state: "attention", reason: "ambiguous" };
  } catch { /* Try read-only application preference below. */ }
  // UI preference is readable independently of the effective session schema.
  // This never dispatches, clicks, navigates, or labels a session as verified.
  if (!page.evaluate || page.isClosed() || page.url() !== target) return undefined;
  try {
    const value = await bounded(page.evaluate(({ target }) => {
      if (location.href !== target || location.origin !== "https://my.smartthings.com") return undefined;
      const api = (window as unknown as Record<symbol, {read(): Record<string, unknown>}>)[Symbol.for("smartthings_web_bridge.native_session")];
      const s = typeof api?.read === "function" ? api.read() : undefined;
      return s?.schema === 1 && typeof s.uiKeepSignedIn === "boolean" ? s.uiKeepSignedIn : undefined;
    }, { target }), 1_500);
    if (page.isClosed() || page.url() !== target) return undefined;
    if (typeof value === "boolean") return { state: value ? "enabled" : "attention",
      reason: value ? "observed_enabled" : "observed_disabled" };
  } catch { /* Observation is optional and must not interrupt the live tab. */ }
  return undefined;
}

/** This runs ONLY in an owned, freshly authenticated candidate tab, never the
 * active keeper. Use the site's labelled UI and its real change handler; never
 * invent a storage key, change cookie expiry, select a session duration, or
 * enable Support access. Unknown/ambiguous layouts are not clicked.
 */
export async function ensureNativeKeepSignedIn(
  page: BrowserPageLike,
  target: string,
  options: { enabled: boolean; canContinue?: () => boolean; timeoutMs?: number }
): Promise<NativeLoginPolicyResult> {
  const report = (state: NativeLoginPolicyState, reason: NativeLoginPolicyReason, clean = true): NativeLoginPolicyResult =>
    ({ report: { state, reason }, clean });
  if (!options.enabled) return report("disabled", "automation_disabled");
  if (!nativeLoginTarget(target) || page.url() !== target || page.isClosed()) return report("attention", "invalid_target", false);
  if (!supportsNativeLoginPolicy(page)) return report("attention", "browser_unsupported");
  let settingsOpen = false;
  try {
    const guard = await bounded(page.evaluate!(inspectLoginSettingsDom, { action: "guard", marker: "", target }), 1_500);
    settingsOpen = guard.settingsOpen === true;
    if (guard.result === "blocked" || guard.result === "ambiguous") return report("attention", guard.reason ?? (guard.result === "ambiguous" ? "ambiguous" : "blocked"), false);
  } catch { return report("attention", "ui_timeout", false); }
  const existingPreference = await readNativeKeepSignedIn(page);
  if (page.isClosed() || page.url() !== target) return report("attention", "page_changed", false);
  if (!(options.canContinue?.() ?? true)) return report("attention", "command_busy", false);
  // Already ON is read-only evidence of a preference, not of server expiry
  // extension or persistence after restart. Do not reload it just to re-read.
  // The caller still verifies the candidate's application authentication.
  if (existingPreference?.state === "enabled") return { report: existingPreference, clean: !settingsOpen };
  const marker = randomUUID();
  const selector = `[${MARKER}="${marker}"]`;
  const timeout = Math.max(100, Math.min(5_000, options.timeoutMs ?? 3_000));
  const valid = () => !page.isClosed() && page.url() === target && (options.canContinue?.() ?? true);
  const focusOwnedPage = async () => {
    if (!valid()) throw new Error("page_changed");
    // Headed Chromium can suspend animation frames in a background tab.
    // Activate only this owned candidate; do not force past actionability.
    if (page.bringToFront) await bounded(page.bringToFront(), timeout);
    if (!valid()) throw new Error("page_changed");
  };
  let touchedUi = false;
  let unresolvedExistingUi = false;
  let reason: NativeLoginPolicyReason = "ui_timeout";
  let confirmed = false;
  const probe = async (action: "opener" | "control"): Promise<DomProbe> => {
    if (!valid()) throw new Error("page_changed");
    return await bounded(page.evaluate!(inspectLoginSettingsDom, { action, marker, target }), timeout);
  };
  const waitForControl = async (desired?: "on"): Promise<DomProbe> => {
    const deadline = performance.now() + timeout;
    let state: DomProbe;
    do {
      state = await probe("control");
      if (state.result !== "missing" && (desired === undefined || state.result !== "off")) return state;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (performance.now() < deadline);
    return state;
  };
  const open = async (): Promise<DomProbe> => {
    // A settings dialog already open in our own candidate is acceptable, but
    // any other modal/challenge prevents opening or changing anything.
    const existing = await probe("control");
    if (existing.result !== "missing") {
      unresolvedExistingUi = ["blocked", "ambiguous", "unknown"].includes(existing.result);
      return existing;
    }
    const waitForOpener = async (menuOpened = false): Promise<DomProbe> => {
      const deadline = performance.now() + timeout;
      let found: DomProbe;
      do {
        found = await probe("opener");
        if (found.result !== "missing" && !(menuOpened && found.result === "menu")) return found;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (performance.now() < deadline);
      return { result: "missing" };
    };
    let found = await waitForOpener();
    if (found.result === "menu") {
      // Production Location UI: App settings opens a menu; Settings opens the
      // user-settings modal. Never guess Manage location / Support / Logout.
      touchedUi = true;
      await focusOwnedPage();
      await page.locator(selector).click({ timeout });
      found = await waitForOpener(true);
    }
    if (found.result !== "opener") {
      reason = found.result === "missing" ? "settings_not_found" : found.result === "ambiguous" ? "ambiguous" : found.reason ?? "blocked";
      return found;
    }
    if (!valid()) throw new Error("page_changed");
    touchedUi = true;
    await focusOwnedPage();
    await page.locator(selector).click({ timeout });
    return await waitForControl();
  };
  const waitForNativeApplication = async () => {
    // Optimistic ON is not server application. Do not reload our candidate
    // while the site's native authenticate callback is still outstanding.
    // Unknown app versions retain DOM-only verification without claiming
    // that the effective session was verified.
    const until = performance.now() + 35_000;
    do {
      if (!valid()) throw new Error("page_changed");
      const result = await bounded(page.evaluate!(({ target }) => {
        if (location.href !== target) return "changed";
        const api = (window as unknown as Record<symbol, {read(): Record<string, unknown>}>)[Symbol.for("smartthings_web_bridge.native_session")];
        if (typeof api?.read !== "function") return "unsupported";
        const state = api.read();
        if (state?.schema !== 1 || state.available !== true) return "unsupported";
        if (state.outcome === "unconfirmed" || state.outcome === "stale") return "failed";
        return !state.busy && state.uiKeepSignedIn === true && state.sessionKeepSignedIn === true &&
          state.socketConnected === true && state.socketAuthenticated === true ? "applied" : "pending";
      }, { target }), 1_500);
      if (result === "unsupported" || result === "applied") return;
      if (result === "failed" || result === "changed") throw new Error("native_apply_failed");
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (performance.now() < until);
    throw new Error("native_apply_timeout");
  };
  const reload = async () => {
    if (!valid()) throw new Error("page_changed");
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 10_000 });
    if (!valid()) throw new Error("page_changed");
  };
  try {
    let state = await open();
    if (state.result === "on") {
      await reload();
      state = await open();
      confirmed = state.result === "on";
      reason = confirmed ? "already_enabled" : "not_saved";
    } else if (state.result === "off") {
      // Re-resolve just before interacting. setChecked(true) is idempotent;
      // custom ARIA switches get one click only after a second explicit OFF.
      await focusOwnedPage();
      state = await probe("control");
      if (state.result === "off") {
        if (!valid()) throw new Error("page_changed");
        touchedUi = true;
        if (state.native) await page.locator(selector).setChecked(true, { timeout });
        else await page.locator(`${selector}[aria-checked="false"]`).click({ timeout });
      } else if (state.result !== "on") throw new Error("page_changed");
      state = await waitForControl("on");
      if (state.result === "on") {
        await waitForNativeApplication();
        await reload();
        state = await open();
        confirmed = state.result === "on";
      }
      reason = confirmed ? "enabled_and_verified" : "not_saved";
    } else if (reason === "ui_timeout") {
      reason = state.result === "ambiguous" ? "ambiguous" : state.result === "blocked" ? state.reason ?? "blocked" :
        state.result === "unknown" ? "state_unknown" : "control_not_found";
    }
    // A pre-existing challenge or ambiguous modal was not opened by us.
    // Do not dismiss it, or promote its document merely because a background
    // Location read still works. The caller preserves the live keeper.
    if (unresolvedExistingUi) return report("attention", reason, false);
    // Close only our own UI by loading the original Location. Do not guess a
    // close/backdrop control, send Escape to another modal, or press Logout.
    if (touchedUi || confirmed) await reload();
    if (!valid()) return report("attention", "page_changed", false);
    return report(confirmed ? "enabled" : "attention", reason);
  } catch {
    // A timed-out/changed document must never become the live keeper. The
    // caller owns this candidate and will close it, leaving the keeper intact.
    return report("attention", page.isClosed() || page.url() !== target ? "page_changed" :
      !(options.canContinue?.() ?? true) ? "command_busy" : "ui_timeout", false);
  }
}

async function bounded<T>(operation: Promise<T>, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("ui_timeout")), timeout);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** No text, input values, URLs, account IDs, DOM or credentials leave the page.
 * The temporary marker identifies the exact inspected element for a trusted
 * Playwright click, not a coordinate or a guessed switch position.
 */
function inspectLoginSettingsDom({ action, marker, target }: {
  action: "opener" | "control" | "read" | "guard"; marker: string; target: string;
}): DomProbe {
  if (location.href !== target || location.origin !== "https://my.smartthings.com") return { result: "blocked" };
  if (action === "read" && !document.querySelector('.user-settings, #stayLoggedIn, [role="dialog"], dialog[open], [aria-modal="true"]')) return { result: "missing" };
  const normalize = (text: string | null | undefined) => (text ?? "").replace(/\s+/gu, " ").trim();
  const visible = (element: Element): boolean => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 &&
      (typeof element.checkVisibility !== "function" || element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) &&
      style.display !== "none" && style.visibility !== "hidden" &&
      !element.closest('[hidden], [inert], [aria-hidden="true"]');
  };
  // A large inventory can legitimately contain tens of thousands of nodes.
  // Query only actionable controls/modal boundaries, not every device node.
  const all = Array.from(document.querySelectorAll<HTMLElement>(
    'button, a, [role="button"], [role="menuitem"], dialog[open], [role="dialog"], [aria-modal="true"], ' +
    'input[type="password"], input[autocomplete="one-time-code"], input[name="loginId"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"]'
  ));
  const exact = (root: Element, pattern: RegExp) => Array.from(root.querySelectorAll<HTMLElement>("*"))
    .filter(element => visible(element) && pattern.test(normalize(element.textContent)) &&
      !Array.from(element.children).some(child => pattern.test(normalize(child.textContent))));
  const title = /^(?:SmartThings 설정|SmartThings settings)$/iu;
  const web = /^(?:SmartThings 웹|SmartThings (?:for )?web)$/iu;
  const keep = /^(?:로그인 유지|Keep me signed in|Keep signed in|Stay signed in|Stay logged in|Keep me logged in)$/iu;
  const controls = (root: Element) => [...new Set(Array.from(root.querySelectorAll<HTMLElement>(
    'input[type="checkbox"], [role="switch"], [role="checkbox"]'
  )).map(element => {
    // Production switch: the transparent, readonly input is a state mirror;
    // the sibling button owns the actual React change handler.
    if (element.matches('input#stayLoggedIn[type="checkbox"]')) {
      const button = element.parentElement?.querySelector<HTMLElement>('button[data-testid="toggle-switch-stayLoggedIn"][role="switch"]');
      if (button) return button;
    }
    return element.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? element;
  }))].filter(visible);
  const name = (element: HTMLElement) => {
    const refs = element.getAttribute("aria-labelledby");
    if (refs) return normalize(refs.split(/\s+/u).map(id => document.getElementById(id)?.textContent ?? "").join(" "));
    return normalize(element.getAttribute("aria-label") ?? element.getAttribute("title") ?? element.textContent);
  };
  if (all.some(element => visible(element) && element.matches(
    'input[type="password"], input[autocomplete="one-time-code"], input[name="loginId"]'
  ))) return { result: "blocked", reason: "auth_input_present" };
  if (all.some(element => visible(element) && element.matches('iframe[src*="recaptcha"], iframe[src*="hcaptcha"]')))
    return { result: "blocked", reason: "challenge_present" };
  const roots = new Set<Element>();
  // Inspect titles first and bound text matching to the settings dialog.
  // The inventory behind the modal must never exhaust the settings budget.
  const headings = Array.from(document.querySelectorAll<HTMLElement>('h1, h2, h3, [role="heading"], .modal-header'))
    .filter(element => visible(element) && title.test(normalize(element.textContent)));
  for (const heading of headings) {
    const boundary = heading.closest('dialog, [role="dialog"], [aria-modal="true"], .user-settings, .modal, aside');
    let parent = heading.parentElement;
    for (let level = 0; parent && parent !== document.body && level < 8; level++, parent = parent.parentElement) {
      if (parent.querySelectorAll('*').length > 2_000) break;
      if (exact(parent, web).length === 1 && exact(parent, keep).length === 1) {
        roots.add(parent); break;
      }
      if (parent === boundary) break;
    }
  }
  const modals = all.filter(element => visible(element) && element.matches('dialog[open], [role="dialog"], [aria-modal="true"]'));
  if (roots.size > 1) return { result: "ambiguous" };
  const root = [...roots][0];
  if (modals.some(modal => !root || (!modal.contains(root) && !root.contains(modal)))) return { result: "blocked", reason: "other_dialog_present" };
  if (action === "guard") return { result: "clear", settingsOpen: !!root };
  const mark = (element: HTMLElement, result: DomProbe): DomProbe => {
    if (action === "read") return result;
    if (element instanceof HTMLInputElement && element.readOnly) return { result: "blocked", reason: "control_disabled" };
    if (element.matches(':disabled, [aria-disabled="true"]') || element.closest('[aria-disabled="true"], [inert]')) return { result: "blocked", reason: "control_disabled" };
    for (const prior of document.querySelectorAll('[data-stw-login-policy]')) prior.removeAttribute("data-stw-login-policy");
    element.setAttribute("data-stw-login-policy", marker);
    return result;
  };
  if (action === "opener") {
    if (root) return { result: "blocked" };
    const openers = all.filter(element => visible(element) && element.matches('button, [role="button"], a') &&
      /^(?:SmartThings settings|SmartThings 설정|Settings|설정)$/iu.test(name(element)) &&
      // Never follow the Samsung account or another external settings link.
      (!element.matches("a[href]") || (() => {
        try { const url = new URL(element.getAttribute("href")!, location.href); return url.origin === location.origin && url.pathname === location.pathname; }
        catch { return false; }
      })()));
    if (openers.length > 1) return { result: "ambiguous" };
    if (openers.length === 1) return mark(openers[0]!, { result: "opener" });
    const menus = all.filter(element => visible(element) && element.matches('button, [role="button"]') &&
      /^(?:App settings|앱 설정)$/iu.test(name(element)));
    return menus.length === 1 ? mark(menus[0]!, { result: "menu" }) :
      { result: menus.length > 1 ? "ambiguous" : "missing" };
  }
  if (!root) return { result: "missing" };
  const labels = exact(root, keep);
  const matches = new Set<HTMLElement>();
  for (const control of controls(root)) {
    if (keep.test(name(control))) matches.add(control);
    if (control instanceof HTMLInputElement && Array.from(control.labels ?? []).some(label =>
      keep.test(normalize(label.textContent)) || labels.some(text => label.contains(text)))) matches.add(control);
  }
  // Screenshot-compatible unlabelled switches: accept only a small row with
  // the exact Keep-signed-in label and ONE switch, not the whole settings card.
  if (matches.size === 0) for (const label of labels) {
    let row: Element | null = label.parentElement;
    for (let level = 0; row && root.contains(row) && level < 5; level++, row = row.parentElement) {
      const list = controls(row);
      if (list.length > 1) break;
      if (list.length === 1 && !exact(row, /^(?:Account data access|계정 데이터 액세스|계정 데이터 접근)$/iu).length) {
        const candidate = list[0]!;
        const explicit = candidate.getAttribute("aria-label") || candidate.getAttribute("aria-labelledby") || candidate.getAttribute("title");
        if (explicit && !keep.test(name(candidate))) break;
        matches.add(candidate); break;
      }
    }
  }
  if (matches.size !== 1) return { result: matches.size > 1 ? "ambiguous" : "missing" };
  const control = [...matches][0]!;
  if (control instanceof HTMLInputElement) return mark(control, { result: control.checked ? "on" : "off", native: true });
  const checked = control.getAttribute("aria-checked");
  if (checked !== "true" && checked !== "false") return { result: "unknown" };
  if (control.matches('button[data-testid="toggle-switch-stayLoggedIn"]')) {
    const mirrors = root.querySelectorAll<HTMLInputElement>('input#stayLoggedIn[type="checkbox"]');
    if (mirrors.length > 1) return { result: "ambiguous" };
    // Use the live checked property, not the initial HTML checked attribute.
    if (mirrors[0] && mirrors[0].checked !== (checked === "true")) return { result: "unknown" };
  }
  return mark(control, { result: checked === "true" ? "on" : "off", native: false });
}
