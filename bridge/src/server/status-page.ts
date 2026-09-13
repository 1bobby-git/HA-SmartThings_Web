import { readFileSync } from "node:fs";

import type { HealthReport } from "./health.js";

type OverallState = "ready" | "starting" | "attention";
type ProtocolState = "changed" | "discovering" | "verified";
type StatusTone = "ready" | "warning" | "danger";
type BrowserAuthState = "connected" | "required" | "checking" | "attention";

export interface StatusPageOptions {
  brandLogoPath?: string;
  brandLogoDataUri?: string;
}

const DEFAULT_BRAND_LOGO_PATH = "/usr/share/smartthings-web/brand/logo.png";

const DIAGNOSTIC_LABELS: Record<string, string> = {
  state: "브릿지 상태",
  urlCategory: "현재 페이지 유형",
  authenticated: "브라우저 로그인 상태",
  activeConnections: "활성 연결 수",
  observedDeviceCount: "관찰된 기기 수",
  decodedDeviceEventCount: "해석된 기기 이벤트",
  uniqueLogicalEventCount: "고유 이벤트",
  duplicateEventCount: "중복 이벤트",
  dedupeJournalSize: "중복 제거 기록 크기",
  protocolInvalidFrameCount: "잘못된 프로토콜 프레임",
  detailDiscoveryFailureCount: "상세 탐색 실패",
  protocolChangeCount: "프로토콜 변경 횟수",
  protocolMismatchSurface: "프로토콜 불일치 위치",
  nativeLoginPolicyState: "SmartThings 로그인 유지 설정",
  nativeLoginPolicyReason: "로그인 유지 설정 확인 결과",
  sessionTouchCount: "세션 유지 시도",
  sessionTouchConsecutiveFailures: "연속 세션 유지 실패",
  sessionTouchLastOutcome: "최근 세션 유지 결과",
  sessionTouchAgeMs: "최근 세션 유지 시점",
  sessionTouchSuccessAgeMs: "최근 세션 유지 성공 시점",
  restartCount: "재시작 횟수",
  architectureVersion: "아키텍처 버전",
  advancedInventoryDeviceCount: "고급 인벤토리 기기 수",
  advancedInventoryLocationCount: "고급 인벤토리 위치 수",
  advancedInventoryPageCount: "고급 인벤토리 페이지 수",
  adapterFailureCount: "어댑터 실패",
  pendingCommandCount: "대기 중 명령",
  domFallbackCount: "DOM 대체 경로 사용",
  reconnectCount: "재연결 횟수",
  lastReconnectAtMs: "최근 재연결 시각(ms)",
  lastCommandTransport: "최근 명령 전송 방식",
  lastCommandConfirmation: "최근 명령 확인 방식",
  bridgeVersion: "브릿지 버전",
  browserVersion: "브라우저 버전",
  protocolVersion: "프로토콜 버전",
  heartbeatAgeMs: "하트비트 경과 시간",
  snapshotAgeMs: "상태 스냅샷 경과 시간",
  initialSnapshotAgeMs: "초기 스냅샷 경과 시간",
  lastSnapshotAgeMs: "최근 스냅샷 경과 시간",
  frameAgeMs: "최근 프레임 경과 시간",
  eventAgeMs: "최근 이벤트 경과 시간",
  parserAgeMs: "최근 파서 성공 경과 시간",
  pushAgeMs: "최근 푸시 경과 시간",
  browserUptimeMs: "브라우저 실행 시간"
};

