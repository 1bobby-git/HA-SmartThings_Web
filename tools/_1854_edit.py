from pathlib import Path
root=Path('.')
def edit(path,before,after):
 p=root/path;s=p.read_text();assert s.count(before)==1,(path,before[:100],s.count(before));p.write_text(s.replace(before,after))
# Do not confuse a large device dashboard with an authentication challenge.
edit('bridge/src/browser/native-login-policy.ts','''  const all = Array.from(document.querySelectorAll<HTMLElement>("*"));
  if (all.length > 8_000) return { result: "blocked" };''','''  // A large inventory can legitimately contain tens of thousands of nodes.
  // Query only actionable controls/modal boundaries, not every device node.
  const all = Array.from(document.querySelectorAll<HTMLElement>(
    'button, a, [role="button"], [role="menuitem"], dialog[open], [role="dialog"], [aria-modal="true"], ' +
    'input[type="password"], input[autocomplete="one-time-code"], input[name="loginId"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"]'
  ));''')
edit('bridge/src/browser/native-login-policy.ts','''  for (const heading of exact(document.body, title)) {
    let parent = heading.parentElement;
    for (let level = 0; parent && parent !== document.body && level < 8; level++, parent = parent.parentElement) {
      if (exact(parent, web).length === 1 && exact(parent, keep).length === 1) {
        roots.add(parent); break;
      }
    }
  }''','''  // Inspect titles first and bound text matching to the settings dialog.
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
  }''')
# Never let a missing action/duration prevent read-only session inspection.
edit('bridge/src/browser/native-session-observer.ts','''  const known = (s: ReturnType<typeof state>) => !!s && typeof s.user === "string" &&
    typeof s.session.stayLoggedIn === "boolean" && typeof s.prefs.stayLoggedIn === "boolean" &&
    Number.isFinite(s.session.exp) && s.session.exp > 0 &&
    [7200, 28800, 86400].includes(s.prefs.sessionLength) &&
    typeof s.client.socketConnected === "boolean" && typeof s.client.socketAuthenticated === "boolean";''','''  const known = (s: ReturnType<typeof state>) => !!s && typeof s.user === "string" &&
    typeof s.session.stayLoggedIn === "boolean" && typeof s.prefs.stayLoggedIn === "boolean" &&
    (s.session.exp === undefined || (Number.isFinite(s.session.exp) && s.session.exp > 0)) &&
    typeof s.client.socketConnected === "boolean" && typeof s.client.socketAuthenticated === "boolean";
  const canRenew = (s: ReturnType<typeof state>) => known(s) && contract && !!reauthenticate && !!updateStayLoggedIn &&
    Number.isFinite(s!.session.exp) && [7200, 28800, 86400].includes(s!.prefs.sessionLength);
  const captureDiagnostic = (s: ReturnType<typeof state>) => {
    if (!locationAllowed()) return "invalid_target";
    if (ambiguous) return "capture_ambiguous";
    if (!store) return "store_missing";
    if (!s || typeof s.user !== "string") return "session_not_ready";
    if (typeof s.prefs.stayLoggedIn !== "boolean") return "preference_not_ready";
    if (typeof s.client.socketConnected !== "boolean" || typeof s.client.socketAuthenticated !== "boolean") return "socket_not_ready";
    return "session_schema_unknown";
  };''')
edit('bridge/src/browser/native-session-observer.ts','''    if (!locationAllowed() || ambiguous || !contract || !store || !reauthenticate || !updateStayLoggedIn || !known(s)) {
      return { schema: 1, available: false, busy: pendingCalls > 0 || !!nativeLease,
        outcome: "unsupported" };
    }''','''    if (!locationAllowed() || ambiguous || !store || !known(s)) {
      return { schema: 1, available: false, busy: pendingCalls > 0 || !!nativeLease,
        outcome: "unsupported", diagnostic: captureDiagnostic(s) };
    }''')
