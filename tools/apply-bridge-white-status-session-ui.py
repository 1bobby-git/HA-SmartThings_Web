from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}: {old[:80]!r}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")


# Expose the existing runtime authentication boolean as a safe HealthReport field.
replace_once(
    "bridge/src/server/health.ts",
    '  urlCategory: RuntimeStatusSnapshot["urlCategory"];\n  activeConnections: number;',
    '  urlCategory: RuntimeStatusSnapshot["urlCategory"];\n  authenticated: boolean;\n  activeConnections: number;',
)
replace_once(
    "bridge/src/server/health.ts",
    '      urlCategory: snapshot.urlCategory,\n      activeConnections: snapshot.activeConnections,',
    '      urlCategory: snapshot.urlCategory,\n      authenticated: snapshot.authenticated,\n      activeConnections: snapshot.activeConnections,',
)

# Status page types, labels, and session-derived header action.
replace_once(
    "bridge/src/server/status-page.ts",
    'type ProtocolState = "changed" | "discovering" | "verified";\n',
    'type ProtocolState = "changed" | "discovering" | "verified";\ntype StatusTone = "ready" | "warning" | "danger";\ntype BrowserAuthState = "connected" | "required" | "checking" | "attention";\n',
)
replace_once(
    "bridge/src/server/status-page.ts",
    '  urlCategory: "현재 페이지 유형",\n  activeConnections: "활성 연결 수",',
    '  urlCategory: "현재 페이지 유형",\n  authenticated: "브라우저 로그인 상태",\n  activeConnections: "활성 연결 수",',
)
replace_once(
    "bridge/src/server/status-page.ts",
    '  const connectionText = report.ready ? "HA 연결됨" : report.live ? "연결 준비 중" : "확인 필요";\n\n  return `<!doctype html>',
    '  const connectionText = report.ready ? "HA 연결됨" : report.live ? "HA 연결 준비 중" : "HA 확인 필요";\n  const browserAuthState = browserSessionState(report);\n  const browserLoginAction = renderBrowserLoginAction(browserAuthState);\n  const browserSecondaryLabel = browserActionLabel(browserAuthState);\n\n  return `<!doctype html>',
)

# Remove the old navy hero token: the status area is now a normal surface card.
replace_once(
    "bridge/src/server/status-page.ts",
    '      --hc-shadow: 0 8px 32px #19243b08;\n      --hc-hero-bg: radial-gradient(ellipse at 95% -20%, #314774 0, transparent 63%), #182237;\n',
    '      --hc-shadow: 0 8px 32px #19243b08;\n',
)

old_login_css = '''    .hc-login-link {
      min-height: 44px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0 12px;
      border-radius: 12px;
      color: #2563eb;
      font-weight: 750;
      text-decoration: none;
      white-space: nowrap;
    }
    .hc-login-link:hover { background: #edf3ff; }
'''
new_login_css = '''    .hc-login-link {
      min-height: 48px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 9px;
      padding: 7px 12px;
      border: 1px solid #e9ecf1;
      border-radius: 12px;
      background: #ffffff;
      color: #2563eb;
      font-weight: 750;
      text-decoration: none;
      white-space: nowrap;
    }
    .hc-login-link:hover { filter: brightness(.98); }
    .hc-login-link[data-auth-state="connected"] { border-color: #cfe8dc; background: #f3faf6; color: #147455; }
    .hc-login-link[data-auth-state="required"] { border-color: #f2c8d0; background: #fff6f7; color: #b4233d; }
    .hc-login-link[data-auth-state="checking"] { border-color: #d6e3ff; background: #f5f8ff; color: #2563eb; }
    .hc-login-link[data-auth-state="attention"] { border-color: #f2c8d0; background: #fff6f7; color: #b4233d; }
    .hc-login-copy { display: grid; gap: 1px; line-height: 1.2; text-align: left; }
    .hc-login-copy strong { font-size: 13px; font-weight: 800; }
    .hc-login-copy small { color: #667182; font-size: 11px; font-weight: 650; }
    .hc-login-state-icon { width: 22px; height: 22px; display: inline-grid; place-items: center; flex: 0 0 auto; }
    .hc-login-state-icon svg { width: 20px; height: 20px; }
'''
replace_once("bridge/src/server/status-page.ts", old_login_css, new_login_css)

