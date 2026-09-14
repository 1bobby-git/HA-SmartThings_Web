/** In-page adapter for the naturally initialized SmartThings Web application.
 * Source contract: Web 2.57.0 user/reauthenticate and updateStayLoggedIn actions.
 * No module IDs, token extraction, independent auth client, cookie/storage
 * writes or fabricated authentication state. All account data stays in-page.
 */
export function installNativeSessionObserver(): void {
  const host = window as unknown as Record<PropertyKey, any>;
  const apiKey = Symbol.for("smartthings_web_bridge.native_session");
  if (host[apiKey]) return;
  type Store = { getState(): any; dispatch(action: unknown): unknown };
  type Action = ((value: unknown) => unknown) & { typePrefix?: string };
  let store: Store | undefined;
  let reauthenticate: Action | undefined;
  let updateStayLoggedIn: Action | undefined;
  let contract = false;
  let ambiguous = false;
  const instance = crypto.randomUUID();
  let revision = 0;
  let previousSession: unknown;
  let epoch = 0;
  let pendingCalls = 0;
  let nativeLease: { session: unknown; until: number } | undefined;
  let operation: { session: unknown; user: unknown; url: string; exp: number; epoch: number; until: number } | undefined;
  let outcome = "idle";
  let observedAt = 0;
  let completedAt = 0;
  let unconfirmedSession: unknown;
  let lastAttemptAt = -Infinity;
  const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
  const locationAllowed = () => location.origin === "https://my.smartthings.com" &&
    /^\/location\/[^/]+\/?$/.test(location.pathname) && !location.search && !location.hash;
  const state = () => {
    try {
      const root = store?.getState();
      const user = root?.user?.user;
      const session = user?.session;
      const prefs = root?.ui?.settings?.user;
      if (!record(session) || !record(prefs) || !record(root?.client)) return undefined;
      return { user: user.uuid, session, prefs, client: root.client,
        storage: root.ui.cookieConsent?.functionality_settings };
    } catch { return undefined; }
  };
  const known = (s: ReturnType<typeof state>) => !!s && typeof s.user === "string" &&
    typeof s.session.stayLoggedIn === "boolean" && typeof s.prefs.stayLoggedIn === "boolean" &&
    Number.isFinite(s.session.exp) && s.session.exp > 0 &&
    [7200, 28800, 86400].includes(s.prefs.sessionLength) &&
    typeof s.client.socketConnected === "boolean" && typeof s.client.socketAuthenticated === "boolean";
  const visible = (e: Element) => e.getClientRects().length > 0 &&
    getComputedStyle(e).visibility !== "hidden" && !e.closest('[hidden],[inert],[aria-hidden="true"]');
  const userInteracting = () => Array.from(document.querySelectorAll(
    'dialog[open],[role="dialog"],[aria-modal="true"],input[type="password"],input[autocomplete="one-time-code"]'
  )).some(visible);
  const refresh = () => {
    const s = state();
    const now = performance.now();
    if (s?.session !== previousSession) { previousSession = s?.session; revision++; }
    if (nativeLease && pendingCalls === 0 && (s?.session !== nativeLease.session || now >= nativeLease.until)) nativeLease = undefined;
    if (operation) {
      if (!locationAllowed() || location.href !== operation.url || !s || s.user !== operation.user) {
        outcome = "stale"; operation = undefined;
      } else if (known(s) && s.session !== operation.session && epoch >= operation.epoch &&
          s.client.socketConnected && s.client.socketAuthenticated && s.session.stayLoggedIn &&
          s.prefs.stayLoggedIn && s.session.exp * 1000 > Date.now() && !nativeLease && pendingCalls === 0) {
        outcome = s.session.exp > operation.exp ? "renewed" : "applied";
        completedAt = now;
        operation = undefined;
      } else if (now >= operation.until) {
        // The native Promise may resolve even on HTTP 401 or before the
        // authenticate callback. No new session evidence means no success.
        outcome = "unconfirmed"; unconfirmedSession = s?.session; operation = undefined;
      }
    }
    // A later native callback can recover after our bounded attempt. Reset
    // only when the actual session object changes; the host still requires a
    // fresh protected read and never labels this as a confirmed extension.
    if (outcome === "unconfirmed" && unconfirmedSession && s?.session !== unconfirmedSession &&
        known(s) && !pendingCalls && !nativeLease && s!.session.stayLoggedIn &&
        s!.client.socketAuthenticated && s!.session.exp * 1000 > Date.now()) {
      outcome = "idle"; unconfirmedSession = undefined;
    }
    return s;
  };
  const read = () => {
    const s = refresh();
    if (!locationAllowed() || ambiguous || !contract || !store || !reauthenticate || !updateStayLoggedIn || !known(s)) {
      return { schema: 1, available: false, busy: pendingCalls > 0 || !!nativeLease,
        outcome: "unsupported" };
    }
    observedAt = performance.now();
    return { schema: 1, available: true, instance, revision, uiKeepSignedIn: s!.prefs.stayLoggedIn,
      sessionKeepSignedIn: s!.session.stayLoggedIn,
      expiresInMs: Math.round(Math.max(-86400_000, Math.min(31 * 86400_000, s!.session.exp * 1000 - Date.now()))),
      socketConnected: s!.client.socketConnected, socketAuthenticated: s!.client.socketAuthenticated,
      ...(typeof s!.storage === "boolean" ? { storageAllowed: s!.storage } : {}),
      busy: pendingCalls > 0 || !!nativeLease || !!operation,
      busyAgeMs: nativeLease ? Math.max(0, Math.round(performance.now() - nativeLease.until + 35_000)) : 0,
      outcome, completionAgeMs: completedAt ? Math.round(observedAt - completedAt) : undefined };
  };
  const begin = (enable: boolean) => {
    const snapshot = read();
    const s = state();
    if (!snapshot.available || !known(s)) return "unsupported";
    if (snapshot.busy) return "busy";
    if (!enable) return "disabled";
    // Stay on the current authenticated page; never work around a login,
    // challenge, settings dialog, unknown state, or a server-expired session.
    if (!s!.client.socketConnected || !s!.client.socketAuthenticated ||
        s!.session.exp * 1000 <= Date.now() || userInteracting()) return "blocked";
    const needsSetting = !s!.prefs.stayLoggedIn || !s!.session.stayLoggedIn;
    const needsExtension = s!.session.exp * 1000 - Date.now() <= 5 * 60_000;
    if (!needsSetting && !needsExtension) return "healthy";
    if (performance.now() - lastAttemptAt < 120_000) return "backoff";
    lastAttemptAt = performance.now();
    operation = { session: s!.session, user: s!.user, url: location.href, exp: s!.session.exp,
      epoch: epoch + 1, until: performance.now() + 35_000 };
    outcome = "requested";
    try {
      // Use the site's real action and its native handler, never assign Redux
      // state or a checkbox value. UI=ON/session=OFF retries native auth without
      // toggling OFF. extend=true is the existing session-extension action.
      const action = !s!.prefs.stayLoggedIn
        ? updateStayLoggedIn!({ enabled: true })
        : reauthenticate!({ extend: needsExtension });
      const dispatched = store!.dispatch(action);
      // Observe rejection only. A fulfilled thunk is NOT an auth proof.
      Promise.resolve(dispatched).catch(() => {
        if (operation) { outcome = "unconfirmed"; operation = undefined; }
      });
      return "requested";
    } catch {
      operation = undefined; outcome = "unconfirmed"; return "unconfirmed";
    }
  };
  function capture(kind: string, exports: unknown, authFactoryVerified = false): void {
    let candidates: unknown[];
    try { candidates = record(exports) ? [exports, ...Object.values(exports)] : [exports]; }
    catch { return; }
    for (const candidate of candidates) {
      if (kind === "store" && record(candidate) && typeof candidate.getState === "function" &&
          typeof candidate.dispatch === "function" && typeof candidate.subscribe === "function") {
        if (store && store !== candidate) { ambiguous = true; continue; }
        store = candidate as Store;
      } else if ((kind === "user" || kind === "settings") && typeof candidate === "function") {
        const action = candidate as Action;
        if (action.typePrefix === "user/reauthenticate") reauthenticate = action;
        if (action.typePrefix === "ui.slice.actions/updateStayLoggedIn") updateStayLoggedIn = action;
      } else if (kind === "client" && record(candidate) && typeof candidate.service === "function") {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, "reauthenticate");
        if (descriptor && (!descriptor.configurable || descriptor.get || descriptor.set)) continue;
        let wrapped: unknown;
        const assign = (original: unknown) => {
          if (typeof original !== "function") { wrapped = original; contract = false; return; }
          const source = Function.prototype.toString.call(original);
          const inlineContract = source.includes('"api/auth"') && source.includes("stayLoggedIn") && source.includes("sessionLength");
          // Observed Web 2.57.0: function(t){return e.apply(this,arguments)}.
          // Accept that delegate only with the independently matched factory;
          // arbitrary methods or an unverified generic wrapper remain unknown.
          const compiledDelegate = authFactoryVerified && /^function(?:\s+[$\w]+)?\s*\(\s*[$\w]+\s*\)\s*\{\s*return\s+[$\w]+\.apply\(\s*this\s*,\s*arguments\s*\)\s*;?\s*\}$/.test(source);
          if (!inlineContract && !compiledDelegate) {
            wrapped = original; contract = false; return;
          }
          contract = true;
          wrapped = function(this: unknown, ...args: unknown[]) {
            epoch++;
            nativeLease = { session: state()?.session, until: performance.now() + 35_000 };
            pendingCalls++;
            let result: unknown;
            try { result = Reflect.apply(original, this, args); }
            catch (error) { pendingCalls--; throw error; }
            Promise.resolve(result).then(() => { pendingCalls--; refresh(); }, () => { pendingCalls--; refresh(); });
            return result;
          };
        };
        assign(descriptor?.value);
        Object.defineProperty(candidate, "reauthenticate", { configurable: true, enumerable: true,
          get: () => wrapped, set: assign });
      }
    }
  }
  Object.defineProperty(host, apiKey, { configurable: true, value: Object.freeze({ read, begin }) });
  const captureKey = Symbol.for("smartthings_web_bridge.native_session_capture");
  host[captureKey] = (kind: string, exports: unknown, verified = false) => { try { capture(kind, exports, verified === true); } catch { /* Do not break app startup. */ } };
  const queueKey = Symbol.for("smartthings_web_bridge.native_session_modules");
  for (const entry of (host[queueKey] ?? [])) host[captureKey](entry[0], entry[1], entry[2]);
  delete host[queueKey];
}