edit('bridge/src/browser/native-session-observer.ts','''      expiresInMs: Math.round(Math.max(-86400_000, Math.min(31 * 86400_000, s!.session.exp * 1000 - Date.now()))),''','''      ...(s!.session.exp === undefined ? {} : {
        expiresInMs: Math.round(Math.max(-86400_000, Math.min(31 * 86400_000, s!.session.exp * 1000 - Date.now()))) }),
      renewalSupported: canRenew(s),''')
edit('bridge/src/browser/native-session-observer.ts','''    if (!snapshot.available || !known(s)) return "unsupported";''','''    if (!snapshot.available || !canRenew(s)) return "unsupported";''')
# Safe per-export access: one not-yet-initialized getter cannot hide other exports.
edit('bridge/src/browser/native-session-observer.ts','''    try { candidates = record(exports) ? [exports, ...Object.values(exports)] : [exports]; }
    catch { return; }''','''    candidates = [exports];
    if (record(exports)) for (const key of Object.keys(exports)) {
      try { candidates.push(exports[key]); } catch { /* A cyclic ESM export may not be initialized yet. */ }
    }''')
# Capture namespaces are retained only in-page and re-observed after module initialization.
edit('bridge/src/browser/native-session-observer.ts','''  let store: Store | undefined;''','''  const namespaces: { kind: string; exports: unknown; verified: boolean }[] = [];
  let store: Store | undefined;''')
edit('bridge/src/browser/native-session-observer.ts','''  const read = () => {
    const s = refresh();''','''  const read = () => {
    // Only previously matched, naturally loaded exports. Never execute or
    // enumerate an unknown module to repair a late/cyclic initialization.
    for (const entry of namespaces) capture(entry.kind, entry.exports, entry.verified);
    const s = refresh();''')
# Avoid wrapping client again on each read. Retry absent (late) setter is already handled.
edit('bridge/src/browser/native-session-observer.ts','''  let contract = false;''','''  let contract = false;
  const inspectedClients = new WeakSet<object>();''')
edit('bridge/src/browser/native-session-observer.ts','''        const descriptor = Object.getOwnPropertyDescriptor(candidate, "reauthenticate");''','''        if (inspectedClients.has(candidate)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(candidate, "reauthenticate");''')
edit('bridge/src/browser/native-session-observer.ts','''        Object.defineProperty(candidate, "reauthenticate", { configurable: true, enumerable: true,
          get: () => wrapped, set: assign });''','''        Object.defineProperty(candidate, "reauthenticate", { configurable: true, enumerable: true,
          get: () => wrapped, set: assign });
        inspectedClients.add(candidate);''')
edit('bridge/src/browser/native-session-observer.ts','''  host[captureKey] = (kind: string, exports: unknown, verified = false) => { try { capture(kind, exports, verified === true); } catch { /* Do not break app startup. */ } };''','''  host[captureKey] = (kind: string, exports: unknown, verified = false) => {
    if (!["store", "user", "settings", "client"].includes(kind)) return;
    if (namespaces.length < 8 && !namespaces.some(entry => entry.kind === kind && entry.exports === exports)) {
      namespaces.push({ kind, exports, verified: verified === true });
    }
    try { capture(kind, exports, verified === true); } catch { /* Do not break app startup. */ }
  };''')
# Match a healthy store independent of whichever middleware happens to mention socketAuthenticated.
edit('bridge/src/browser/cake-client-capture.ts','''source.includes("serializableCheck") && source.includes("deviceHealth:") && source.includes("socketAuthenticated")''','''source.includes("serializableCheck") && source.includes("deviceHealth:") &&
          source.includes("reducer:") && source.includes("client:") && source.includes("user:")''')
