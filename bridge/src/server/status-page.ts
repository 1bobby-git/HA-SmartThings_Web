import type { HealthReport } from "./health.js";

export function renderStatusPage(report: HealthReport): string {
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
    table { width: 100%; border-collapse: collapse; background: #161d24; }
    th, td { border-bottom: 1px solid #2b3640; padding: 8px 10px; text-align: left; }
    th { width: 260px; color: #98a7b3; font-weight: 600; }
    a { color: #80c7ff; }
  </style>
</head>
<body>
  <main>
    <h1>SmartThings Web Bridge</h1>
    <p>live=${String(report.live)} ready=${String(report.ready)}</p>
    <p><a href="novnc/vnc.html?autoconnect=1&amp;resize=scale&amp;path=novnc/websockify">Open browser login view</a></p>
    <table>${rows}</table>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