old_hero_css = '''    .hc-hero {
      position: relative;
      overflow: hidden;
      padding: 30px;
      border-radius: 24px;
      background: var(--hc-hero-bg);
      color: #ffffff;
      box-shadow: 0 20px 42px #15213a0c;
    }
    .hc-hero-grid { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(300px, .8fr); gap: 34px; align-items: center; }
    .hc-hero-kicker { margin: 0 0 8px; color: #9fb9e7; font-size: 12px; font-weight: 750; }
    .hc-state-line { display: flex; align-items: center; gap: 10px; }
    .hc-state-icon { width: 28px; height: 28px; display: inline-grid; place-items: center; border-radius: 999px; font-size: 16px; font-weight: 900; }
    .hc-hero[data-overall-state="ready"] .hc-state-icon { background: #dff7ea; color: #0b6849; }
    .hc-hero[data-overall-state="starting"] .hc-state-icon { background: #fff1cc; color: #775000; }
    .hc-hero[data-overall-state="attention"] .hc-state-icon { background: #ffe1e6; color: #9d1731; }
    .hc-hero h2 { margin: 0; font-size: clamp(25px, 3vw, 34px); line-height: 1.28; font-weight: 780; letter-spacing: -0.04em; }
    .hc-hero-copy { margin: 10px 0 0; color: #d8e2f3; max-width: 660px; }
    .hc-status-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
    .hc-status-item { display: flex; justify-content: space-between; gap: 18px; padding: 11px 13px; border: 1px solid #ffffff20; border-radius: 12px; background: #ffffff0c; }
    .hc-status-label { color: #c8d4e8; }
    .hc-status-value { text-align: right; font-weight: 800; overflow-wrap: anywhere; }
'''
new_hero_css = '''    .hc-hero {
      position: relative;
      overflow: hidden;
      padding: 28px;
      border: 1px solid var(--hc-line);
      border-radius: 24px;
      background: var(--hc-surface);
      color: var(--hc-ink);
      box-shadow: var(--hc-shadow);
    }
    .hc-hero[data-overall-state="ready"] { border-color: #d7ebe1; }
    .hc-hero[data-overall-state="starting"] { border-color: #efe2bd; }
    .hc-hero[data-overall-state="attention"] { border-color: #f1d0d6; }
    .hc-hero-grid { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(300px, .8fr); gap: 28px; align-items: center; }
    .hc-hero-kicker { margin: 0 0 8px; color: var(--hc-muted); font-size: 12px; font-weight: 750; }
    .hc-state-line { display: flex; align-items: flex-start; gap: 12px; }
    .hc-state-icon { width: 48px; height: 48px; display: inline-grid; place-items: center; flex: 0 0 auto; border-radius: 16px; }
    .hc-state-icon svg { width: 27px; height: 27px; }
    .hc-state-icon[data-status-tone="ready"], .hc-status-leading-icon[data-status-tone="ready"] { background: var(--hc-green-soft); color: var(--hc-green); }
    .hc-state-icon[data-status-tone="warning"], .hc-status-leading-icon[data-status-tone="warning"] { background: var(--hc-warning-soft); color: var(--hc-warning); }
    .hc-state-icon[data-status-tone="danger"], .hc-status-leading-icon[data-status-tone="danger"] { background: var(--hc-danger-soft); color: var(--hc-danger); }
    .hc-hero h2 { margin: 4px 0 0; font-size: clamp(24px, 3vw, 32px); line-height: 1.28; font-weight: 780; letter-spacing: -0.04em; }
    .hc-hero-copy { margin: 10px 0 0 60px; color: var(--hc-muted); max-width: 660px; }
    .hc-runtime-note { margin: 13px 0 0 60px; color: var(--hc-muted); font-size: 13px; }
    .hc-status-list { display: grid; gap: 9px; margin: 0; padding: 0; list-style: none; }
    .hc-status-item { display: flex; align-items: center; justify-content: space-between; gap: 18px; min-height: 54px; padding: 10px 13px; border: 1px solid var(--hc-line); border-radius: 14px; background: var(--hc-soft); }
    .hc-status-label { color: var(--hc-muted); font-weight: 700; }
    .hc-status-value { display: inline-flex; align-items: center; gap: 8px; text-align: right; color: var(--hc-ink); font-weight: 800; overflow-wrap: anywhere; }
    .hc-status-leading-icon { width: 28px; height: 28px; display: inline-grid; place-items: center; flex: 0 0 auto; border-radius: 9px; }
    .hc-status-leading-icon svg { width: 17px; height: 17px; }
'''
replace_once("bridge/src/server/status-page.ts", old_hero_css, new_hero_css)