# NB synthetic marker-only fixtures will be updated to actual factory signature.
# Host projection of specific capability failures; no raw DOM/identifiers exported.
edit('bridge/src/browser/native-session-maintenance.ts','''  "applied" | "unconfirmed" | "expired" | "busy" | "deferred" | "read_failed" | "reauth" | "stale";''','''  "applied" | "unconfirmed" | "expired" | "busy" | "deferred" | "read_failed" | "reauth" | "stale" |
  "observer_missing" | "store_missing" | "session_not_ready" | "preference_not_ready" |
  "socket_not_ready" | "session_schema_unknown" | "capture_ambiguous" | "invalid_target" | "renewal_unsupported";''')
edit('bridge/src/browser/native-session-maintenance.ts','''  expiresInMs: number;''','''  expiresInMs?: number;
  renewalSupported?: boolean;''')
edit('bridge/src/browser/native-session-maintenance.ts','''    if (!snapshot) return unknown();''','''    if (!snapshot) {
      const diagnostic = raw && typeof raw === "object" ? (raw as Record<string, unknown>).diagnostic : undefined;
      const reasons: NativeSessionReason[] = ["observer_missing", "store_missing", "session_not_ready", "preference_not_ready",
        "socket_not_ready", "session_schema_unknown", "capture_ambiguous", "invalid_target"];
      return unknown(reasons.includes(diagnostic as NativeSessionReason) ? diagnostic as NativeSessionReason : "unsupported");
    }''')
edit('bridge/src/browser/native-session-maintenance.ts','''      socketAuthenticated: snapshot.socketAuthenticated, remainingMs: Math.max(0, snapshot.expiresInMs),''','''      socketAuthenticated: snapshot.socketAuthenticated,
      ...(snapshot.expiresInMs === undefined ? {} : { remainingMs: Math.max(0, snapshot.expiresInMs) }),''')
edit('bridge/src/browser/native-session-maintenance.ts','''    if (snapshot.expiresInMs <= 0 || !snapshot.socketConnected''','''    const expired = snapshot.expiresInMs !== undefined && snapshot.expiresInMs <= 0;
    if (expired || !snapshot.socketConnected''')
edit('bridge/src/browser/native-session-maintenance.ts','''reason: snapshot.expiresInMs <= 0 ? "expired"''','''reason: expired ? "expired"''')
edit('bridge/src/browser/native-session-maintenance.ts','''    if (!snapshot.uiKeepSignedIn || !snapshot.sessionKeepSignedIn || snapshot.expiresInMs <= 5 * 60_000) {''','''    if (!snapshot.uiKeepSignedIn || !snapshot.sessionKeepSignedIn ||
        (snapshot.expiresInMs !== undefined && snapshot.expiresInMs <= 5 * 60_000)) {
      // Observability and authorization to invoke native renewal are distinct.
      // Never invent a duration/expiry or suppress fallback when mutation isn't supported.
      if (snapshot.renewalSupported === false) return { handled: false,
        observation: { ...observation, state: "attention", reason: "renewal_unsupported" } };''')
edit('bridge/src/browser/native-session-maintenance.ts','''  if (typeof api?.read !== "function") return undefined;''','''  if (typeof api?.read !== "function") return { schema: 1, available: false, diagnostic: "observer_missing" };''')
edit('bridge/src/browser/native-session-maintenance.ts','''      !Number.isFinite(r.expiresInMs) || Number(r.expiresInMs) < -86400_000 || Number(r.expiresInMs) > 31 * 86400_000 ||''','''      (r.expiresInMs !== undefined && (!Number.isFinite(r.expiresInMs) || Number(r.expiresInMs) < -86400_000 || Number(r.expiresInMs) > 31 * 86400_000)) ||
      (r.renewalSupported !== undefined && typeof r.renewalSupported !== "boolean") ||''')
edit('bridge/src/browser/native-session-maintenance.ts','''    socketAuthenticated: r.socketAuthenticated as boolean, expiresInMs: Number(r.expiresInMs),''','''    socketAuthenticated: r.socketAuthenticated as boolean,
    ...(r.expiresInMs === undefined ? {} : { expiresInMs: Number(r.expiresInMs) }),
    ...(typeof r.renewalSupported === "boolean" ? { renewalSupported: r.renewalSupported } : {}),''')
