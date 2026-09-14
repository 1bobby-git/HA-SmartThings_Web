from pathlib import Path
root=Path('.')
def edit(path, old, new):
    p=root/path; s=p.read_text(); assert s.count(old)==1,(path,s.count(old),old[:80]); p.write_text(s.replace(old,new))
edit('bridge/src/browser/native-login-policy.ts','| "browser_unsupported" | "invalid_target"','| "observed_enabled" | "observed_disabled"\n  | "browser_unsupported" | "invalid_target"')
edit('bridge/src/browser/native-login-policy.ts','result: "opener" | "on"','result: "opener" | "menu" | "on"')
edit('bridge/src/browser/native-login-policy.ts','/** This runs ONLY in an owned, freshly authenticated candidate tab, never the', '''/** Observe a user-opened settings dialog without interacting with the live tab.
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
    return undefined;
  } catch { return undefined; }
}

/** This runs ONLY in an owned, freshly authenticated candidate tab, never the''')
edit('bridge/src/browser/native-login-policy.ts','''    const deadline = performance.now() + timeout;
    let found: DomProbe;
    do {
      found = await probe("opener");
      if (found.result !== "missing") break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (performance.now() < deadline);
    if (found.result !== "opener") {''','''    const waitForOpener = async (menuOpened = false): Promise<DomProbe> => {
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
    if (found.result !== "opener") {''')
edit('bridge/src/browser/native-login-policy.ts','action: "opener" | "control"; marker: string; target: string;', 'action: "opener" | "control" | "read"; marker: string; target: string;')
edit('bridge/src/browser/native-login-policy.ts','const web = /^(?:SmartThings 웹|SmartThings web)$/iu;', 'const web = /^(?:SmartThings 웹|SmartThings (?:for )?web)$/iu;')
edit('bridge/src/browser/native-login-policy.ts','const keep = /^(?:로그인 유지|Keep me signed in|Keep signed in|Stay signed in|Keep me logged in)$/iu;', 'const keep = /^(?:로그인 유지|Keep me signed in|Keep signed in|Stay signed in|Stay logged in|Keep me logged in)$/iu;')
edit('bridge/src/browser/native-login-policy.ts', '''  )).map(element => element.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? element))].filter(visible);''', '''  )).map(element => {
    // Production switch: the transparent, readonly input is a state mirror;
    // the sibling button owns the actual React change handler.
    if (element.matches('input#stayLoggedIn[type="checkbox"]')) {
      const button = element.parentElement?.querySelector<HTMLElement>('button[data-testid="toggle-switch-stayLoggedIn"][role="switch"]');
      if (button) return button;
    }
    return element.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? element;
  }))].filter(visible);''')
edit('bridge/src/browser/native-login-policy.ts', '''  const mark = (element: HTMLElement, result: DomProbe): DomProbe => {
    if (element.matches''', '''  const mark = (element: HTMLElement, result: DomProbe): DomProbe => {
    if (action === "read") return result;
    if (element instanceof HTMLInputElement && element.readOnly) return { result: "blocked" };
    if (element.matches''')
edit('bridge/src/browser/native-login-policy.ts','''    return openers.length === 1 ? mark(openers[0]!, { result: "opener" }) :
      { result: openers.length > 1 ? "ambiguous" : "missing" };''','''    if (openers.length > 1) return { result: "ambiguous" };
    if (openers.length === 1) return mark(openers[0]!, { result: "opener" });
    const menus = all.filter(element => visible(element) && element.matches('button, [role="button"]') &&
      /^(?:App settings|앱 설정)$/iu.test(name(element)));
    return menus.length === 1 ? mark(menus[0]!, { result: "menu" }) :
      { result: menus.length > 1 ? "ambiguous" : "missing" };''')
edit('bridge/src/browser/native-login-policy.ts', '''  if (checked !== "true" && checked !== "false") return { result: "unknown" };
  return mark(control,''', '''  if (checked !== "true" && checked !== "false") return { result: "unknown" };
  if (control.matches('button[data-testid="toggle-switch-stayLoggedIn"]')) {
    const mirrors = root.querySelectorAll<HTMLInputElement>('input#stayLoggedIn[type="checkbox"]');
    if (mirrors.length > 1) return { result: "ambiguous" };
    // Use the live checked property, not the initial HTML checked attribute.
    if (mirrors[0] && mirrors[0].checked !== (checked === "true")) return { result: "unknown" };
  }
  return mark(control,''')