replace_once(
    "bridge/src/server/status-page.ts",
    '          <a class="hc-login-link" href="novnc-ui/vnc.html?autoconnect=1&amp;resize=scale&amp;path=websockify">브라우저 로그인</a>',
    '          ${browserLoginAction}',
)
replace_once(
    "bridge/src/server/status-page.ts",
    '          <a class="hc-button hc-button-secondary" href="novnc-ui/vnc.html?autoconnect=1&amp;resize=scale&amp;path=websockify">브라우저 로그인 열기</a>',
    '          <a class="hc-button hc-button-secondary" href="novnc-ui/vnc.html?autoconnect=1&amp;resize=scale&amp;path=websockify">${browserSecondaryLabel}</a>',
)
replace_once(
    "bridge/src/server/status-page.ts",
    '@media (forced-colors: active) { .hc-card, .hc-status-item, .hc-button-secondary { border: 1px solid CanvasText; } .hc-button-primary { border: 1px solid ButtonText; } }',
    '@media (forced-colors: active) { .hc-card, .hc-status-item, .hc-button-secondary, .hc-login-link, .hc-state-icon, .hc-status-leading-icon { border: 1px solid CanvasText; } .hc-button-primary { border: 1px solid ButtonText; } }',
)

p = Path("bridge/src/server/status-page.ts")
text = p.read_text(encoding="utf-8")
start = text.index("function renderOverallPanel")
end = text.index("\nfunction renderProtocolPanel", start)
replacement = r'''function renderOverallPanel(report: HealthReport, state: OverallState): string {
  const title = state === "ready" ? "브릿지가 정상적으로 준비되었습니다" : state === "starting" ? "브릿지를 준비하고 있습니다" : "브릿지 확인이 필요합니다";
  const copy = state === "ready"
    ? "SmartThings 관찰과 Home Assistant 연결에 필요한 조건이 모두 충족되었습니다."
    : state === "starting"
      ? "브릿지 서비스는 실행 중이며 일부 준비 상태 확인을 마치는 중입니다."
      : "브릿지가 현재 정상 상태가 아닙니다. 아래 상태와 상세 진단에서 원인을 확인하세요.";
  const overallTone: StatusTone = state === "ready" ? "ready" : state === "starting" ? "warning" : "danger";
  const serviceTone: StatusTone = report.live ? "ready" : "danger";
  const readinessTone: StatusTone = report.ready ? "ready" : report.live ? "warning" : "danger";
  const authState = browserSessionState(report);
  const authTone = browserAuthTone(authState);
  const readinessLabel = report.ready ? "준비 완료" : report.live ? "준비 중" : "확인 필요";

  return `<section class="hc-hero" data-overall-state="${state}" data-status-tone="${overallTone}" aria-labelledby="bridge-state-heading">
    <div class="hc-hero-grid">
      <div>
        <p class="hc-hero-kicker">현재 브릿지 상태</p>
        <div class="hc-state-line">
          ${renderStatusGlyph(overallTone, "hc-state-icon")}
          <h2 id="bridge-state-heading">${title}</h2>
        </div>
        <p class="hc-hero-copy">${copy}</p>
        <p class="hc-runtime-note">실행 상태 · ${escapeHtml(formatRuntimeState(report.details.state))}</p>
      </div>
      <ul class="hc-status-list" aria-label="브릿지 준비 상태 요약">
        <li class="hc-status-item" data-status-tone="${serviceTone}"><span class="hc-status-label">서비스 상태</span><strong class="hc-status-value">${renderStatusGlyph(serviceTone, "hc-status-leading-icon")}${report.live ? "정상" : "오프라인"}</strong></li>
        <li class="hc-status-item" data-status-tone="${readinessTone}"><span class="hc-status-label">HA 준비 상태</span><strong class="hc-status-value">${renderStatusGlyph(readinessTone, "hc-status-leading-icon")}${readinessLabel}</strong></li>
        <li class="hc-status-item" data-status-tone="${authTone}"><span class="hc-status-label">브라우저 세션</span><strong class="hc-status-value">${renderStatusGlyph(authTone, "hc-status-leading-icon")}${browserSessionSummary(authState)}</strong></li>
      </ul>
    </div>
  </section>`;
}

function renderBrowserLoginAction(state: BrowserAuthState): string {
  const tone = browserAuthTone(state);
  const copy = state === "connected"
    ? { title: "브라우저 로그인됨", detail: "세션 유지 중 · 다시 열기" }
    : state === "required"
      ? { title: "브라우저 로그인 필요", detail: "로그인 세션을 확인하세요" }
      : state === "attention"
        ? { title: "브라우저 확인 필요", detail: "오류 상태 · 진단 확인" }
        : { title: "로그인 상태 확인 중", detail: "브라우저 상태를 확인합니다" };
  const aria = `${copy.title}. ${copy.detail}`;

  return `<a class="hc-login-link" data-auth-state="${state}" href="novnc-ui/vnc.html?autoconnect=1&amp;resize=scale&amp;path=websockify" aria-label="${escapeHtml(aria)}">
    ${renderStatusGlyph(tone, "hc-login-state-icon")}
    <span class="hc-login-copy"><strong>${copy.title}</strong><small>${copy.detail}</small></span>
  </a>`;
}

function browserSessionState(report: HealthReport): BrowserAuthState {
  if (report.details.state === "BROWSER_FAILED" || report.details.state === "FATAL") return "attention";
  if (
    report.details.state === "LOGIN_REQUIRED" ||
    report.details.state === "REAUTH_REQUIRED" ||
    report.details.sessionTouchLastOutcome === "reauth"
  ) return "required";
  if (report.details.authenticated) return "connected";
  return "checking";
}

function browserAuthTone(state: BrowserAuthState): StatusTone {
  if (state === "connected") return "ready";
  if (state === "checking") return "warning";
  return "danger";
}

function browserSessionSummary(state: BrowserAuthState): string {
  if (state === "connected") return "로그인 유지 중";
  if (state === "required") return "로그인 필요";
  if (state === "attention") return "확인 필요";
  return "확인 중";
}

function browserActionLabel(state: BrowserAuthState): string {
  if (state === "connected") return "브라우저 다시 열기";
  if (state === "required") return "브라우저 로그인";
  if (state === "attention") return "브라우저 확인";
  return "브라우저 상태 확인";
}

function renderStatusGlyph(tone: StatusTone, className: string): string {
  const shape = tone === "ready"
    ? '<circle cx="12" cy="12" r="9"></circle><path d="m8.5 12 2.3 2.3 4.8-5"></path>'
    : tone === "warning"
      ? '<circle cx="12" cy="12" r="9"></circle><path d="M12 7.5v5l3 1.8"></path>'
      : '<path d="M10.3 4.2 2.2 18.1A2 2 0 0 0 3.9 21h16.2a2 2 0 0 0 1.7-2.9L13.7 4.2a2 2 0 0 0-3.4 0Z"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path>';
  return `<span class="${className}" data-status-icon="${tone}" data-status-tone="${tone}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${shape}</svg></span>`;
}
'''
p.write_text(text[:start] + replacement + text[end:], encoding="utf-8")