export function renderStatusPage(report: HealthReport, options: StatusPageOptions = {}): string {
  const overallState = overallPanelState(report);
  const protocolPanel = renderProtocolPanel(report);
  const logoDataUri = options.brandLogoDataUri ?? loadBrandLogoDataUri(options.brandLogoPath);
  const diagnosticRows = Object.entries(report.details)
    .map(
      ([key, value]) => `<div class="hc-diagnostic-row">
        <dt>${escapeHtml(formatDiagnosticLabel(key))}</dt>
        <dd>${escapeHtml(formatDiagnosticValue(key, value))}</dd>
      </div>`
    )
    .join("");

  const brand = logoDataUri
    ? `<img class="hc-brand-logo" src="${escapeHtml(logoDataUri)}" alt="SmartThings Web Bridge">`
    : `<span class="hc-brand-fallback">SmartThings Web Bridge</span>`;
  const connectionText = report.ready ? "HA 연결됨" : report.live ? "HA 연결 준비 중" : "HA 확인 필요";
  const browserAuthState = browserSessionState(report);
  const browserLoginAction = renderBrowserLoginAction(browserAuthState);
  const browserSecondaryLabel = browserActionLabel(browserAuthState);

  return `<!doctype html>
<html lang="ko-KR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>SmartThings Web Bridge</title>
  <style>
    :root {
      color-scheme: light;
      --hc-bg: #f7f8fa;
      --hc-surface: #ffffff;
      --hc-ink: #191f28;
      --hc-muted: #667182;
      --hc-line: #e9ecf1;
      --hc-soft: #f1f3f6;
      --hc-blue: #2563eb;
      --hc-blue-soft: #edf3ff;
      --hc-green: #147455;
      --hc-green-soft: #e9f6ef;
      --hc-danger: #b4233d;
      --hc-danger-soft: #fff0f2;
      --hc-warning: #805500;
      --hc-warning-soft: #fff4dc;
      --hc-focus: #2563eb;
      --hc-shadow: 0 8px 32px #19243b08;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        color-scheme: dark;
        --hc-bg: #11151c;
        --hc-surface: #1b222c;
        --hc-ink: #f1f4fa;
        --hc-muted: #afbacb;
        --hc-line: #303b4b;
        --hc-soft: #252e3c;
        --hc-blue: #91b6ff;
        --hc-blue-soft: #233b61;
        --hc-green: #89d8b5;
        --hc-green-soft: #1c3b31;
        --hc-danger: #ffacb9;
        --hc-danger-soft: #432936;
        --hc-warning: #f8d992;
        --hc-warning-soft: #3a3020;
        --hc-focus: #91b6ff;
        --hc-shadow: none;
      }
    }

    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; background: var(--hc-bg); }
    body {
      margin: 0;
      min-width: 0;
      background: var(--hc-bg);
      color: var(--hc-ink);
      font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Pretendard", "Noto Sans KR", "Noto Sans CJK KR", "Malgun Gothic", sans-serif;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }
    a { color: inherit; }
    button, a { -webkit-tap-highlight-color: transparent; }
    button, input, select, textarea { font: inherit; }
    :focus-visible { outline: 3px solid var(--hc-focus); outline-offset: 3px; }

    .hc-skip-link {
      position: fixed;
      left: 16px;
      top: 12px;
      z-index: 100;
      transform: translateY(-160%);
      padding: 10px 14px;
      border-radius: 10px;
      background: #ffffff;
      color: #191f28;
      box-shadow: 0 8px 24px #19243b20;
    }
    .hc-skip-link:focus { transform: translateY(0); }

    .hc-container {
      width: 100%;
      max-width: 1248px;
      margin: 0 auto;
      padding-inline: 40px;
    }

    .hc-header-surface {
      width: 100%;
      background: #ffffff;
      color: #191f28;
      border-bottom: 1px solid #e9ecf1;
    }
    .hc-topbar {
      min-height: 76px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 22px;
    }
    .hc-brand {
      min-width: 0;
      display: inline-flex;
      align-items: center;
      text-decoration: none;
    }
    .hc-brand-logo {
      display: block;
      width: auto;
      height: 38px;
      max-width: min(280px, 44vw);
      object-fit: contain;
      object-position: left center;
    }
    .hc-brand-fallback { font-size: 18px; font-weight: 750; letter-spacing: -0.03em; }
    .hc-header-actions { display: flex; align-items: center; justify-content: flex-end; gap: 12px; }
    .hc-connection {
      min-height: 44px;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: #667182;
      font-size: 13px;
      font-weight: 700;
      white-space: nowrap;
    }
    .hc-connection-dot { width: 7px; height: 7px; border-radius: 999px; background: #147455; }
    .hc-connection[data-state="starting"] .hc-connection-dot { background: #c18400; }
    .hc-connection[data-state="attention"] .hc-connection-dot { background: #b4233d; }
    .hc-version {
      padding: 4px 8px;
      border-radius: 6px;
      background: #f1f3f6;
      color: #667182;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .hc-login-link {
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

    .hc-tabs { min-height: 48px; display: flex; align-items: end; gap: 30px; }
    .hc-tab {
      position: relative;
      min-height: 48px;
      display: inline-flex;
      align-items: center;
      color: #667182;
      font-size: 14px;
      font-weight: 700;
      text-decoration: none;
    }
    .hc-tab:hover { color: #191f28; }
    .hc-tab[aria-current="page"] { color: #191f28; font-weight: 800; }
    .hc-tab[aria-current="page"]::after {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 3px;
      border-radius: 99px 99px 0 0;
      background: #191f28;
    }

    .hc-main { padding-top: 38px; padding-bottom: 48px; }
    .hc-title-row { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 26px; }
    .hc-title-block { max-width: 760px; }
    .hc-eyebrow { margin: 0 0 8px; color: var(--hc-blue); font-size: 12px; font-weight: 800; letter-spacing: .12em; }
    h1 { margin: 0; font-size: clamp(28px, 4vw, 38px); line-height: 1.3; font-weight: 780; letter-spacing: -0.045em; word-break: keep-all; }
    .hc-lead { margin: 10px 0 0; color: var(--hc-muted); max-width: 720px; }

    .hc-hero {
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

    .hc-section { margin-top: 34px; }
    .hc-section-heading { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 14px; }
    .hc-section-heading h2 { margin: 0; font-size: 22px; line-height: 1.4; font-weight: 760; letter-spacing: -0.035em; }
    .hc-section-heading p { margin: 5px 0 0; color: var(--hc-muted); }
    .hc-card { border: 1px solid var(--hc-line); border-radius: 19px; background: var(--hc-surface); box-shadow: var(--hc-shadow); }

    .hc-summary-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); overflow: hidden; }
    .hc-summary-item { min-width: 0; padding: 22px 24px; }
    .hc-summary-item + .hc-summary-item { border-left: 1px solid var(--hc-line); }
    .hc-summary-label { margin: 0 0 5px; color: var(--hc-muted); font-size: 13px; font-weight: 700; }
    .hc-summary-value { margin: 0; font-size: 24px; font-weight: 780; letter-spacing: -0.025em; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
    .hc-summary-support { margin: 4px 0 0; color: var(--hc-muted); font-size: 12px; }

    .hc-integration { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 22px; align-items: center; padding: 24px; }
    .hc-integration h3 { margin: 0; font-size: 19px; font-weight: 760; letter-spacing: -0.03em; }
    .hc-integration p { margin: 6px 0 0; color: var(--hc-muted); }
    .hc-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
    .hc-button { min-height: 50px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 0 18px; border: 1px solid transparent; border-radius: 12px; font-weight: 760; cursor: pointer; text-decoration: none; }
    .hc-button-primary { background: #2563eb; color: #ffffff; }
    .hc-button-primary:hover { filter: brightness(.96); }
    .hc-button-primary:disabled { cursor: wait; opacity: .7; }
    .hc-button-secondary { border-color: var(--hc-line); background: var(--hc-soft); color: var(--hc-ink); }
    .hc-button-secondary:hover { border-color: var(--hc-blue); color: var(--hc-blue); }
    .hc-pairing { grid-column: 1 / -1; min-height: 48px; display: flex; align-items: center; gap: 12px; margin-top: -2px; padding: 12px 14px; border-radius: 12px; background: var(--hc-soft); color: var(--hc-muted); }
    .hc-pairing[data-state="success"] { background: var(--hc-green-soft); color: var(--hc-green); }
    .hc-pairing[data-state="error"] { background: var(--hc-danger-soft); color: var(--hc-danger); }
    .hc-pairing-code { color: var(--hc-ink); font: 800 20px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: .12em; font-variant-numeric: tabular-nums; }

    .hc-protocol { overflow: hidden; }
    .hc-protocol-summary { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 13px; padding: 20px 24px; }
    .hc-protocol-icon { width: 36px; height: 36px; display: grid; place-items: center; border-radius: 999px; font-weight: 900; }
    .hc-protocol[data-protocol-state="verified"] .hc-protocol-icon { background: var(--hc-green-soft); color: var(--hc-green); }
    .hc-protocol[data-protocol-state="discovering"] .hc-protocol-icon { background: var(--hc-warning-soft); color: var(--hc-warning); }
    .hc-protocol[data-protocol-state="changed"] .hc-protocol-icon { background: var(--hc-danger-soft); color: var(--hc-danger); }
    .hc-protocol-title { margin: 0; font-size: 17px; font-weight: 780; }
    .hc-protocol-copy { margin: 3px 0 0; color: var(--hc-muted); font-size: 13px; }
    .hc-protocol-meta { text-align: right; color: var(--hc-muted); font-size: 12px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
    .hc-protocol-alert { margin: 0 24px 20px; padding: 12px 14px; border-radius: 12px; background: var(--hc-danger-soft); color: var(--hc-danger); }
    .hc-protocol-alert p { margin: 3px 0; }

    .hc-details { overflow: hidden; }
    .hc-details summary { min-height: 54px; display: flex; align-items: center; gap: 10px; padding: 0 24px; cursor: pointer; font-weight: 760; list-style: none; }
    .hc-details summary::-webkit-details-marker { display: none; }
    .hc-details summary::after { content: "+"; margin-left: auto; color: var(--hc-muted); font-size: 20px; }
    .hc-details[open] summary::after { content: "−"; }
    .hc-details[open] summary { border-bottom: 1px solid var(--hc-line); }
    .hc-diagnostic-list { margin: 0; }
    .hc-diagnostic-row { display: grid; grid-template-columns: minmax(180px, 300px) minmax(0, 1fr); gap: 24px; padding: 13px 24px; border-bottom: 1px solid var(--hc-line); }
    .hc-diagnostic-row:last-child { border-bottom: 0; }
    .hc-diagnostic-row dt { color: var(--hc-muted); font-size: 13px; font-weight: 700; }
    .hc-diagnostic-row dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
    .hc-footer { margin-top: 28px; padding-top: 18px; border-top: 1px solid var(--hc-line); color: var(--hc-muted); font-size: 12px; }

    @media (max-width: 870px) {
      .hc-container { padding-inline: 28px; }
      .hc-hero-grid { grid-template-columns: 1fr; }
      .hc-status-list { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .hc-status-item { display: block; }
      .hc-status-value { display: block; margin-top: 4px; text-align: left; }
      .hc-summary-grid { grid-template-columns: 1fr; }
      .hc-summary-item + .hc-summary-item { border-left: 0; border-top: 1px solid var(--hc-line); }
      .hc-integration { grid-template-columns: 1fr; }
      .hc-actions { justify-content: flex-start; }
    }

    @media (max-width: 560px) {
      .hc-container { padding-inline: 20px; }
      .hc-topbar { min-height: 68px; }
      .hc-brand-logo { height: 32px; max-width: 52vw; }
      .hc-version, .hc-header-actions .hc-login-link { display: none; }
      .hc-connection { font-size: 12px; }
      .hc-tabs { gap: 24px; overflow-x: auto; }
      .hc-main { padding-top: 28px; padding-bottom: 36px; }
      .hc-title-row { margin-bottom: 22px; }
      .hc-hero { padding: 22px 20px; border-radius: 20px; }
      .hc-status-list { grid-template-columns: 1fr; }
      .hc-section { margin-top: 28px; }
      .hc-summary-item, .hc-integration, .hc-protocol-summary { padding-inline: 16px; }
      .hc-actions { align-items: stretch; }
      .hc-button { width: 100%; }
      .hc-pairing { align-items: flex-start; flex-direction: column; }
      .hc-protocol-summary { grid-template-columns: auto minmax(0, 1fr); }
      .hc-protocol-meta { grid-column: 2; text-align: left; }
      .hc-protocol-alert { margin-inline: 16px; }
      .hc-details summary { padding-inline: 16px; }
      .hc-diagnostic-row { grid-template-columns: 1fr; gap: 2px; padding-inline: 16px; }
      .hc-diagnostic-row dd { text-align: left; }
    }

    @media (max-width: 350px) { .hc-container { padding-inline: 16px; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; } }
    @media (forced-colors: active) { .hc-card, .hc-status-item, .hc-button-secondary, .hc-login-link, .hc-state-icon, .hc-status-leading-icon { border: 1px solid CanvasText; } .hc-button-primary { border: 1px solid ButtonText; } }
  </style>
</head>
<body>
  <a class="hc-skip-link" href="#main-content">브릿지 상태로 건너뛰기</a>

  <header class="hc-header-surface">
    <div class="hc-container">
      <div class="hc-topbar">
        <a class="hc-brand" href="#overview" aria-label="SmartThings Web Bridge 홈">${brand}</a>
        <div class="hc-header-actions">
          <span class="hc-connection" data-state="${overallState}"><span class="hc-connection-dot" aria-hidden="true"></span>${connectionText}</span>
          <span class="hc-version">v${escapeHtml(report.details.bridgeVersion)}</span>
          ${browserLoginAction}
        </div>
      </div>
      <nav class="hc-tabs" aria-label="페이지 바로가기">
        <a class="hc-tab" href="#overview" aria-current="page">한눈에</a>
        <a class="hc-tab" href="#ha-integration">HA 연결</a>
        <a class="hc-tab" href="#diagnostics">진단</a>
      </nav>
    </div>
  </header>

  <main id="main-content" class="hc-container hc-main">
    <div class="hc-title-row">
      <div class="hc-title-block">
        <p class="hc-eyebrow">BRIDGE STATUS</p>
        <h1>SmartThings 연결 상태를 한눈에.</h1>
        <p class="hc-lead">브릿지 준비 상태와 Home Assistant 연결 상태를 먼저 확인하고, 필요한 경우에만 상세 진단을 열어보세요.</p>
      </div>
    </div>

    <div id="overview">${renderOverallPanel(report, overallState)}</div>

    <section class="hc-section" aria-labelledby="overview-heading">
      <div class="hc-section-heading">
        <div>
          <h2 id="overview-heading">현재 상태</h2>
          <p>자주 확인하는 핵심 정보만 간단히 표시합니다.</p>
        </div>
      </div>
      <div class="hc-card hc-summary-grid">
        <div class="hc-summary-item">
          <p class="hc-summary-label">관찰된 기기</p>
          <p class="hc-summary-value">${formatNumber(report.details.observedDeviceCount)}</p>
          <p class="hc-summary-support">고급 인벤토리 ${formatNumber(report.details.advancedInventoryDeviceCount)}개</p>
        </div>
        <div class="hc-summary-item">
          <p class="hc-summary-label">활성 연결</p>
          <p class="hc-summary-value">${formatNumber(report.details.activeConnections)}</p>
          <p class="hc-summary-support">대기 중 명령 ${formatNumber(report.details.pendingCommandCount)}개</p>
        </div>
        <div class="hc-summary-item">
          <p class="hc-summary-label">최근 푸시</p>
          <p class="hc-summary-value">${formatDuration(report.details.pushAgeMs)}</p>
          <p class="hc-summary-support">재연결 ${formatNumber(report.details.reconnectCount)}회</p>
        </div>
      </div>
    </section>

    <section id="ha-integration" class="hc-section" aria-labelledby="integration-heading">
      <div class="hc-section-heading">
        <div>
          <h2 id="integration-heading">Home Assistant 연결</h2>
          <p>브릿지를 Home Assistant 통합과 연결하거나 브라우저 로그인을 열 수 있습니다.</p>
        </div>
      </div>
      <div class="hc-card hc-integration">
        <div>
          <h3>페어링 코드로 연결하기</h3>
          <p id="pairing-help">8자리 코드를 생성하면 10분 동안 사용할 수 있습니다.</p>
        </div>
        <div class="hc-actions">
          <button class="hc-button hc-button-primary" id="pairing-button" type="button" aria-describedby="pairing-help pairing-result">페어링 코드 생성</button>
          <a class="hc-button hc-button-secondary" href="novnc-ui/vnc.html?autoconnect=1&amp;resize=scale&amp;path=websockify">${browserSecondaryLabel}</a>
        </div>
        <div class="hc-pairing" id="pairing-result" role="status" aria-live="polite" data-state="idle">
          <span>페어링 코드</span>
          <strong class="hc-pairing-code">—</strong>
        </div>
      </div>
    </section>

    ${renderNativeLoginPolicy(report)}

    <section class="hc-section" aria-labelledby="protocol-heading">
      <div class="hc-section-heading">
        <div>
          <h2 id="protocol-heading">연결 무결성</h2>
          <p>SmartThings 프로토콜 호환성과 준비 상태 근거입니다.</p>
        </div>
      </div>
      ${protocolPanel}
    </section>

    <section id="diagnostics" class="hc-section" aria-labelledby="diagnostics-heading">
      <div class="hc-section-heading">
        <div>
          <h2 id="diagnostics-heading">상세 진단</h2>
          <p>일상적인 상태 확인에는 필요 없는 기술 정보는 기본적으로 접어둡니다.</p>
        </div>
      </div>
      <details class="hc-card hc-details">
        <summary>기술 세부 정보 보기</summary>
        <dl class="hc-diagnostic-list">${diagnosticRows}</dl>
      </details>
    </section>

    <footer class="hc-footer">아키텍처 ${escapeHtml(report.details.architectureVersion)} · 브라우저 ${escapeHtml(report.details.browserVersion)}</footer>
  </main>

  <script>
    const pairingButton = document.getElementById("pairing-button");
    const pairingResult = document.getElementById("pairing-result");
    const pairingCode = pairingResult.querySelector(".hc-pairing-code");

    pairingButton.addEventListener("click", async () => {
      pairingButton.disabled = true;
      pairingButton.setAttribute("aria-busy", "true");
      pairingResult.dataset.state = "idle";
      pairingCode.textContent = "생성 중…";
      try {
        const response = await fetch("api/v1/pairing-code", { method: "POST", credentials: "same-origin" });
        const body = await response.json();
        if (response.ok && /^\\d{8}$/.test(body.code)) {
          pairingResult.dataset.state = "success";
          pairingCode.textContent = body.code;
        } else {
          pairingResult.dataset.state = "error";
          pairingCode.textContent = "코드를 생성하지 못했습니다";
        }
      } catch {
        pairingResult.dataset.state = "error";
        pairingCode.textContent = "코드를 생성하지 못했습니다";
      } finally {
        pairingButton.disabled = false;
        pairingButton.removeAttribute("aria-busy");
      }
    });
  </script>
</body>
</html>`;
}