edit('bridge/src/browser/native-login-policy.ts','  const normalize = (text: string | null | undefined) =>', '''  if (action === "read" && !document.querySelector('.user-settings, #stayLoggedIn, [role="dialog"], dialog[open], [aria-modal="true"]')) return { result: "missing" };
  const normalize = (text: string | null | undefined) =>''')
edit('bridge/src/state/runtime-state.ts','"not_saved", "page_changed", "ui_timeout"].includes', '"not_saved", "page_changed", "ui_timeout", "observed_enabled", "observed_disabled"].includes')
edit('bridge/src/runtime.ts','import { ensureNativeKeepSignedIn, supportsNativeLoginPolicy,', 'import { ensureNativeKeepSignedIn, readNativeKeepSignedIn, supportsNativeLoginPolicy,')
edit('bridge/src/runtime.ts','''      reloadInventory: async () => await reconciliation.request("reload"),''','''      requestNativeLoginPolicyCheck: async () => {
        if (!nativePolicyEnabled) return "disabled";
        const manager = currentKeeperManager;
        const context = currentContext;
        const generation = activeContextGeneration;
        const keeper = manager?.currentKeeper();
        if (stopped || !manager || !context || !keeper || !status.getSnapshot().authenticated || manager.authenticationRecoveryPending()) return "unavailable";
        const observed = await readNativeKeepSignedIn(keeper);
        if (stopped || generation !== activeContextGeneration || currentContext !== context || currentKeeperManager !== manager || manager.currentKeeper() !== keeper || !status.getSnapshot().authenticated || manager.authenticationRecoveryPending()) return "unavailable";
        if (observed) {
          nativePolicyReports.set(keeper, observed);
          lastNativePolicy = observed;
          status.update({ nativeLoginPolicyState: observed.state, nativeLoginPolicyReason: observed.reason });
          return "observed";
        }
        // Coalesce clicks and leave navigation to the existing maintenance
        // transaction, which waits for commands/probes and verifies handoff.
        if (!nativePolicyCheckQueued) {
          nativePolicyCheckQueued = true;
          nativePolicyReports.delete(keeper);
          lastNativePolicy = pendingNativePolicy;
          status.update({ nativeLoginPolicyState: "pending", nativeLoginPolicyReason: "not_checked" });
          manager.requestProactiveRefresh();
        }
        return "queued";
      },
      reloadInventory: async () => await reconciliation.request("reload"),''')
edit('bridge/src/runtime.ts','''  let initialPolicyRefreshRequested = false;
''','''  let initialPolicyRefreshRequested = false;
  let nativePolicyCheckQueued = false;
''')
edit('bridge/src/runtime.ts','''      if (await manager.refreshAuthenticatedSessionIfDue() === "verified" &&''','''      const refreshOutcome = await manager.refreshAuthenticatedSessionIfDue();
      if (generation === activeContextGeneration && context === currentContext && manager === currentKeeperManager && refreshOutcome !== "skipped") {
        if (nativePolicyCheckQueued && refreshOutcome !== "verified" && lastNativePolicy.state === "pending") {
          lastNativePolicy = { state: "attention", reason: "ui_timeout" };
          status.update({ nativeLoginPolicyState: lastNativePolicy.state, nativeLoginPolicyReason: lastNativePolicy.reason });
        }
        nativePolicyCheckQueued = false;
      }
      if (refreshOutcome === "verified" &&''')
edit('bridge/src/runtime.ts','''        initialPolicyRefreshRequested = false;
        lastNativePolicy = pendingNativePolicy;''','''        initialPolicyRefreshRequested = false;
        nativePolicyCheckQueued = false;
        lastNativePolicy = pendingNativePolicy;''')
edit('bridge/src/runtime.ts','''      const keeper = await keeperManager.ensureKeeper();
      if (generation === activeContextGeneration && context === currentContext && !stopped) {''','''      const keeper = await keeperManager.ensureKeeper();
      const observedPolicy = nativePolicyEnabled && !keeperManager.authenticationRecoveryPending()
        ? await readNativeKeepSignedIn(keeper) : undefined;
      if (generation === activeContextGeneration && context === currentContext && currentKeeperManager === keeperManager && keeperManager.currentKeeper() === keeper && !stopped) {
        if (observedPolicy && !keeperManager.authenticationRecoveryPending()) {
          nativePolicyReports.set(keeper, observedPolicy);
          lastNativePolicy = observedPolicy;
        }''')
