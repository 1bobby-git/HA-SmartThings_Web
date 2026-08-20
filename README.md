# HA SmartThings Web

Phase 1 repository for a Home Assistant SmartThings Web Bridge inspector. It runs a headed Chromium session for `my.smartthings.com`, lets the user log in manually through noVNC/Ingress, and records sanitized read-only network evidence before any Home Assistant entity implementation starts.

## Scope

- Bridge add-on skeleton with Xvfb, Openbox, x11vnc, noVNC, nginx Ingress, and s6 supervision.
- TypeScript bridge runtime with Playwright persistent context, keeper tab, browser/session health, read-only CDP/WebSocket/SSE/XHR observation, and redaction boundaries.
- Static gates for direct SmartThings API usage and production secret material.
- Phase 1 documentation and manual evidence checklist.

Not included in Phase 1: Home Assistant entity platforms, control commands, entity migration, stable release tagging, or any direct SmartThings API/PAT/OAuth/SmartApp/webhook path.

## Install

For Home Assistant OS/Supervised, add this repository as a local add-on repository and install `addon/smartthings_web_bridge`. Open the add-on Ingress panel, use the noVNC Chromium view, and sign in to Samsung only in that browser.

For standalone development:

```powershell
npm install
npm run build
npm test
```

## Security

Do not place Samsung credentials, MFA codes, CAPTCHA values, cookies, CSRF values, Authorization headers, or bridge tokens in source, config, fixtures, logs, issues, or chat. Production source is scanned with `npm run audit:api-free` and `npm run audit:secrets`.

## Phase 2 Gate

Phase 2 remains closed until sanitized real traffic proves full inventory, initial snapshot, location-wide push events, reconnect behavior, and no direct dependency on paid/public SmartThings API calls.

Current gate: `DECISION: STOP` in `docs/feasibility-report.md`. This is a provisional closed gate caused by missing controlled-session real traffic, not proof that the SmartThings Web protocol is impossible.