function renderOverallPanel(report: HealthReport, state: OverallState): string {
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

function renderProtocolPanel(report: HealthReport): string {
  const state = protocolPanelState(report);
  const title = state === "changed" ? "프로토콜 변경이 감지되었습니다" : state === "discovering" ? "프로토콜을 확인하고 있습니다" : "프로토콜이 확인되었습니다";
  const readiness = report.ready ? "준비 상태 허용됨" : "준비 상태 차단됨";
  const icon = state === "verified" ? "✓" : state === "discovering" ? "…" : "!";
  const explanation = state === "verified"
    ? "현재 관찰된 SmartThings 프로토콜은 브릿지와 호환됩니다."
    : state === "discovering"
      ? "프로토콜 확인이 진행 중이며 완료될 때까지 준비 상태가 제한될 수 있습니다."
      : "관찰된 SmartThings 프로토콜이 검증된 형태와 다릅니다. 계속하기 전에 불일치 항목을 확인하세요.";
  const mismatchSurface = state === "changed" && report.details.protocolMismatchSurface
    ? `<p>불일치 위치: ${escapeHtml(report.details.protocolMismatchSurface)}</p>`
    : "";
  const phase2 = state === "changed" ? "<p>Phase 2는 계속 차단됨</p>" : "";
  const alert = state === "changed"
    ? `<div class="hc-protocol-alert" role="alert"><p>${readiness}</p>${phase2}${mismatchSurface}</div>`
    : "";

  return `<div class="hc-card hc-protocol" data-protocol-state="${state}">
    <div class="hc-protocol-summary">
      <span class="hc-protocol-icon" aria-hidden="true">${icon}</span>
      <div>
        <p class="hc-protocol-title">${title}</p>
        <p class="hc-protocol-copy">${explanation} ${readiness}.</p>
      </div>
      <div class="hc-protocol-meta">버전 ${escapeHtml(report.details.protocolVersion)}<br>변경 ${String(report.details.protocolChangeCount)}회</div>
    </div>
    ${alert}
  </div>`;
}

function overallPanelState(report: HealthReport): OverallState {
  if (report.ready) return "ready";
  if (report.live) return "starting";
  return "attention";
}

function protocolPanelState(report: HealthReport): ProtocolState {
  if (report.details.state === "PROTOCOL_CHANGED") return "changed";
  if (report.details.protocolVersion.endsWith(":discovering")) return "discovering";
  return "verified";
}

function formatRuntimeState(value: HealthReport["details"]["state"]): string {
  const labels: Record<HealthReport["details"]["state"], string> = {
    STARTING: "시작 중",
    BROWSER_STARTING: "브라우저 시작 중",
    LOGIN_REQUIRED: "로그인 필요",
    AUTHENTICATING: "인증 중",
    PAGE_LOADING: "페이지 불러오는 중",
    DISCOVERING_PROTOCOL: "프로토콜 확인 중",
    SYNCING: "동기화 중",
    CONNECTED: "연결됨",
    STALE: "상태 갱신 필요",
    RECONNECTING: "재연결 중",
    REAUTH_REQUIRED: "재인증 필요",
    PROTOCOL_CHANGED: "프로토콜 변경 감지",
    BROWSER_FAILED: "브라우저 오류",
    FATAL: "치명적 오류"
  };
  return labels[value];
}

const NATIVE_POLICY_LABELS: Record<string, string> = {
  disabled: "자동 적용 꺼짐", pending: "로그인 후 확인 예정", enabled: "로그인 유지 켜짐 확인", attention: "설정 확인 필요",
  not_checked: "이 브라우저에서 아직 확인하지 않았습니다.", automation_disabled: "자동 적용을 끈 상태입니다. 웹의 기존 설정은 변경하지 않습니다.",
  already_enabled: "SmartThings 웹 설정이 이미 켜져 있어 변경하지 않았습니다.",
  enabled_and_verified: "웹 설정을 켜고 페이지를 다시 열어 유지되는 것을 확인했습니다.",
  browser_unsupported: "브라우저에서 설정을 직접 확인해 주세요.", invalid_target: "기기 화면에서 다시 확인해야 합니다.",
  settings_not_found: "SmartThings 설정 버튼을 찾지 못했습니다.", control_not_found: "로그인 유지 스위치를 확인하지 못했습니다.",
  ambiguous: "설정 대상이 명확하지 않아 변경하지 않았습니다.", blocked: "다른 창이나 사용자 입력이 있어 변경하지 않았습니다.",
  state_unknown: "스위치의 켜짐 여부를 판독하지 못했습니다.", not_saved: "설정 저장을 확인하지 못했습니다.",
  page_changed: "페이지 또는 인증 상태가 바뀌어 확인을 중단했습니다.", ui_timeout: "설정 확인이 지연되어 중단했습니다."
};

function renderNativeLoginPolicy(report: HealthReport): string {
  const state = report.details.nativeLoginPolicyState ?? "pending";
  const reason = report.details.nativeLoginPolicyReason ?? "not_checked";
  // Green means a verified preference in the active authenticated document,
  // never that this account has an unlimited server-side session.
  const effective = !report.details.authenticated && state === "enabled" ? "pending" : state;
  const tone: StatusTone = effective === "enabled" ? "ready" : "warning";
  return `<section class="hc-section" aria-labelledby="native-login-heading">
    <div class="hc-card hc-integration" data-native-login-policy="${escapeHtml(effective)}">
      <div><h3 id="native-login-heading">SmartThings 로그인 유지</h3>
        <p class="hc-status-value">${renderStatusGlyph(tone, "hc-status-leading-icon")}${escapeHtml(NATIVE_POLICY_LABELS[effective] ?? NATIVE_POLICY_LABELS.pending!)}</p>
        <p>${escapeHtml(NATIVE_POLICY_LABELS[effective !== state ? "not_checked" : reason] ?? NATIVE_POLICY_LABELS.not_checked!)}</p>
        <p>브릿지 내부 브라우저의 웹 설정입니다. 브라우저 종료 후 인증 복원과는 별개이며, 재시작 후 다시 확인합니다.</p>
      </div>
      <div class="hc-actions"><a class="hc-button hc-button-secondary" href="novnc-ui/vnc.html?autoconnect=1&amp;resize=scale&amp;path=websockify">브라우저에서 설정 확인</a>
        <a class="hc-button hc-button-secondary" href=".">상태 다시 확인</a></div>
    </div>
  </section>`;
}

function formatDiagnosticLabel(value: string): string {
  return DIAGNOSTIC_LABELS[value] ?? value;
}

function formatDiagnosticValue(key: string, value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if ((key === "nativeLoginPolicyState" || key === "nativeLoginPolicyReason") && typeof value === "string") return NATIVE_POLICY_LABELS[value] ?? "확인 필요";
  if (key === "state" && typeof value === "string") return formatRuntimeState(value as HealthReport["details"]["state"]);
  if (key === "urlCategory" && typeof value === "string") return formatUrlCategory(value);
  if (key === "sessionTouchLastOutcome" && typeof value === "string") return formatSessionOutcome(value);
  if (key.endsWith("AgeMs") || key === "browserUptimeMs") return typeof value === "number" ? formatDuration(value) : String(value);
  if (typeof value === "boolean") return value ? "예" : "아니요";
  return String(value);
}

function formatUrlCategory(value: string): string {
  const labels: Record<string, string> = {
    none: "없음",
    smartthings_location: "SmartThings 위치",
    smartthings_advanced: "SmartThings 고급 페이지",
    samsung_login: "Samsung 로그인",
    other: "기타",
    error: "오류"
  };
  return labels[value] ?? value;
}

function formatSessionOutcome(value: string): string {
  const labels: Record<string, string> = { ok: "정상", failed: "실패", reauth: "재인증 필요", stale: "갱신 필요" };
  return labels[value] ?? value;
}

function formatNumber(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
}

function formatDuration(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const milliseconds = Math.max(0, value);
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${Math.round(seconds)}초 전`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}분 전`;
  return `${Math.round(minutes / 60)}시간 전`;
}

function loadBrandLogoDataUri(path = DEFAULT_BRAND_LOGO_PATH): string | undefined {
  try {
    const image = readFileSync(path);
    return `data:image/png;base64,${image.toString("base64")}`;
  } catch {
    return undefined;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