edit('bridge/src/server/http-server.ts','''    reconnectRealtime(): Promise<void>;
''','''    reconnectRealtime(): Promise<void>;
    requestNativeLoginPolicyCheck?(): Promise<"observed" | "queued" | "disabled" | "unavailable">;
''')
edit('bridge/src/server/http-server.ts','''    if (path === "/api/v1/pairing-code") {''','''    if (path === "/api/v1/native-login-policy/check") {
      if (method !== "POST") return writeError(response, 405, "method_not_allowed");
      if (!isLoopback(request.socket.remoteAddress)) return writeError(response, 403, "ingress_required");
      if (request.headers["x-stw-ui-action"] !== "native-login-policy" || request.headers["sec-fetch-site"] === "cross-site") {
        return writeError(response, 403, "same_origin_required");
      }
      if (!isJsonContentType(request.headers["content-type"])) return writeError(response, 415, "content_type_unsupported");
      const body = await readJsonBody(request, 128);
      if (!body.ok || !isRecord(body.value) || Object.keys(body.value).length) return writeError(response, 400, "invalid_request");
      if (!options.maintenance?.requestNativeLoginPolicyCheck) return writeError(response, 503, "maintenance_unavailable");
      const outcome = await options.maintenance.requestNativeLoginPolicyCheck();
      if (outcome === "unavailable") return writeError(response, 409, "browser_not_ready");
      return writeJson(response, outcome === "queued" ? 202 : 200, { outcome });
    }
    if (path === "/api/v1/pairing-code") {''')
edit('bridge/src/server/status-page.ts','''  already_enabled: "SmartThings 웹 설정이 이미 켜져 있어 변경하지 않았습니다.",''','''  already_enabled: "SmartThings 웹 설정이 이미 켜져 있어 변경하지 않았습니다.",
  observed_enabled: "현재 브릿지 브라우저에 열린 SmartThings 설정에서 로그인 유지 켜짐을 확인했습니다.",
  observed_disabled: "현재 브릿지 브라우저에 열린 SmartThings 설정에서 로그인 유지가 꺼져 있습니다.",''')
edit('bridge/src/server/status-page.ts','''settings_not_found: "SmartThings 설정 버튼을 찾지 못했습니다."''','''settings_not_found: "SmartThings 설정 메뉴를 자동으로 찾지 못했습니다. 꺼짐을 의미하지는 않습니다. 브릿지 브라우저에서 설정 창을 열고 다시 확인해 주세요."''')
edit('bridge/src/server/status-page.ts','''        <a class="hc-button hc-button-secondary" href=".">상태 다시 확인</a></div>''','''        <button class="hc-button hc-button-secondary" id="native-policy-check" type="button" aria-describedby="native-policy-check-result">상태 다시 확인</button>
        <span id="native-policy-check-result" role="status" aria-live="polite"></span></div>''')
edit('bridge/src/server/status-page.ts','''    const pairingButton = document.getElementById("pairing-button");''','''    const nativeCheck = document.getElementById("native-policy-check");
    const nativeResult = document.getElementById("native-policy-check-result");
    nativeCheck.addEventListener("click", async () => {
      nativeCheck.disabled = true;
      nativeCheck.setAttribute("aria-busy", "true");
      nativeResult.textContent = "브릿지 브라우저의 설정을 확인하고 있습니다…";
      try {
        const response = await fetch("api/v1/native-login-policy/check", {
          method: "POST", credentials: "same-origin",
          headers: { "content-type": "application/json", "x-stw-ui-action": "native-login-policy" },
          body: "{}", signal: AbortSignal.timeout(10000)
        });
        const body = await response.json();
        if (!response.ok) throw new Error("check_failed");
        if (body.outcome === "disabled") {
          nativeResult.textContent = "자동 확인이 꺼져 있습니다. 브릿지 앱의 로그인 유지 자동 적용 옵션을 확인하세요.";
          return;
        }
        if (body.outcome === "observed") { window.location.reload(); return; }
        for (let attempt = 0; attempt < 45; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          const healthResponse = await fetch("health/details", { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(5000) });
          if (!healthResponse.ok) throw new Error("check_failed");
          const health = await healthResponse.json();
          if (health.details.nativeLoginPolicyState !== "pending") { window.location.reload(); return; }
        }
        nativeResult.textContent = "확인 대기 중입니다. 진행 중인 브라우저 작업이 끝난 뒤 다시 확인해 주세요.";
      } catch {
        nativeResult.textContent = "확인하지 못했습니다. 브릿지 브라우저의 로그인 상태를 확인한 뒤 다시 시도해 주세요.";
      } finally {
        nativeCheck.disabled = false;
        nativeCheck.removeAttribute("aria-busy");
      }
    });
    const pairingButton = document.getElementById("pairing-button");''')
