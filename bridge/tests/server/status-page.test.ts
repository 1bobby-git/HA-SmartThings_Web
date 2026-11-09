import { runInNewContext } from "node:vm";
import { describe, expect, test, vi } from "vitest";

import { createHealthReport } from "../../src/server/health.js";
import { renderStatusPage } from "../../src/server/status-page.js";
import { RuntimeStatusStore, type RuntimeStatusPatch } from "../../src/state/runtime-state.js";

describe("renderStatusPage", () => {
  test("offers an explicit, accessible protocol diagnosis copy action with a manual fallback", () => {
    const html = renderStatusPage(reportFor({ state: "PROTOCOL_CHANGED", dbAvailable: true }));

    expect(html).toContain('id="protocol-diagnostic-copy" type="button"');
    expect(html).toContain('aria-describedby="protocol-diagnostic-help protocol-diagnostic-result"');
    expect(html).toContain('id="protocol-diagnostic-result" role="status" aria-live="polite"');
    expect(html).toContain('id="protocol-diagnostic-manual" hidden');
    expect(html).toContain('id="protocol-diagnostic-text" readonly');
    expect(html).toContain('fetch("api/v1/diagnostics/protocol", {');
    expect(html).toContain('"x-stw-ui-action": "protocol-diagnostics"');
    expect(html).toContain('credentials: "same-origin", cache: "no-store"');
    expect(html).toContain('signal: AbortSignal.timeout(5000)');
    expect(html).toContain('navigator.clipboard.writeText(summary)');
    expect(html).toContain('protocolDiagnosticText.select()');
    expect(html).toContain("저장된 응답 후보");
    expect(html).toContain("오류가 표시된 뒤 다시 시도해 주세요");
    expect(html).not.toMatch(/https?:|deviceId|locationId|token|secret|raw-/i);
  });

  test("requests diagnostics only on click and copies the returned summary", async () => {
    const summary = protocolSummary("exact_rejected");
    const fetch = vi.fn(async () => ({ ok: true, json: async () => summary }));
    const writeText = vi.fn(async () => undefined);
    const ui = mountStatusScript(fetch, { writeText });

    expect(fetch).not.toHaveBeenCalled();
    await ui.click();

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("api/v1/diagnostics/protocol", expect.objectContaining({
      method: "GET", credentials: "same-origin", cache: "no-store",
      headers: { "x-stw-ui-action": "protocol-diagnostics" }, signal: expect.any(AbortSignal)
    }));
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(summary, null, 2));
    expect(ui.result.textContent).toContain("확인된 오류 응답 진단을 복사했습니다");
    expect(ui.manual.hidden).toBe(true);
    expect(ui.button.disabled).toBe(false);
    expect(ui.button.attributes.has("aria-busy")).toBe(false);
  });

  test("offers selectable manual copy when the clipboard rejects a saved candidate", async () => {
    const summary = protocolSummary("saved_ack_candidates");
    const ui = mountStatusScript(
      vi.fn(async () => ({ ok: true, json: async () => summary })),
      { writeText: vi.fn(async () => { throw new Error("denied"); }) }
    );

    await ui.click();

    expect(ui.manual.hidden).toBe(false);
    expect(ui.text.value).toBe(JSON.stringify(summary, null, 2));
    expect(ui.text.focused).toBe(true);
    expect(ui.text.selected).toBe(true);
    expect(ui.result.textContent).toContain("저장된 응답 후보");
    expect(ui.result.textContent).toContain("직접 복사해 주세요");
    expect(ui.result.textContent).toContain("원인은 아직 확정되지 않았습니다");
  });

  test("clears an earlier manual summary when a later request fails", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => protocolSummary("exact_rejected") })
      .mockRejectedValueOnce(new Error("offline"));
    const ui = mountStatusScript(fetch);

    await ui.click();
    expect(ui.manual.hidden).toBe(false);
    await ui.click();

    expect(ui.manual.hidden).toBe(true);
    expect(ui.text.value).toBe("");
    expect(ui.result.textContent).toContain("가져오지 못했습니다");
    expect(ui.button.disabled).toBe(false);
  });

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

  test("renders verified protocol evidence from safe health fields only", () => {
    const html = renderStatusPage(reportFor({
      state: "CONNECTED",
      protocolVersion: "1:abcdef1234567890",
      protocolChangeCount: 0,
      dbAvailable: true,
      chromiumRunning: true,
      keeperPresent: true,
      authenticated: true,
      pushConnected: true,
      initialSnapshotComplete: true,
      parserHealthy: true,
      lastSnapshotAtMs: 9_900,
      lastParserSuccessAtMs: 9_950,
      lastPushAtMs: 9_975
    }));

    expect(html).toContain('data-protocol-state="verified"');
    expect(html).toContain("프로토콜이 확인되었습니다");
    expect(html).toContain("1:abcdef1234567890");
    expect(html).not.toMatch(/https?:|deviceId|locationId|token|secret|raw-/i);
  });

  test("renders discovery-incomplete protocol evidence in Korean", () => {
    const html = renderStatusPage(reportFor({
      state: "DISCOVERING_PROTOCOL",
      protocolVersion: "1:discovering",
      protocolChangeCount: 0,
      dbAvailable: true
    }));

    expect(html).toContain('data-protocol-state="discovering"');
    expect(html).toContain("프로토콜을 확인하고 있습니다");
    expect(html).toContain("1:discovering");
    expect(html).toContain(
      'href="novnc-ui/vnc.html?autoconnect=1&amp;resize=scale&amp;path=websockify"'
    );
    expect(html).not.toContain('href="/novnc');
  });

  test("renders protocol-changed evidence and escapes safe field values", () => {
    const html = renderStatusPage(reportFor({
      state: "PROTOCOL_CHANGED",
      protocolVersion: '1:<probe"',
      protocolChangeCount: 2,
      protocolMismatchSurface: "snapshot:scenes:response_shape",
      dbAvailable: true,
      parserHealthy: false
    }));

    expect(html).toContain('data-protocol-state="changed"');
    expect(html).toContain("프로토콜 변경이 감지되었습니다");
    expect(html).toContain("준비 상태 차단됨");
    expect(html).toContain("Phase 2는 계속 차단됨");
    expect(html).toContain("snapshot:scenes:response_shape");
    expect(html).toContain("1:&lt;probe&quot;");
    expect(html).not.toContain('1:<probe"');
    expect(html).not.toMatch(/https?:|deviceId|locationId|token|secret|raw-/i);
  });

  test("renders verified evidence for compatible status with historical changes", () => {
    const html = renderStatusPage(reportFor({
      state: "CONNECTED",
      protocolVersion: "1:abcdef1234567890",
      protocolChangeCount: 3,
      dbAvailable: true,
      chromiumRunning: true,
      keeperPresent: true,
      authenticated: true,
      pushConnected: true,
      initialSnapshotComplete: true,
      parserHealthy: true,
      lastSnapshotAtMs: 9_900,
      lastParserSuccessAtMs: 9_950,
      lastPushAtMs: 9_975
    }));

    expect(html).toContain('data-protocol-state="verified"');
    expect(html).toContain("프로토콜이 확인되었습니다");
    expect(html).not.toContain("Phase 2는 계속 차단됨");
  });

  test("renders the guide-aligned white header, packaged logo and Korean hierarchy", () => {
    const html = renderStatusPage(
      reportFor({
        state: "CONNECTED",
        protocolVersion: "1:abcdef1234567890",
        protocolChangeCount: 0,
        dbAvailable: true,
        chromiumRunning: true,
        keeperPresent: true,
        authenticated: true,
        pushConnected: true,
        initialSnapshotComplete: true,
        parserHealthy: true,
        initialSnapshotCompletedAtMs: 9_900,
        lastSnapshotAtMs: 9_900,
        lastParserSuccessAtMs: 9_950,
        lastPushAtMs: 9_975
      }),
      { brandLogoDataUri: "data:image/png;base64,ZmFrZS1sb2dv" }
    );

    expect(html).toContain('<html lang="ko-KR">');
    expect(html).toContain('class="hc-header-surface"');
    expect(html).toContain("background: #ffffff");
    expect(html).toContain('class="hc-brand-logo"');
    expect(html).toContain('src="data:image/png;base64,ZmFrZS1sb2dv"');
    expect(html).toContain("SmartThings 연결 상태를 한눈에.");
    expect(html).toContain("브릿지가 정상적으로 준비되었습니다");
    expect(html).toContain("HA 연결됨");
    expect(html).toContain('data-auth-state="connected"');
    expect(html).toContain("브라우저 로그인됨");
    expect(html).toContain("세션 유지 중 · 다시 열기");
    expect(html).toContain('data-status-icon="ready"');
    expect(html).toContain("background: var(--hc-surface)");
    expect(html).not.toContain("background: var(--hc-hero-bg)");
    expect(html).toContain("페어링 코드 생성");
    expect(html).toContain('class="hc-tab" href="#overview" aria-current="page">한눈에</a>');
    expect(html).toContain('id="pairing-result" role="status" aria-live="polite"');
    expect(html).toContain('<details class="hc-card hc-details">');
    expect(html).toContain("기술 세부 정보 보기");
    expect(html).not.toContain("live=true ready=true");
  });

  test("keeps the browser action non-alarming while an authenticated session is maintained", () => {
    const html = renderStatusPage(reportFor({
      state: "CONNECTED",
      protocolVersion: "1:abcdef1234567890",
      dbAvailable: true,
      authenticated: true,
      chromiumRunning: true,
      keeperPresent: true
    }));

    expect(html).toContain('data-auth-state="connected"');
    expect(html).toContain("브라우저 로그인됨");
    expect(html).toContain("세션 유지 중 · 다시 열기");
    expect(html).toContain("브라우저 다시 열기");
    expect(html).not.toContain("브라우저 로그인 필요");
  });

  test("uses prepared warning and danger assets when login or browser attention is required", () => {
    const loginRequired = renderStatusPage(reportFor({
      state: "LOGIN_REQUIRED",
      protocolVersion: "1:discovering",
      dbAvailable: true,
      authenticated: false
    }));
    const browserFailed = renderStatusPage(reportFor({
      state: "BROWSER_FAILED",
      protocolVersion: "1:abcdef1234567890",
      dbAvailable: false,
      authenticated: false
    }));

    expect(loginRequired).toContain('data-auth-state="required"');
    expect(loginRequired).toContain("브라우저 로그인 필요");
    expect(loginRequired).toContain('data-status-icon="danger"');
    expect(browserFailed).toContain('data-auth-state="attention"');
    expect(browserFailed).toContain("브라우저 확인 필요");
  });

  test("distinguishes live-but-not-ready from unavailable without relying on color alone", () => {
    const startingHtml = renderStatusPage(reportFor({
      state: "CONNECTED",
      protocolVersion: "1:abcdef1234567890",
      dbAvailable: true
    }));
    const attentionHtml = renderStatusPage(reportFor({
      state: "BROWSER_FAILED",
      protocolVersion: "1:abcdef1234567890",
      dbAvailable: false
    }));

    expect(startingHtml).toContain('data-overall-state="starting"');
    expect(startingHtml).toContain("브릿지를 준비하고 있습니다");
    expect(startingHtml).toContain("준비 중");
    expect(attentionHtml).toContain('data-overall-state="attention"');
    expect(attentionHtml).toContain("브릿지 확인이 필요합니다");
    expect(attentionHtml).toContain("오프라인");
  });

  test("marks native login maintenance as an important bridge-browser instruction", () => {
    const pending = renderStatusPage(reportFor({
      state: "CONNECTED",
      protocolVersion: "1:abcdef1234567890",
      dbAvailable: true,
      authenticated: true,
      nativeLoginPolicyState: "pending",
      nativeLoginPolicyReason: "not_checked"
    }));
    const enabled = renderStatusPage(reportFor({
      state: "CONNECTED",
      protocolVersion: "1:abcdef1234567890",
      dbAvailable: true,
      authenticated: true,
      nativeLoginPolicyState: "enabled",
      nativeLoginPolicyReason: "already_enabled"
    }));

    expect(pending).toContain("중요:");
    expect(pending).toContain("반드시 브릿지 내부 브라우저(noVNC)");
    expect(pending).toContain("‘로그인 유지’를 켜 주세요");
    expect(pending).toContain("2시간·8시간·24시간");
    expect(pending).toContain('role="note"');
    expect(enabled).toContain("중요 설정 확인됨:");
    expect(enabled).not.toContain("2시간·8시간·24시간");
  });

  test("keeps shadows disabled while restoring compact rounded corners", () => {
    const html = renderStatusPage(reportFor({
      state: "CONNECTED",
      protocolVersion: "1:abcdef1234567890",
      dbAvailable: true,
      authenticated: true
    }));

    expect(html).toContain("box-shadow: none !important");
    expect(html).toContain("--hc-shadow: none");
    expect(html).not.toContain("border-radius: 0 !important");
    expect(html).toContain("border-radius: 18px");
    expect(html).toContain("border-radius: 14px");
    expect(html).toContain("border-radius: 10px");
    expect(html).not.toContain("box-shadow: 0 8px 24px #19243b20");
  });

  test("localizes runtime and diagnostic labels", () => {
    const html = renderStatusPage(reportFor({
      state: "LOGIN_REQUIRED",
      protocolVersion: "1:discovering",
      dbAvailable: true,
      sessionTouchLastOutcome: "reauth",
      sessionTouchCount: 3
    }));

    expect(html).toContain("로그인 필요");
    expect(html).toContain("세션 유지 시도");
    expect(html).toContain("최근 세션 유지 결과");
    expect(html).toContain("재인증 필요");
  });
});

