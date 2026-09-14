from pathlib import Path
import re


def replace(path, before, after):
    p = Path(path)
    text = p.read_text()
    assert text.count(before) == 1, (path, before[:100], text.count(before))
    p.write_text(text.replace(before, after))

p = Path('bridge/src/browser/native-login-policy.ts')
s = p.read_text()
s = s[:s.index('/** No text, input values, URLs, account IDs, DOM or credentials leave the page.')]
s = s.replace('import { randomUUID }', 'import { inspectLoginSettingsDom, type LoginSettingsProbe as DomProbe } from "./native-login-settings-dom.js";\nimport { randomUUID }', 1)
s = re.sub(r'^type DomProbe = .*\n', '', s, flags=re.M)
s = s.replace('"settings_not_found" | "control_not_found"', '"settings_not_found" | "control_not_found" | "setting_disabled"')
s = s.replace('action: "opener" | "control"', 'action: "opener" | "menu" | "control"')
s = s.replace('Math.min(5_000, options.timeoutMs ?? 3_000)', 'Math.min(8_000, options.timeoutMs ?? 5_000)')
s = s.replace('    let found: DomProbe;\n    do {', '    let found: DomProbe;\n    let openedMenu = false;\n    do {', 1)
s = s.replace('      if (found.result !== "missing") break;\n      await new Promise', '''      if (found.result !== "missing") break;
      if (!openedMenu) {
        const menu = await probe("menu");
        if (menu.result === "menu") {
          // Only a uniquely named global navigation menu, never a device menu.
          await focusOwnedPage();
          touchedUi = true;
          openedMenu = true;
          await page.locator(selector).click({ timeout });
        } else if (menu.result !== "missing") { found = menu; break; }
      }
      await new Promise''', 1)
s += '''/** Read an already visible native setting without opening, closing, clicking,
 * marking the DOM, reloading, or changing a user's browser. Hidden settings are
 * unknown, not OFF. This supports manual noVNC changes on the live keeper.
 */
export async function readVisibleNativeLoginPolicy(page: BrowserPageLike): Promise<DomProbe> {
  const target = page.url();
  if (page.isClosed() || !nativeLoginTarget(target) || !supportsNativeLoginPolicy(page)) return { result: "missing" };
  try {
    const observation = await bounded(page.evaluate!(inspectLoginSettingsDom, { action: "control", marker: "", target }), 1_000);
    return page.isClosed() || page.url() !== target ? { result: "blocked" } : observation;
  } catch { return { result: "unknown" }; }
}
'''
p.write_text(s)

