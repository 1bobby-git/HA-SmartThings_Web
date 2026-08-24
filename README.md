# HA SmartThings Web

Phase 1 repository for a Home Assistant SmartThings Web Bridge inspector. It runs a headed Chromium session for `my.smartthings.com`, lets the user log in manually through noVNC/Ingress, and records sanitized read-only network evidence before any Home Assistant entity implementation starts.

## Scope

- Bridge add-on skeleton with Xvfb, Openbox, x11vnc, noVNC, nginx Ingress, and s6 supervision.
- TypeScript bridge runtime with Playwright persistent context, keeper tab, browser/session health, read-only CDP/WebSocket/SSE/XHR observation, and redaction boundaries.
- Sanitized Engine.IO/Socket.IO text decoding and bounded event-ID/fingerprint deduplication replay.
- Runtime diagnostics for decoded DEVICE_EVENT, unique logical event, duplicate delivery, dedupe journal, and invalid-frame counts.
- Snapshot ACK correlation across locations, rooms, device cards, device states, device health, and scenes before readiness, including valid empty categories and fail-closed shape checks.
- Static gates for direct SmartThings API usage and production secret material.
- Privacy-safe external HAOS soak sampling with automatic readiness, counter, protocol, restart, gap, and memory verdicts.
- Phase 1 documentation and manual evidence checklist.

Not included in Phase 1: Home Assistant entity platforms, control commands, entity migration, stable release tagging, or any direct SmartThings API/PAT/OAuth/SmartApp/webhook path.

## Install

### Home Assistant OS / Supervised (primary path)

This GitHub repository is private, so install it as a local Home Assistant app:

1. From a fresh checkout, run `npm ci`, then run `npm run package:addon`.
2. Using the Samba or SSH app, copy the contents of `dist-addon/smartthings_web_bridge` to `/addons/smartthings_web_bridge` on the Home Assistant host.
3. In Home Assistant, open **Settings → Apps → Install app**. From the top-right menu, choose **Check for updates**.
4. Under **Local apps**, open **SmartThings Web Bridge**, install it, and start it.
5. Open its Web UI, use the noVNC Chromium view, and sign in to Samsung only in that browser.

The folder path and add-on slug are different: `/addons/smartthings_web_bridge` is the local source folder and `smartthings_web_bridge` is the configured slug. Supervisor prefixes local apps, so the installed runtime slug is `local_smartthings_web_bridge`. Home Assistant Supervisor builds and manages the add-on container, so you do not install or manage Docker yourself.

Do not copy the raw `addon/smartthings_web_bridge` source folder to Home Assistant. It lacks generated monorepo build inputs that are included by `npm run package:addon`.

Keep backup copies outside `/addons`. Supervisor scans child folders there as local apps, so a backup that still contains `config.yaml` with the same slug can hide the newest package metadata.

If the repository is made public later, it can instead be added from **Settings → Apps → Install app → ⋮ → Repositories** using the repository URL.

### Standalone development only

The standalone Docker path is only for development and for Home Assistant Container/Core deployments that do not have Supervisor:

```powershell
docker build -f docker/Dockerfile -t ha-smartthings-web:phase1 .
docker run --rm --shm-size=1g -p 127.0.0.1:8099:8099 -v smartthings-web-data:/data ha-smartthings-web:phase1
```

## Security

Do not place Samsung credentials, MFA codes, CAPTCHA values, cookies, CSRF values, Authorization headers, or bridge tokens in source, config, fixtures, logs, issues, or chat. Production source is scanned with `npm run audit:api-free` and `npm run audit:secrets`.

## Protocol Integrity

The add-on stores the reviewed semantic protocol fingerprint at `/data/protocol-fingerprint.json` and keeps it separate from `/data/settings.json`. If SmartThings Web returns an incompatible ACK/event shape, the bridge reports `PROTOCOL_CHANGED`: liveness and Ingress stay available, but parser health and readiness stay false.

The same contract cannot self-heal. Recovery requires reviewed sanitized evidence, parser/replay tests for the new shape, and a numeric `protocol_version` bump before accepting a new fingerprint.

## Phase 2 Gate

Phase 2 remains closed until sanitized real traffic proves full inventory, initial snapshot, location-wide push events, reconnect behavior, and no direct dependency on paid/public SmartThings API calls.

Current gate: `DECISION: LIMITED` in `docs/feasibility-report.md`. A bounded controlled Chrome sample confirmed a session-based Socket.IO transport and initial snapshot-shaped data without an observed `api.smartthings.com` request. A live HAOS add-on run after manual VNC login reached `CONNECTED`, observed 213 devices, decoded live DEVICE_EVENT counters, and restored that session plus a complete snapshot after one 0.1.24 add-on restart. Deliberately triggered physical device events, host-reboot recovery, long-idle durability, commands, and complete API independence remain unverified.

The recommended non-disruptive next gate is the 72-hour passive HAOS soak documented in `docs/haos-soak.md`. Run it with `npm run soak:haos`; its detailed samples stay outside the repository and only a reviewed sanitized completion summary may later be committed.