# Startup/unavailable state: use the same white surface and neutral language.
replace_once(
    "addon/smartthings_web_bridge/rootfs/usr/share/smartthings-web/bridge-unavailable.html",
    '      --hc-shadow: 0 8px 32px #19243b08;\n      --hc-hero-bg: radial-gradient(ellipse at 95% -20%, #314774 0, transparent 63%), #182237;\n',
    '      --hc-shadow: 0 8px 32px #19243b08;\n',
)
replace_once(
    "addon/smartthings_web_bridge/rootfs/usr/share/smartthings-web/bridge-unavailable.html",
    '    .hc-hero { padding: 30px; border-radius: 24px; background: var(--hc-hero-bg); color: #fff; }\n    .hc-kicker { margin: 0 0 8px; color: #9fb9e7; font-size: 12px; font-weight: 750; }\n    .hc-status { display: flex; align-items: center; gap: 10px; }\n    .hc-status-icon { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 999px; background: #fff1cc; color: #775000; font-weight: 900; }\n    .hc-hero h2 { margin: 0; font-size: clamp(25px, 3vw, 34px); line-height: 1.28; font-weight: 780; letter-spacing: -0.04em; }\n    .hc-hero p:last-child { margin: 10px 0 0; color: #d8e2f3; max-width: 720px; }',
    '    .hc-hero { padding: 30px; border: 1px solid #efe2bd; border-radius: 24px; background: var(--hc-surface); color: var(--hc-ink); box-shadow: var(--hc-shadow); }\n    .hc-kicker { margin: 0 0 8px; color: var(--hc-muted); font-size: 12px; font-weight: 750; }\n    .hc-status { display: flex; align-items: center; gap: 12px; }\n    .hc-status-icon { width: 44px; height: 44px; display: grid; place-items: center; flex: 0 0 auto; border-radius: 14px; background: var(--hc-warning-soft); color: var(--hc-warning); font-weight: 900; }\n    .hc-status-icon svg { width: 24px; height: 24px; }\n    .hc-hero h2 { margin: 0; font-size: clamp(25px, 3vw, 34px); line-height: 1.28; font-weight: 780; letter-spacing: -0.04em; }\n    .hc-hero p:last-child { margin: 10px 0 0 56px; color: var(--hc-muted); max-width: 720px; }',
)
replace_once(
    "addon/smartthings_web_bridge/rootfs/usr/share/smartthings-web/bridge-unavailable.html",
    '        <span class="hc-status-icon" aria-hidden="true">…</span>',
    '        <span class="hc-status-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7.5v5l3 1.8"></path></svg></span>',
)
replace_once(
    "addon/smartthings_web_bridge/rootfs/usr/share/smartthings-web/bridge-unavailable.html",
    '      <p>로그인이 필요한 경우 브라우저 로그인 화면을 열 수 있습니다. 이 페이지는 5초마다 브릿지 상태를 다시 확인합니다.</p>\n      <a class="hc-button" id="login-link" href="novnc-ui/vnc.html?autoconnect=1&amp;resize=scale&amp;path=websockify">브라우저 로그인 열기</a>',
    '      <p>필요한 경우 원격 브라우저를 열어 현재 로그인 상태를 확인할 수 있습니다. 이 페이지는 5초마다 브릿지 상태를 다시 확인합니다.</p>\n      <a class="hc-button" id="login-link" href="novnc-ui/vnc.html?autoconnect=1&amp;resize=scale&amp;path=websockify">브라우저 상태 확인</a>',
)

