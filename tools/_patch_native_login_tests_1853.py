from pathlib import Path
r=Path('.')
p=r/'bridge/tests/server/http-server.test.ts'
s=p.read_text(); anchor='describe("createBridgeHttpServer", () => {'; assert s.count(anchor)==1
s=s.replace(anchor,anchor+'''
  test("native preference recheck is a guarded POST, never a cached page reload or cross-site action", async () => {
    const requestNativeLoginPolicyCheck = vi.fn(async () => "queued" as const);
    const server = await createBridgeHttpServer({
      store: createStore(), host: "127.0.0.1", port: 0,
      auth: new BridgeAuth("e".repeat(32)), devices: new DeviceStore(),
      maintenance: { reloadInventory: vi.fn(), reconnectRealtime: vi.fn(), requestNativeLoginPolicyCheck }
    });
    servers.push(server);
    const url = `http://127.0.0.1:${server.port}/api/v1/native-login-policy/check`;
    const headers = { "content-type": "application/json", "x-stw-ui-action": "native-login-policy" };
    expect((await fetch(url)).status).toBe(405);
    expect((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await fetch(url, { method: "POST", headers: { ...headers, "sec-fetch-site": "cross-site" }, body: "{}" })).status).toBe(403);
    expect((await fetch(url, { method: "POST", headers: { ...headers, "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
    expect((await fetch(url, { method: "POST", headers, body: '{"enabled":false}' })).status).toBe(400);
    expect(requestNativeLoginPolicyCheck).not.toHaveBeenCalled();
    const response = await fetch(url, { method: "POST", headers, body: "{}" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ outcome: "queued" });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(requestNativeLoginPolicyCheck).toHaveBeenCalledTimes(1);
  });

  test.each(["observed", "disabled", "unavailable"] as const)("native preference recheck reports %s honestly", async outcome => {
    const server = await createBridgeHttpServer({
      store: createStore(), host: "127.0.0.1", port: 0,
      auth: new BridgeAuth("e".repeat(32)), devices: new DeviceStore(),
      maintenance: { reloadInventory: vi.fn(), reconnectRealtime: vi.fn(), requestNativeLoginPolicyCheck: async () => outcome }
    });
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/native-login-policy/check`, {
      method: "POST", headers: { "content-type": "application/json", "x-stw-ui-action": "native-login-policy" }, body: "{}"
    });
    expect(response.status).toBe(outcome === "unavailable" ? 409 : 200);
    expect(await response.json()).toEqual(outcome === "unavailable" ? { error: "browser_not_ready" } : { outcome });
  });
''');p.write_text(s)
p=r/'bridge/tests/browser/native-login-policy.test.ts';s=p.read_text();s=s.replace('ensureNativeKeepSignedIn, nativeLoginTarget','ensureNativeKeepSignedIn, readNativeKeepSignedIn, nativeLoginTarget');anchor='describe("native login preference safety and integration contracts", () => {';assert s.count(anchor)==1
s=s.replace(anchor,anchor+'''
  test("observes an open setting without locator clicks, navigation or auth proof", async () => {
    const browser = page();
    browser.evaluate.mockResolvedValue({ result: "on" });
    expect(await readNativeKeepSignedIn(browser)).toEqual({ state: "enabled", reason: "observed_enabled" });
    browser.evaluate.mockResolvedValue({ result: "off" });
    expect(await readNativeKeepSignedIn(browser)).toEqual({ state: "attention", reason: "observed_disabled" });
    browser.evaluate.mockResolvedValue({ result: "missing" });
    expect(await readNativeKeepSignedIn(browser)).toBeUndefined();
    expect(browser.goto).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
    const store = new RuntimeStatusStore({initial:{authenticated:false}});
    store.update({nativeLoginPolicyState:"enabled",nativeLoginPolicyReason:"observed_enabled"});
    expect(createHealthReport(store.getSnapshot()).ready).toBe(false);
  });
  test("discards observed state after navigation", async () => {
    let url = target;
    const browser = {...page(),url: () => url};
    browser.evaluate.mockImplementation(async () => { url = "https://account.samsung.com/"; return {result:"on"}; });
    expect(await readNativeKeepSignedIn(browser)).toBeUndefined();
    expect(browser.goto).not.toHaveBeenCalled();
  });
''');p.write_text(s)
p=r/'bridge/tests/server/status-page.test.ts';s=p.read_text();anchor='describe("renderStatusPage", () => {';assert s.count(anchor)==1
s=s.replace(anchor,anchor+'''
  test("rechecks the browser through an explicit UI POST and distinguishes unknown from OFF", () => {
    const html = renderStatusPage(reportFor({state:"CONNECTED",dbAvailable:true,authenticated:true,
      nativeLoginPolicyState:"attention",nativeLoginPolicyReason:"settings_not_found"}));
    expect(html).toContain('id="native-policy-check"');
    expect(html).toContain('api/v1/native-login-policy/check');
    expect(html).toContain('"x-stw-ui-action": "native-login-policy"');
    expect(html).toContain('aria-describedby="native-policy-check-result"');
    expect(html).toContain("꺼짐을 의미하지는 않습니다");
    expect(html).not.toContain('href=".">상태 다시 확인');
  });
''');p.write_text(s)
p=r/'.github/workflows/validate.yml';s=p.read_text();assert s.count('          xvfb-run -a node tools/ci-native-login-policy-smoke.mjs')==1;s=s.replace('          xvfb-run -a node tools/ci-native-login-policy-smoke.mjs','          xvfb-run -a node tools/ci-native-login-policy-smoke.mjs\n          node tools/ci-native-login-dom-regression.mjs');p.write_text(s)
paths=['package.json','package-lock.json','protocol/version.json','custom_components/smartthings_web/manifest.json','addon/smartthings_web_bridge/config.yaml','bridge/src/runtime.ts','bridge/tests/runtime.test.ts','tests/addon-config.test.ts','tests/protocol-version-contract.test.ts']
for f in paths:
    p=r/f;s=p.read_text();assert '1.8.52' in s,f;p.write_text(s.replace('1.8.52','1.8.53'))