# The runtime only publishes observed ON/OFF from the current authenticated page.
replace('bridge/src/runtime.ts', 'import { ensureNativeKeepSignedIn, supportsNativeLoginPolicy,', 'import { ensureNativeKeepSignedIn, readVisibleNativeLoginPolicy, supportsNativeLoginPolicy,')
replace('bridge/src/runtime.ts', '  let initialPolicyRefreshRequested = false;', '  let initialPolicyRefreshRequested = false;\n  let nextNativePolicyObservationAtMs = 0;')
replace('bridge/src/runtime.ts', '      reloadInventory: async () => await reconciliation.request("reload"),', '      checkNativeLoginPolicy: async () => requestNativeLoginPolicyCheck(),\n      reloadInventory: async () => await reconciliation.request("reload"),')
replace('bridge/src/runtime.ts', '      await reconcileActiveKeeper();\n      if (stopped) return;', '      await reconcileActiveKeeper();\n      await observeVisibleNativeLoginPolicy();\n      if (stopped) return;')
replace('bridge/src/runtime.ts', '      if (await manager.refreshAuthenticatedSessionIfDue() === "verified" &&', '      const refreshOutcome = await manager.refreshAuthenticatedSessionIfDue();\n      if (refreshOutcome !== "skipped" && refreshOutcome !== "verified" && !stopped && manager === currentKeeperManager && context === currentContext && lastNativePolicy.state === "pending") {\n        lastNativePolicy = { state: "attention", reason: "page_changed" };\n        status.update({ nativeLoginPolicyState: "attention", nativeLoginPolicyReason: "page_changed" });\n      }\n      if (refreshOutcome === "verified" &&')
replace('bridge/src/runtime.ts', '        initialPolicyRefreshRequested = false;', '        initialPolicyRefreshRequested = false;\n        nextNativePolicyObservationAtMs = 0;')
replace('bridge/src/runtime.ts', '  const touchAuthenticatedSessionIfDue = async () => {', '''  const observeVisibleNativeLoginPolicy = async (force = false) => {
    const manager = currentKeeperManager;
    const context = currentContext;
    const keeper = manager?.currentKeeper();
    const snapshot = status.getSnapshot();
    if (stopped || !manager || !context || !keeper || !snapshot.authenticated ||
        manager.authenticationRecoveryPending() || !supportsNativeLoginPolicy(keeper)) return "missing" as const;
    if (!force && performance.now() < nextNativePolicyObservationAtMs) return "missing" as const;
    nextNativePolicyObservationAtMs = performance.now() + 10_000;
    const url = keeper.url();
    const observed = await readVisibleNativeLoginPolicy(keeper);
    if (stopped || context !== currentContext || manager !== currentKeeperManager ||
        keeper !== manager.currentKeeper() || keeper.isClosed() || keeper.url() !== url ||
        !status.getSnapshot().authenticated || manager.authenticationRecoveryPending()) return "blocked" as const;
    if (observed.result === "on" || observed.result === "off") {
      const policy: NativeLoginPolicyReport = observed.result === "on"
        ? { state: "enabled", reason: "already_enabled" }
        : { state: "attention", reason: "setting_disabled" };
      nativePolicyReports.set(keeper, policy);
      lastNativePolicy = policy;
      status.update({ nativeLoginPolicyState: policy.state, nativeLoginPolicyReason: policy.reason });
    }
    return observed.result;
  };

  const requestNativeLoginPolicyCheck = async (): Promise<{ queued: boolean }> => {
    const manager = currentKeeperManager;
    const context = currentContext;
    const keeper = manager?.currentKeeper();
    if (stopped || !manager || !context || !keeper || !status.getSnapshot().authenticated ||
        manager.authenticationRecoveryPending()) throw new Error("native_policy_unavailable");
    const observed = await observeVisibleNativeLoginPolicy(true);
    if (stopped || manager !== currentKeeperManager || context !== currentContext || keeper !== manager.currentKeeper() ||
        !status.getSnapshot().authenticated || manager.authenticationRecoveryPending()) throw new Error("native_policy_unavailable");
    if (observed === "on" || observed === "off") return { queued: false };
    if (observed !== "missing") {
      const reason = observed === "ambiguous" ? "ambiguous" : observed === "blocked" ? "blocked" : "state_unknown";
      lastNativePolicy = { state: "attention", reason };
      nativePolicyReports.set(keeper, lastNativePolicy);
      status.update({ nativeLoginPolicyState: "attention", nativeLoginPolicyReason: reason });
      return { queued: false };
    }
    if (!nativePolicyEnabled || !supportsNativeLoginPolicy(keeper)) {
      lastNativePolicy = !nativePolicyEnabled ? pendingNativePolicy : { state: "attention", reason: "browser_unsupported" };
      nativePolicyReports.set(keeper, lastNativePolicy);
      status.update({ nativeLoginPolicyState: lastNativePolicy.state, nativeLoginPolicyReason: lastNativePolicy.reason });
      return { queued: false };
    }
    // Request real work through the existing command-safe, authenticated
    // candidate pipeline. A page reload alone must never mean "rechecked".
    nativePolicyReports.delete(keeper);
    lastNativePolicy = pendingNativePolicy;
    status.update({ nativeLoginPolicyState: "pending", nativeLoginPolicyReason: "not_checked" });
    manager.requestProactiveRefresh();
    return { queued: true };
  };

  const touchAuthenticatedSessionIfDue = async () => {''')

# Allowlist only the new enum, not page content.
p = Path('bridge/src/state/runtime-state.ts')
s = p.read_text()
assert s.count('"settings_not_found"') == 1
p.write_text(s.replace('"settings_not_found"', '"setting_disabled", "settings_not_found"'))

