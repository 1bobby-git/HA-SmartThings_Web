import { describe, expect, test } from "vitest";

import { createHealthReport } from "../../src/server/health.js";
import { renderStatusPage } from "../../src/server/status-page.js";
import { RuntimeStatusStore, type RuntimeStatusPatch } from "../../src/state/runtime-state.js";

describe("renderStatusPage", () => {
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