# Health regressions.
replace_once(
    "bridge/tests/server/health.test.ts",
    '      state: "CONNECTED",\n      urlCategory: "smartthings_advanced",\n      activeConnections: 3,',
    '      state: "CONNECTED",\n      urlCategory: "smartthings_advanced",\n      authenticated: true,\n      activeConnections: 3,',
)
replace_once(
    "bridge/tests/server/health.test.ts",
    '      state: "BROWSER_FAILED",\n      urlCategory: "none",\n      activeConnections: 0,',
    '      state: "BROWSER_FAILED",\n      urlCategory: "none",\n      authenticated: false,\n      activeConnections: 0,',
)

# Status page regressions for white card, status assets, and session-aware login CTA.
p = Path("bridge/tests/server/status-page.test.ts")
text = p.read_text(encoding="utf-8")
anchor = '    expect(html).toContain("브릿지가 준비되었습니다");\n    expect(html).toContain("HA 연결됨");\n'
if anchor not in text:
    raise SystemExit("status-page.test.ts: guide-aligned assertion anchor missing")
text = text.replace(
    anchor,
    '    expect(html).toContain("브릿지가 정상적으로 준비되었습니다");\n'
    '    expect(html).toContain("HA 연결됨");\n'
    '    expect(html).toContain(\'data-auth-state="connected"\');\n'
    '    expect(html).toContain("브라우저 로그인됨");\n'
    '    expect(html).toContain("세션 유지 중 · 다시 열기");\n'
    '    expect(html).toContain(\'data-status-icon="ready"\');\n'
    '    expect(html).toContain("background: var(--hc-surface)");\n'
    '    expect(html).not.toContain("background: var(--hc-hero-bg)");\n',
    1,
)
insertion_anchor = '  test("distinguishes live-but-not-ready from unavailable without relying on color alone", () => {'
new_tests = r'''  test("keeps the browser action non-alarming while an authenticated session is maintained", () => {
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

'''
if insertion_anchor not in text:
    raise SystemExit("status-page.test.ts: insertion anchor missing")
text = text.replace(insertion_anchor, new_tests + insertion_anchor, 1)
p.write_text(text, encoding="utf-8")

# This script and its workflow are intentionally one-shot.
Path("tools/apply-bridge-white-status-session-ui.py").unlink()
Path(".github/workflows/apply-bridge-white-status-session-ui.yml").unlink()