# Same-origin UI recheck: loopback/Ingress + ephemeral anti-CSRF nonce + POST.
replace('bridge/src/server/http-server.ts', 'import { createServer,', 'import { randomUUID } from "node:crypto";\nimport { createServer,')
replace('bridge/src/server/http-server.ts', '    reloadInventory(): Promise<void>;', '    checkNativeLoginPolicy?(): Promise<{ queued: boolean }>;\n    reloadInventory(): Promise<void>;')
replace('bridge/src/server/http-server.ts', '  const server = createServer((request, response) => {', '''  const nativePolicyCheckToken = randomUUID();
  let lastNativePolicyCheckAt = Number.NEGATIVE_INFINITY;
  const checkNativePolicy = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (request.method !== "POST") return writeError(response, 405, "method_not_allowed");
      if (!isLoopback(request.socket.remoteAddress) || request.headers["x-stw-ui-csrf"] !== nativePolicyCheckToken ||
          request.headers["sec-fetch-site"] === "cross-site") return writeError(response, 403, "ingress_required");
      if (!isJsonContentType(request.headers["content-type"])) return writeError(response, 415, "content_type_unsupported");
      const body = await readJsonBody(request, 128);
      if (!body.ok || !isRecord(body.value) || Object.keys(body.value).length !== 0) return writeError(response, 400, "invalid_request");
      if (!options.maintenance?.checkNativeLoginPolicy) return writeError(response, 503, "maintenance_unavailable");
      if (performance.now() - lastNativePolicyCheckAt < 10_000) return writeError(response, 429, "check_rate_limited");
      lastNativePolicyCheckAt = performance.now();
      const result = await options.maintenance.checkNativeLoginPolicy();
      return writeJson(response, result.queued ? 202 : 200, { accepted: true, queued: result.queued });
    } catch { if (!response.headersSent) writeError(response, 503, "native_policy_unavailable"); }
  };
  const server = createServer((request, response) => {''')
replace('bridge/src/server/http-server.ts', 'response.end(renderStatusPage(report));', 'response.end(renderStatusPage(report, { nativePolicyCheckToken }));')
replace('bridge/src/server/http-server.ts', '    if (path.startsWith("/api/v1/")) {', '    if (path === "/api/v1/native-login-policy/check") {\n      void checkNativePolicy(request, response);\n      return;\n    }\n    if (path.startsWith("/api/v1/")) {')

# Preserve the existing compact-radius/no-shadow design and all login guidance.
replace('bridge/src/server/status-page.ts', 'export interface StatusPageOptions {', 'export interface StatusPageOptions {\n  nativePolicyCheckToken?: string;')
replace('bridge/src/server/status-page.ts', '${renderNativeLoginPolicy(report)}', '${renderNativeLoginPolicy(report, options.nativePolicyCheckToken)}')
replace('bridge/src/server/status-page.ts', 'function renderNativeLoginPolicy(report: HealthReport): string {', 'function renderNativeLoginPolicy(report: HealthReport, checkToken = ""): string {')
replace('bridge/src/server/status-page.ts', 'settings_not_found: "SmartThings 설정 버튼을 찾지 못했습니다.",', 'setting_disabled: "열려 있는 SmartThings 설정에서 로그인 유지가 꺼져 있음을 확인했습니다.",\n  settings_not_found: "설정 메뉴를 찾지 못해 켜짐 여부를 확인하지 못했습니다. 로그인 유지가 꺼졌다는 뜻은 아닙니다.",')
replace('bridge/src/server/status-page.ts', 'return `<section class="hc-section" aria-labelledby="native-login-heading">', 'return `<section id="native-login-policy" class="hc-section" aria-labelledby="native-login-heading">')
replace('bridge/src/server/status-page.ts', '        <p role="note"><strong>${escapeHtml(importantGuidance.split', '''        ${effective === "attention" && reason !== "setting_disabled" ? '<p><strong>이미 켜 두셨다면 그대로 두세요.</strong> 브릿지 내부 브라우저(noVNC)에서 SmartThings 설정을 열어 둔 채 아래 ‘설정 다시 확인’을 누르세요. 설정을 끄거나 로그아웃할 필요가 없습니다.</p>' : ""}
        <p role="note"><strong>${escapeHtml(importantGuidance.split''')