function reportFor(patch: RuntimeStatusPatch) {
  const now = 10_000;
  const store = new RuntimeStatusStore({
    now: () => now,
    initial: {
      heartbeatAtMs: 9_990,
      bridgeVersion: "0.1.0",
      browserVersion: "Chromium 141.0.7390.122",
      ...patch
    }
  });
  return createHealthReport(store.getSnapshot(), { nowMs: now });
}

function protocolSummary(evidence: "exact_rejected" | "saved_ack_candidates") {
  return {
    schemaVersion: 1, bridgeVersion: "0.1.0", protocolContractVersion: 6,
    state: "PROTOCOL_CHANGED", ready: false,
    mismatchSurface: "snapshot:device_cards:response_shape", evidence,
    rejectedResponses: [], uncorrelatedCandidates: []
  };
}

class ScriptNode {
  disabled = false;
  hidden = true;
  value = "";
  textContent = "";
  focused = false;
  selected = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  readonly listeners = new Map<string, () => Promise<void>>();

  addEventListener(event: string, callback: () => Promise<void>): void { this.listeners.set(event, callback); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  querySelector(): ScriptNode { return new ScriptNode(); }
  focus(): void { this.focused = true; }
  select(): void { this.selected = true; }
}

function mountStatusScript(
  fetch: ReturnType<typeof vi.fn>,
  clipboard?: { writeText: ReturnType<typeof vi.fn> }
) {
  const html = renderStatusPage(reportFor({ state: "PROTOCOL_CHANGED", dbAvailable: true }));
  const script = html.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
  if (!script) throw new Error("status script missing");
  const nodes = new Map<string, ScriptNode>();
  const get = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, new ScriptNode());
    return nodes.get(id)!;
  };
  runInNewContext(script, {
    document: { getElementById: get }, fetch, navigator: { clipboard }, AbortSignal,
    window: { location: { reload: vi.fn() } }, setTimeout
  });
  const button = get("protocol-diagnostic-copy");
  return {
    button, result: get("protocol-diagnostic-result"), manual: get("protocol-diagnostic-manual"),
    text: get("protocol-diagnostic-text"),
    click: async () => {
      const handler = button.listeners.get("click");
      if (!handler) throw new Error("diagnostic click handler missing");
      await handler();
    }
  };
}