notes='''- 실제 SmartThings 웹의 `App settings → 설정` 2단계 메뉴와 `SmartThings for Web` 영문 표기를 인식하도록 로그인 유지 설정 탐색을 수정했습니다.
- `toggle-switch-stayLoggedIn` 버튼의 `aria-checked`와 `stayLoggedIn` 입력의 실제 `checked` 값을 함께 확인합니다. 투명한 읽기 전용 입력을 클릭하지 않으며, 이미 켜진 스위치는 변경하지 않습니다.
- 사용자가 브릿지 브라우저에서 연 설정 창은 읽기 전용으로 확인합니다. `상태 다시 확인` 버튼도 실제 브라우저 검사를 요청하며, 메뉴를 찾지 못한 경우를 설정 꺼짐으로 안내하지 않습니다.
- 한글 UI·로그인 유지 중요 지침·쉐도우 없는 작은 radius 디자인과 기존 인증 검증을 유지합니다. 실제 Samsung 계정의 무기한 로그인이나 재시작 후 인증 유효성을 보장하는 변경은 아닙니다.
'''
(r/'release-notes/1.8.53.md').write_text(notes)
for f in ['CHANGELOG.md','addon/smartthings_web_bridge/CHANGELOG.md']:
    p=r/f;p.write_text('## 1.8.53\n\n'+notes+'\n'+p.read_text())
p=r/'addon/smartthings_web_bridge/DOCS.md';p.write_text(p.read_text()+'''

### 로그인 유지를 켰는데 브릿지가 확인하지 못할 때

브릿지 내부 브라우저(noVNC)의 SmartThings 기기 화면에서 **App settings(앱 설정) 메뉴 → 설정 → 로그인 유지**를 확인하세요. 휴대폰이나 별도 데스크톱 브라우저 화면만으로는 브릿지 프로필의 설정을 확인할 수 없습니다.

이미 켜져 있다면 다시 끄거나 켜지 마세요. **설정 창을 열린 상태로 둔 뒤 브릿지 상태 페이지의 ‘상태 다시 확인’**을 누르면 현재 스위치 값을 읽기 전용으로 확인합니다. 브릿지는 `aria-checked`와 연결된 읽기 전용 입력의 실제 `checked` 값을 비교하며, 다른 Support 접근 스위치나 로그아웃 버튼을 누르지 않습니다.

‘현재 열린 설정에서 켜짐 확인’과 ‘페이지를 다시 열어 유지 확인’은 서로 다른 확인 결과입니다. 메뉴를 자동으로 찾지 못했다는 안내는 로그인 유지가 꺼졌거나 로그인 세션이 만료되었다는 뜻이 아닙니다. 설정 창이 닫혀 있을 때 다시 확인을 요청하면 기존의 인증·명령 실행 보호 절차 안에서 별도 브라우저 탭으로 검사하며, 진행 중인 명령이나 인증 절차가 있으면 기다립니다.
''')
(r/'.github/workflows/inspect-login-dom-1853.yml').unlink()