replace('bridge/src/server/status-page.ts', '        <a class="hc-button hc-button-secondary" href=".">상태 다시 확인</a></div>', '        <button class="hc-button hc-button-secondary" id="native-login-check" data-check-token="${escapeHtml(checkToken)}" type="button" aria-describedby="native-login-check-result">설정 다시 확인</button></div>\n      <p id="native-login-check-result" role="status" aria-live="polite"></p>')
replace('bridge/src/server/status-page.ts', '    const pairingButton = document.getElementById("pairing-button");', '''    function bindNativePolicyCheck() {
      const button = document.getElementById("native-login-check");
      if (!button) return;
      button.addEventListener("click", async () => {
        const result = document.getElementById("native-login-check-result");
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        result.textContent = "브릿지 브라우저의 실제 설정을 확인하고 있습니다…";
        try {
          const response = await fetch("api/v1/native-login-policy/check", {
            method: "POST", credentials: "same-origin", cache: "no-store",
            headers: { "Content-Type": "application/json", "X-STW-UI-CSRF": button.dataset.checkToken }, body: "{}"
          });
          if (!response.ok) throw new Error(response.status === 429 ? "잠시 후 다시 확인해 주세요." :
            response.status === 403 ? "페이지를 새로고침한 뒤 다시 확인해 주세요." : "브릿지가 로그인된 상태인지 확인한 뒤 다시 시도해 주세요.");
          const accepted = await response.json();
          if (accepted.queued) {
            result.textContent = "실제 설정 재검사를 요청했습니다. 기기 제어가 끝난 뒤 안전하게 확인합니다…";
            let finished = false;
            for (let attempt = 0; attempt < 60; attempt++) {
              await new Promise(resolve => setTimeout(resolve, 1000));
              const healthResponse = await fetch("health/details", { credentials: "same-origin", cache: "no-store" });
              if (!healthResponse.ok) throw new Error("브릿지의 검사 결과를 불러오지 못했습니다.");
              const health = await healthResponse.json();
              if (health.details.nativeLoginPolicyState !== "pending") { finished = true; break; }
            }
            if (!finished) throw new Error("재검사가 아직 대기 중입니다. SmartThings 설정을 열어 둔 채 잠시 후 다시 확인해 주세요.");
          }
          const updatedResponse = await fetch(".", { credentials: "same-origin", cache: "no-store" });
          if (!updatedResponse.ok) throw new Error("검사 결과를 표시하지 못했습니다. 페이지를 새로고침해 주세요.");
          const updatedDocument = new DOMParser().parseFromString(await updatedResponse.text(), "text/html");
          const updatedCard = updatedDocument.getElementById("native-login-policy");
          if (!updatedCard) throw new Error("검사 결과를 표시하지 못했습니다.");
          document.getElementById("native-login-policy").replaceWith(document.importNode(updatedCard, true));
          bindNativePolicyCheck();
          document.getElementById("native-login-check-result").textContent = "최신 검사 결과를 표시했습니다.";
          document.getElementById("native-login-check").focus({ preventScroll: true });
        } catch (error) {
          result.textContent = error instanceof Error ? error.message : "설정을 확인하지 못했습니다.";
        } finally { button.disabled = false; button.removeAttribute("aria-busy"); }
      });
    }
    bindNativePolicyCheck();
    const pairingButton = document.getElementById("pairing-button");''')

# Release metadata is version-only; do not change protocol, dependencies or old notes.
version_files = ['package.json','package-lock.json','protocol/version.json',
 'custom_components/smartthings_web/manifest.json','addon/smartthings_web_bridge/config.yaml',
 'bridge/src/runtime.ts','bridge/tests/runtime.test.ts','tests/addon-config.test.ts','tests/protocol-version-contract.test.ts']
for name in version_files:
    p = Path(name); text = p.read_text(); assert '1.8.52' in text, name
    p.write_text(text.replace('1.8.52','1.8.53'))
notes = '''- SmartThings 설정 버튼을 찾지 못해 로그인 유지가 확인되지 않던 탐지 경로를 보완했습니다. 메뉴 안의 설정, 아이콘의 접근성 이름, 열린 Shadow DOM을 지원하며 모호한 대상은 클릭하지 않습니다.
- 이미 열린 SmartThings 설정의 실제 스위치를 읽기 전용으로 확인합니다. 수동으로 켠 설정을 감지하며 설정 화면을 닫거나 새로고침하거나 스위치를 다시 누르지 않습니다.
- ‘설정 다시 확인’이 실제 브릿지 검사를 요청하도록 수정했습니다. 단순 페이지 새로고침으로 이전 결과만 표시하지 않으며, 검사 중/대기/실패를 별도로 안내합니다. 요청은 Ingress/loopback, POST, 임시 CSRF 토큰과 재시도 제한으로 보호합니다.
- ‘확인 불가’와 실제 ‘꺼짐’을 구분합니다. 이미 켰다면 끄거나 로그아웃하지 말고 브릿지의 SmartThings 설정을 열어 둔 채 다시 확인하도록 안내합니다.
- 1.8.52의 그림자 제거, 축소된 radius, 로고·한글 UI·페어링 및 세션 안전 검증을 유지합니다. 실제 Samsung 계정의 장시간 로그인 지속을 보장하는 변경은 아닙니다.
'''
Path('release-notes/1.8.53.md').write_text(notes)
for name in ['CHANGELOG.md','addon/smartthings_web_bridge/CHANGELOG.md']:
    p = Path(name); p.write_text('## 1.8.53\n\n'+notes+'\n'+p.read_text())
