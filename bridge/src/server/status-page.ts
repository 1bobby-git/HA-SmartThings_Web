import type { HealthReport } from "./health.js";

type OverallState = "ready" | "starting" | "attention";
type ProtocolState = "changed" | "discovering" | "verified";

export function renderStatusPage(report: HealthReport): string {
  const overallState = overallPanelState(report);
  const protocolPanel = renderProtocolPanel(report);
  const diagnosticRows = Object.entries(report.details)
    .map(
      ([key, value]) => `<div class="hc-diagnostic-row">
        <dt>${escapeHtml(formatDiagnosticLabel(key))}</dt>
        <dd>${escapeHtml(formatDiagnosticValue(value))}</dd>
      </div>`
    )
    .join("");

  return `<!doctype html>
<html lang="en">
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
      --hc-primary-bg: #2563eb;
      --hc-primary-ink: #ffffff;
      --hc-focus: #2563eb;
      --hc-shadow: 0 8px 32px #19243b05;
      --hc-hero-bg: radial-gradient(ellipse at 95% -20%, #314774 0, transparent 63%), #182237;
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
    html { background: var(--hc-bg); }
    body {
      margin: 0;
      min-width: 0;
      background: var(--hc-bg);
      color: var(--hc-ink);
      font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Pretendard", "Noto Sans CJK KR", "Malgun Gothic", sans-serif;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }
    a { color: var(--hc-blue); text-underline-offset: 3px; }
    button, a { -webkit-tap-highlight-color: transparent; }
    button, input, select, textarea { font: inherit; }
    :focus-visible { outline: 3px solid var(--hc-focus); outline-offset: 3px; }

    .hc-skip-link {
      position: fixed;
      left: 16px;
      top: 12px;
      z-index: 10;
      transform: translateY(-160%);
      padding: 10px 14px;
      border-radius: 10px;
      background: var(--hc-surface);
      color: var(--hc-ink);
      box-shadow: var(--hc-shadow);
    }
    .hc-skip-link:focus { transform: translateY(0); }

    .hc-shell {
      width: 100%;
      max-width: 1248px;
      margin: 0 auto;
      padding: 0 40px 48px;
    }
    .hc-header {
      min-height: 94px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      border-bottom: 1px solid var(--hc-line);
    }
    .hc-brand {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .hc-brand-name {
      min-width: 0;
      font-weight: 750;
      letter-spacing: -0.025em;
      overflow-wrap: anywhere;
    }
    .hc-version {
      flex: 0 0 auto;
      padding: 4px 8px;
      border-radius: 6px;
      background: var(--hc-soft);
      color: var(--hc-muted);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .hc-login-link {
      min-height: 44px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 8px 12px;
      border-radius: 12px;
      font-weight: 700;
      text-decoration: none;
      white-space: nowrap;
    }
    .hc-login-link:hover { background: var(--hc-blue-soft); }

    .hc-main { padding-top: 40px; }
    .hc-title-block { max-width: 760px; margin-bottom: 30px; }
    .hc-eyebrow {
      margin: 0 0 8px;
      color: var(--hc-blue);
      font-size: 13px;
      font-weight: 750;
      letter-spacing: .045em;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      font-size: clamp(28px, 4vw, 38px);
      line-height: 1.35;
      font-weight: 750;
      letter-spacing: -0.045em;
      word-break: keep-all;
    }
    .hc-lead { margin: 12px 0 0; color: var(--hc-muted); max-width: 680px; }

    .hc-hero {
      position: relative;
      overflow: hidden;
      margin-bottom: 36px;
      padding: 28px;
      border-radius: 24px;
      background: var(--hc-hero-bg);
      color: #ffffff;
    }
    .hc-hero-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.5fr) minmax(280px, .8fr);
      gap: 28px;
      align-items: end;
    }
    .hc-state-line { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
    .hc-state-icon {
      width: 28px;
      height: 28px;
      display: inline-grid;
      place-items: center;
      border-radius: 999px;
      font-size: 16px;
      font-weight: 900;
    }
    .hc-hero[data-overall-state="ready"] .hc-state-icon { background: #dff7ea; color: #0b6849; }
    .hc-hero[data-overall-state="starting"] .hc-state-icon { background: #fff1cc; color: #775000; }
    .hc-hero[data-overall-state="attention"] .hc-state-icon { background: #ffe1e6; color: #9d1731; }
    .hc-hero h2 { margin: 0; font-size: 32px; line-height: 1.25; font-weight: 750; letter-spacing: -0.04em; }
    .hc-hero-copy { margin: 8px 0 0; color: #d8e2f3; max-width: 620px; }
    .hc-status-list {
      display: grid;
      gap: 8px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .hc-status-item {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      padding: 10px 12px;
      border: 1px solid #ffffff22;
      border-radius: 12px;
      background: #ffffff0c;
    }
    .hc-status-label { color: #c7d3e7; }
    .hc-status-value { text-align: right; font-weight: 750; overflow-wrap: anywhere; }

    .hc-section { margin-top: 36px; }
    .hc-section-heading { margin: 0 0 16px; }
    .hc-section-heading h2 { margin: 0; font-size: 23px; line-height: 1.4; font-weight: 720; letter-spacing: -0.035em; }
    .hc-section-heading p { margin: 6px 0 0; color: var(--hc-muted); }
    .hc-card {
      border: 1px solid var(--hc-line);
      border-radius: 19px;
      background: var(--hc-surface);
      box-shadow: var(--hc-shadow);
    }
    .hc-summary-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      overflow: hidden;
    }
    .hc-summary-item { min-width: 0; padding: 22px 24px; }
    .hc-summary-item + .hc-summary-item { border-left: 1px solid var(--hc-line); }
    .hc-summary-label { margin: 0 0 5px; color: var(--hc-muted); font-size: 13px; font-weight: 700; }
    .hc-summary-value {
      margin: 0;
      font-size: 23px;
      font-weight: 750;
      letter-spacing: -0.025em;
      font-variant-numeric: tabular-nums;
      overflow-wrap: anywhere;
    }
    .hc-summary-support { margin: 4px 0 0; color: var(--hc-muted); font-size: 12px; }

    .hc-integration {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 24px;
      align-items: center;
      padding: 24px;
    }
    .hc-integration h2 { margin: 0; font-size: 23px; line-height: 1.4; font-weight: 720; letter-spacing: -0.035em; }
    .hc-integration p { margin: 6px 0 0; color: var(--hc-muted); }
    .hc-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
    .hc-button {
      min-height: 50px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 0 18px;
      border: 1px solid transparent;
      border-radius: 12px;
      font-weight: 750;
      cursor: pointer;
      text-decoration: none;
    }
    .hc-button-primary { background: var(--hc-primary-bg); color: var(--hc-primary-ink); }
    .hc-button-primary:hover { filter: brightness(.96); }
    .hc-button-primary:disabled { cursor: wait; opacity: .7; }
    .hc-button-secondary { border-color: var(--hc-line); background: var(--hc-soft); color: var(--hc-ink); }
    .hc-button-secondary:hover { border-color: var(--hc-blue); color: var(--hc-blue); }
    .hc-pairing {
      grid-column: 1 / -1;
      min-height: 48px;
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: -4px;
      padding: 12px 14px;
      border-radius: 12px;
      background: var(--hc-soft);
      color: var(--hc-muted);
    }
    .hc-pairing[data-state="success"] { background: var(--hc-green-soft); color: var(--hc-green); }
    .hc-pairing[data-state="error"] { background: var(--hc-danger-soft); color: var(--hc-danger); }
    .hc-pairing-code {
      color: var(--hc-ink);
      font: 800 20px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      letter-spacing: .12em;
      font-variant-numeric: tabular-nums;
    }

    .hc-protocol {
      padding: 0;
      overflow: hidden;
    }
    .hc-protocol-summary {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 12px;
      padding: 20px 24px;
    }
    .hc-protocol-icon {
      width: 36px;
      height: 36px;
      display: grid;
      place-items: center;
      border-radius: 999px;
      font-weight: 900;
    }
    .hc-protocol[data-protocol-state="verified"] .hc-protocol-icon { background: var(--hc-green-soft); color: var(--hc-green); }
    .hc-protocol[data-protocol-state="discovering"] .hc-protocol-icon { background: var(--hc-warning-soft); color: var(--hc-warning); }
    .hc-protocol[data-protocol-state="changed"] .hc-protocol-icon { background: var(--hc-danger-soft); color: var(--hc-danger); }
    .hc-protocol-title { margin: 0; font-size: 18px; font-weight: 750; }
    .hc-protocol-copy { margin: 3px 0 0; color: var(--hc-muted); font-size: 13px; }
    .hc-protocol-meta { text-align: right; color: var(--hc-muted); font-size: 12px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
    .hc-protocol-alert {
      margin: 0 24px 20px;
      padding: 12px 14px;
      border-radius: 12px;
      background: var(--hc-danger-soft);
      color: var(--hc-danger);
    }
    .hc-protocol-alert p { margin: 3px 0; }

    .hc-details { overflow: hidden; }
    .hc-details summary {
      min-height: 52px;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 24px;
      cursor: pointer;
      font-weight: 750;
      list-style: none;
    }
    .hc-details summary::-webkit-details-marker { display: none; }
    .hc-details summary::after { content: "+"; margin-left: auto; color: var(--hc-muted); font-size: 20px; }
    .hc-details[open] summary::after { content: "−"; }
    .hc-details[open] summary { border-bottom: 1px solid var(--hc-line); }
    .hc-diagnostic-list { margin: 0; }
    .hc-diagnostic-row {
      display: grid;
      grid-template-columns: minmax(160px, 280px) minmax(0, 1fr);
      gap: 24px;
      padding: 13px 24px;
      border-bottom: 1px solid var(--hc-line);
    }
    .hc-diagnostic-row:last-child { border-bottom: 0; }
    .hc-diagnostic-row dt { color: var(--hc-muted); font-size: 13px; font-weight: 700; }
    .hc-diagnostic-row dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }

    .hc-footer { margin-top: 28px; color: var(--hc-muted); font-size: 12px; }

    @media (max-width: 870px) {
      .hc-shell { padding-inline: 28px; }
      .hc-hero-grid { grid-template-columns: 1fr; }
      .hc-status-list { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .hc-status-item { display: block; }
      .hc-status-value { margin-top: 4px; text-align: left; }
      .hc-summary-grid { grid-template-columns: 1fr; }
      .hc-summary-item + .hc-summary-item { border-left: 0; border-top: 1px solid var(--hc-line); }
      .hc-integration { grid-template-columns: 1fr; }
      .hc-actions { justify-content: flex-start; }
    }

    @media (max-width: 560px) {
      .hc-shell { padding: 0 20px 36px; }
      .hc-header { min-height: 76px; }
      .hc-header .hc-login-link { display: none; }
      .hc-main { padding-top: 26px; }
      .hc-title-block { margin-bottom: 23px; }
      .hc-hero { margin-bottom: 27px; padding: 22px 20px; border-radius: 20px; }
      .hc-hero h2 { font-size: 25px; }
      .hc-status-list { grid-template-columns: 1fr; }
      .hc-section { margin-top: 28px; }
      .hc-summary-item, .hc-integration, .hc-protocol-summary { padding-inline: 16px; }
      .hc-integration { gap: 18px; }
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

    @media (max-width: 350px) {
      .hc-shell { padding-inline: 16px; }
      .hc-brand { gap: 6px; }
      .hc-version { display: none; }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; }
    }

    @media (forced-colors: active) {
      .hc-card, .hc-status-item, .hc-button-secondary { border: 1px solid CanvasText; }
      .hc-button-primary { border: 1px solid ButtonText; }
    }
  </style>
</head>
<body>
  <a class="hc-skip-link" href="#main-content">Skip to bridge status</a>
  <div class="hc-shell">
    <header class="hc-header">
      <div class="hc-brand">
        <span class="hc-brand-name">SmartThings Web Bridge</span>
        <span class="hc-version">v${escapeHtml(report.details.bridgeVersion)}</span>
      </div>
      <a class="hc-login-link" href="novnc-ui/vnc.html?autoconnect=1&amp;resize=scale&amp;path=websockify">Browser login</a>
    </header>

    <main id="main-content" class="hc-main">
      <div class="hc-title-block">
        <p class="hc-eyebrow">Bridge status</p>
        <h1>SmartThings connection at a glance</h1>
        <p class="hc-lead">Check bridge readiness, connect Home Assistant, and open technical diagnostics only when you need them.</p>
      </div>

      ${renderOverallPanel(report, overallState)}

      <section class="hc-section" aria-labelledby="overview-heading">
        <div class="hc-section-heading">
          <h2 id="overview-heading">Overview</h2>
          <p>Key runtime information without the internal details.</p>
        </div>
        <div class="hc-card hc-summary-grid">
          <div class="hc-summary-item">
            <p class="hc-summary-label">Observed devices</p>
            <p class="hc-summary-value">${formatNumber(report.details.observedDeviceCount)}</p>
            <p class="hc-summary-support">Advanced inventory: ${formatNumber(report.details.advancedInventoryDeviceCount)}</p>
          </div>
          <div class="hc-summary-item">
            <p class="hc-summary-label">Active clients</p>
            <p class="hc-summary-value">${formatNumber(report.details.activeConnections)}</p>
            <p class="hc-summary-support">Pending commands: ${formatNumber(report.details.pendingCommandCount)}</p>
          </div>
          <div class="hc-summary-item">
            <p class="hc-summary-label">Latest push</p>
            <p class="hc-summary-value">${formatDuration(report.details.pushAgeMs)}</p>
            <p class="hc-summary-support">Reconnects: ${formatNumber(report.details.reconnectCount)}</p>
          </div>
        </div>
      </section>

      <section class="hc-section hc-card hc-integration" aria-labelledby="integration-heading">
        <div>
          <h2 id="integration-heading">Home Assistant integration</h2>
          <p id="pairing-help">Generate an eight-digit pairing code. It stays valid for ten minutes.</p>
        </div>
        <div class="hc-actions">
          <button class="hc-button hc-button-primary" id="pairing-button" type="button" aria-describedby="pairing-help pairing-result">Generate pairing code</button>
          <a class="hc-button hc-button-secondary" href="novnc-ui/vnc.html?autoconnect=1&amp;resize=scale&amp;path=websockify">Open browser login</a>
        </div>
        <div class="hc-pairing" id="pairing-result" role="status" aria-live="polite" data-state="idle">
          <span>Pairing code</span>
          <strong class="hc-pairing-code">—</strong>
        </div>
      </section>

      <section class="hc-section" aria-labelledby="protocol-heading">
        <div class="hc-section-heading">
          <h2 id="protocol-heading">Connection integrity</h2>
          <p>Protocol compatibility and readiness evidence.</p>
        </div>
        ${protocolPanel}
      </section>

      <section class="hc-section" aria-labelledby="diagnostics-heading">
        <div class="hc-section-heading">
          <h2 id="diagnostics-heading">Diagnostics</h2>
          <p>Technical values are kept available, but separated from the everyday status view.</p>
        </div>
        <details class="hc-card hc-details">
          <summary>View technical details</summary>
          <dl class="hc-diagnostic-list">${diagnosticRows}</dl>
        </details>
      </section>

      <footer class="hc-footer">Architecture ${escapeHtml(report.details.architectureVersion)} · Browser ${escapeHtml(report.details.browserVersion)}</footer>
    </main>
  </div>
  <script>
    const pairingButton = document.getElementById("pairing-button");
    const pairingResult = document.getElementById("pairing-result");
    const pairingCode = pairingResult.querySelector(".hc-pairing-code");

    pairingButton.addEventListener("click", async () => {
      pairingButton.disabled = true;
      pairingButton.setAttribute("aria-busy", "true");
      pairingResult.dataset.state = "idle";
      pairingCode.textContent = "…";
      try {
        const response = await fetch("api/v1/pairing-code", { method: "POST", credentials: "same-origin" });
        const body = await response.json();
        if (response.ok && /^\\d{8}$/.test(body.code)) {
          pairingResult.dataset.state = "success";
          pairingCode.textContent = body.code;
        } else {
          pairingResult.dataset.state = "error";
          pairingCode.textContent = "Could not generate code";
        }
      } catch {
        pairingResult.dataset.state = "error";
        pairingCode.textContent = "Could not generate code";
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
  const title =
    state === "ready" ? "Bridge is ready" : state === "starting" ? "Bridge is starting" : "Bridge needs attention";
  const copy =
    state === "ready"
      ? "SmartThings observation and Home Assistant connection requirements are currently satisfied."
      : state === "starting"
        ? "The bridge service is running, but one or more readiness checks are still completing."
        : "The bridge is not currently live. Open the browser login or diagnostics to identify the blocking condition.";
  const icon = state === "ready" ? "✓" : state === "starting" ? "…" : "!";

  return `<section class="hc-hero" data-overall-state="${state}" aria-labelledby="bridge-state-heading">
      <div class="hc-hero-grid">
        <div>
          <div class="hc-state-line">
            <span class="hc-state-icon" aria-hidden="true">${icon}</span>
            <h2 id="bridge-state-heading">${title}</h2>
          </div>
          <p class="hc-hero-copy">${copy}</p>
        </div>
        <ul class="hc-status-list" aria-label="Bridge readiness summary">
          <li class="hc-status-item"><span class="hc-status-label">Service</span><strong class="hc-status-value">${report.live ? "Live" : "Offline"}</strong></li>
          <li class="hc-status-item"><span class="hc-status-label">HA readiness</span><strong class="hc-status-value">${report.ready ? "Ready" : "Not ready"}</strong></li>
          <li class="hc-status-item"><span class="hc-status-label">Runtime</span><strong class="hc-status-value">${escapeHtml(formatRuntimeState(report.details.state))}</strong></li>
        </ul>
      </div>
    </section>`;
}

function renderProtocolPanel(report: HealthReport): string {
  const state = protocolPanelState(report);
  const title =
    state === "changed"
      ? "Protocol changed"
      : state === "discovering"
        ? "Protocol discovery incomplete"
        : "Protocol verified";
  const readiness = report.ready ? "Readiness permitted" : "Readiness blocked";
  const icon = state === "verified" ? "✓" : state === "discovering" ? "…" : "!";
  const explanation =
    state === "verified"
      ? "The observed SmartThings protocol remains compatible with the bridge."
      : state === "discovering"
        ? "Protocol discovery is still in progress. Readiness may remain blocked until it completes."
        : "The observed SmartThings protocol differs from the verified shape. Review the mismatch before continuing.";
  const mismatchSurface =
    state === "changed" && report.details.protocolMismatchSurface
      ? `<p>Mismatch: ${escapeHtml(report.details.protocolMismatchSurface)}</p>`
      : "";
  const phase2 = state === "changed" ? "<p>Phase 2 remains closed</p>" : "";
  const alert =
    state === "changed"
      ? `<div class="hc-protocol-alert" role="alert"><p>${readiness}</p>${phase2}${mismatchSurface}</div>`
      : "";

  return `<div class="hc-card hc-protocol" data-protocol-state="${state}">
      <div class="hc-protocol-summary">
        <span class="hc-protocol-icon" aria-hidden="true">${icon}</span>
        <div>
          <p class="hc-protocol-title">${title}</p>
          <p class="hc-protocol-copy">${explanation} ${readiness}.</p>
        </div>
        <div class="hc-protocol-meta">Version ${escapeHtml(report.details.protocolVersion)}<br>Changes ${String(report.details.protocolChangeCount)}</div>
      </div>
      ${alert}
    </div>`;
}

function overallPanelState(report: HealthReport): OverallState {
  if (report.ready) {
    return "ready";
  }
  if (report.live) {
    return "starting";
  }
  return "attention";
}

function protocolPanelState(report: HealthReport): ProtocolState {
  if (report.details.state === "PROTOCOL_CHANGED") {
    return "changed";
  }
  if (report.details.protocolVersion.endsWith(":discovering")) {
    return "discovering";
  }
  return "verified";
}

function formatRuntimeState(value: HealthReport["details"]["state"]): string {
  return String(value)
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatDiagnosticLabel(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function formatDiagnosticValue(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return "—";
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  return String(value);
}

function formatNumber(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
}

function formatDuration(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "—";
  }
  const milliseconds = Math.max(0, value);
  if (milliseconds < 1_000) {
    return `${Math.round(milliseconds)} ms`;
  }
  const seconds = milliseconds / 1_000;
  if (seconds < 60) {
    return `${Math.round(seconds)} s ago`;
  }
  const minutes = seconds / 60;
  if (minutes < 60) {
    return `${Math.round(minutes)} min ago`;
  }
  return `${Math.round(minutes / 60)} h ago`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
