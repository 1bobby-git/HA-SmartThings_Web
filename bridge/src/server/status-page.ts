import type { HealthReport } from "./health.js";

export function renderStatusPage(report: HealthReport): string {
  const protocolPanel = renderProtocolPanel(report);
  const rows = Object.entries(report.details)
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(String(value))}</td></tr>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SmartThings Web Bridge</title>
  <style>
    body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: #101418; color: #e8eef2; }
    main { max-width: 960px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 24px; margin: 0 0 16px; }
    .protocol { border: 1px solid #2b3640; border-left-width: 6px; padding: 14px 16px; margin: 0 0 16px; background: #161d24; }
    .protocol h2 { font-size: 17px; margin: 0 0 8px; }
    .protocol p { margin: 4px 0; }
    .protocol[data-protocol-state="changed"] { border-left-color: #f87171; }
    .protocol[data-protocol-state="discovering"] { border-left-color: #fbbf24; }
    .protocol[data-protocol-state="verified"] { border-left-color: #34d399; }
    table { width: 100%; border-collapse: collapse; background: #161d24; }
    th, td { border-bottom: 1px solid #2b3640; padding: 8px 10px; text-align: left; }
    th { width: 260px; color: #98a7b3; font-weight: 600; }
    a { color: #80c7ff; }
    button { padding: 9px 13px; border: 0; border-radius: 6px; background: #3182ce; color: white; cursor: pointer; }
    #pairing-result { display: inline-block; margin-left: 10px; font: 700 18px ui-monospace, monospace; letter-spacing: .12em; }
  </style>
</head>
<body>
  <main>
    <h1>SmartThings Web Bridge</h1>
    <p>live=${String(report.live)} ready=${String(report.ready)}</p>
    ${protocolPanel}
    <p><a href="novnc-ui/vnc.html?autoconnect=1&amp;resize=scale&amp;path=websockify">Open browser login view</a></p>
    <section class="protocol">
      <h2>Home Assistant integration</h2>
      <p>Generate a ten-minute pairing code, then add the <code>smartthings_web</code> integration.</p>
      <button id="pairing-button" type="button">Generate pairing code</button>
      <span id="pairing-result" aria-live="polite"></span>
    </section>
    <table>${rows}</table>
  </main>
  <script>
    document.getElementById("pairing-button").addEventListener("click", async () => {
      const target = document.getElementById("pairing-result");
      target.textContent = "...";
      try {
        const response = await fetch("api/v1/pairing-code", { method: "POST", credentials: "same-origin" });
        const body = await response.json();
        target.textContent = response.ok && /^\\d{8}$/.test(body.code) ? body.code : "failed";
      } catch {
        target.textContent = "failed";
      }
    });
  </script>
</body>
</html>`;
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
  const mismatchSurface =
    state === "changed" && report.details.protocolMismatchSurface
      ? `<p>surface=${escapeHtml(report.details.protocolMismatchSurface)}</p>`
      : "";
  const phase2 = state === "changed" ? "<p>Phase 2 remains closed</p>" : "";
  return `<section class="protocol" data-protocol-state="${state}">
      <h2>${title}</h2>
      <p>${readiness}</p>
      ${phase2}
      <p>version=${escapeHtml(report.details.protocolVersion)}</p>
      <p>changes=${String(report.details.protocolChangeCount)}</p>
      ${mismatchSurface}
    </section>`;
}

function protocolPanelState(report: HealthReport): "changed" | "discovering" | "verified" {
  if (report.details.state === "PROTOCOL_CHANGED") {
    return "changed";
  }
  if (report.details.protocolVersion.endsWith(":discovering")) {
    return "discovering";
  }
  return "verified";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
