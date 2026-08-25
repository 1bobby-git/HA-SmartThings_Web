# HA SmartThings Web

Limited-alpha Home Assistant SmartThings Web Bridge and `smartthings_web` custom integration. It runs a headed Chromium session for `my.smartthings.com`, lets the user log in manually through noVNC/Ingress, and registers observed devices through a local authenticated Bridge connection.

## Scope

- Bridge add-on skeleton with Xvfb, Openbox, x11vnc, noVNC, nginx Ingress, and s6 supervision.
- TypeScript bridge runtime with a dedicated Playwright persistent profile, observation-only keeper tab, separate command page, browser/session health, CDP/WebSocket/SSE/XHR observation, and redaction boundaries.
- Sanitized Engine.IO/Socket.IO text decoding and bounded event-ID/fingerprint deduplication replay.
- Runtime diagnostics for decoded DEVICE_EVENT, unique logical event, duplicate delivery, dedupe journal, and invalid-frame counts.
- Bounded in-memory physical-action correlation controls that use only sanitized, deduplicated events and require one isolated `/location` keeper page.
- Snapshot ACK correlation across locations, rooms, device cards, device states, device health, and scenes before readiness, including valid empty categories and fail-closed shape checks.
- Static gates for direct SmartThings API usage and production secret material.
- Privacy-safe external HAOS soak sampling with automatic readiness, counter, protocol, restart, gap, and memory verdicts.
- Authenticated local inventory, SSE push, push-confirmed command, and cached camera-image endpoints.
- Home Assistant platforms for sensor, binary sensor, switch, light, button, number, fan, media player, climate, cover, select, scene, SmartThings Home Monitor alarm panel, and refreshed camera still images.
- Bounded one-time device-detail discovery on a separate page so every available web swatch can enter normalized inventory; repeated SmartThings state polling is not used.
- Phase 1 documentation and manual evidence checklist.

Not included in the limited alpha: DOM- or pixel-derived device state, SmartThings state polling, persistent event journals, live camera streaming, stable release tagging, or any direct SmartThings API/PAT/OAuth/SmartApp/webhook path. Browser commands are restricted to controls discovered from SmartThings Web and succeed only after a newer authoritative push confirms the result.

## Install

### Home Assistant OS / Supervised (primary path)

This GitHub repository is private, so install it as a local Home Assistant app:

1. From a fresh checkout, run `npm ci`, then run `npm run package:addon`.
2. Using the Samba or SSH app, copy the contents of `dist-addon/smartthings_web_bridge` to `/addons/smartthings_web_bridge` on the Home Assistant host.
3. In Home Assistant, open **Settings → Apps → Install app**. From the top-right menu, choose **Check for updates**.
4. Under **Local apps**, open **SmartThings Web Bridge**, install it, and start it.
5. Open its Web UI, use the noVNC Chromium view, and sign in to Samsung only in that browser.

The login remains in the dedicated `/data/chromium-profile` browser profile across add-on restarts. Do not copy cookies, CSRF values, user IDs, or other session material into configuration or source. The Bridge observes the web app's own authenticated Socket.IO session and lets the web app reauthenticate it.

The folder path and add-on slug are different: `/addons/smartthings_web_bridge` is the local source folder and `smartthings_web_bridge` is the configured slug. Supervisor prefixes local apps, so the installed runtime slug is `local_smartthings_web_bridge`. Home Assistant Supervisor builds and manages the add-on container, so you do not install or manage Docker yourself.

Do not copy the raw `addon/smartthings_web_bridge` source folder to Home Assistant. It lacks generated monorepo build inputs that are included by `npm run package:addon`.

The packager canonicalizes generated text files to UTF-8 with LF line endings, so the manifest SHA-256 is identical for equivalent Windows and Linux checkouts. Source files in the monorepo are not rewritten.

Keep backup copies outside `/addons`. Supervisor scans child folders there as local apps, so a backup that still contains `config.yaml` with the same slug can hide the newest package metadata.

If the repository is made public later, it can instead be added from **Settings → Apps → Install app → ⋮ → Repositories** using the repository URL.

### Standalone development only

The standalone Docker path is only for development and for Home Assistant Container/Core deployments that do not have Supervisor:

```powershell
docker build -f docker/Dockerfile -t ha-smartthings-web:phase1 .
docker run --rm --shm-size=1g -p 127.0.0.1:8099:8099 -v smartthings-web-data:/data ha-smartthings-web:phase1
```

## Security

Do not place Samsung credentials, MFA codes, CAPTCHA values, cookies, CSRF values, Authorization headers, or bridge tokens in source, config, fixtures, logs, issues, or chat. Production source is scanned with `npm run audit:api-free` and `npm run audit:secrets`; a bounded live HAOS process-separation sample can be collected with `npm run audit:api-free:runtime` without retaining destinations, ports, process IDs, or socket identifiers.

## Protocol Integrity

The add-on stores the reviewed semantic protocol fingerprint at `/data/protocol-fingerprint.json` and keeps it separate from `/data/settings.json`. If SmartThings Web returns an incompatible ACK/event shape, the bridge reports `PROTOCOL_CHANGED`: liveness and Ingress stay available, but parser health and readiness stay false.

The same contract cannot self-heal. Recovery requires reviewed sanitized evidence, parser/replay tests for the new shape, and a numeric `protocol_version` bump before accepting a new fingerprint.

## Phase 2 Gate

Phase 2 remains closed until sanitized real traffic proves full inventory, initial snapshot, location-wide push events, reconnect behavior, and no direct dependency on paid/public SmartThings API calls.

Current gate: `DECISION: LIMITED` in `docs/feasibility-report.md`. A bounded controlled Chrome sample confirmed a session-based Socket.IO transport and initial snapshot-shaped data without an observed `api.smartthings.com` request. A later read-only `npx tsx tools/haos-capture-origin-audit.ts` audit classified 1,999 retained URL-source records inside the live add-on container and again found consumer SmartThings Web traffic with zero public SmartThings API records; retained captures are supporting evidence, not complete network history. A live HAOS add-on run after manual VNC login reached `CONNECTED`, observed 213 devices, decoded live DEVICE_EVENT counters, and restored that session plus a complete snapshot after an add-on restart. Safe, observed web controls and push-confirmed commands are now implemented. Host-reboot recovery, long-idle durability, dangerous actuator commands, and complete API independence remain unverified.

Version 0.1.28 is deployed on Home Assistant 2026.8.3 with 213 Bridge devices and 352 registered `smartthings_web` entities preserved. Live temperature, humidity, contact, motion, and power observations have reached Home Assistant from Bridge SSE without SmartThings polling. A fresh independent SSE sample delivered its reconnect inventory marker plus 30 state events at consecutive sequence 642 through 672 with zero gaps. A Bridge-only restart then reset inventory sequence from the 600s to 21, restored all 213 devices, and preserved the current Home Assistant state while Home Assistant Core stayed running.

Version 0.1.34 is now deployed on the same Home Assistant Core. The Bridge restored 213 devices after deployment and remained live, ready, and `CONNECTED` with zero protocol changes, restarts, or invalid frames. Home Assistant registered 1,720 enabled entities: 1 alarm panel, 66 binary sensors, 65 buttons, 3 climate entities, 4 covers, 7 fans, 2 images, 13 lights, 15 media players, 71 numbers, 4 scenes, 1,346 sensors, and 123 switches. All 1,720 had state rows after the Core restart; unavailable entities corresponded to offline devices or controls rather than a disconnected integration.

Version 0.1.37 is installed for both the HAOS app and the Home Assistant integration. It preserves the SmartThings Web `cake-2.57.0` control-DOM repair from 0.1.36 and prevents Bridge startup from reading a multi-gigabyte SQLite file into one Node buffer. Sanitized diagnostic captures are retained as the newest 50,000 rows, with bounded pruning every 1,000 subsequent writes; SQLite free pages are reused but the physical database is not vacuumed as part of startup. Home Assistant 2026.8.3 loaded the integration with 215 devices and 1,722 registered entities: 1 alarm panel, 66 binary sensors, 65 buttons, 7 fans, 2 images, 15 media players, 71 numbers, 4 scenes, and 1,346 sensors, plus the existing climate, cover, light, and switch entities. The 0.1.37 rebuild preserved the dedicated Chromium profile but Samsung redirected it to manual login, so session persistence is not treated as unconditional and fresh Bridge readiness remains blocked until browser reauthentication completes.

A user-supplied, locally retained SmartThings Web capture was analyzed without copying it into the repository. It showed one authenticated Socket.IO connection, 121 DEVICE_EVENT deliveries representing 42 logical events, and 79 duplicate deliveries. Manual contact and switch transitions about one second apart remained distinct and ordered. The same capture included two camera-thumbnail requests but no matching ACK or image response; the image entities and safe cache path are implemented, but current camera bytes are therefore not claimed as available. See `docs/my-smartthings-actual-behavior.md`.

Manual physical-action attribution is verified for a targeted contact-open action. The 60-second probe produced exactly one candidate with `state=pass`; the Bridge source time was 22:41:28.361Z, Bridge receipt was 22:41:28.482Z, and Home Assistant stored `on` at 22:41:28.494626Z. Component-less events are recorded as the explicit safe value `unspecified` instead of aborting the probe. A later close window captured two distinct close candidates and correctly returned `ambiguous`; both close events and the intervening open events appeared in Home Assistant in the same order with updated timestamps, supporting consecutive-event delivery without weakening the single-action proof rule. Status and reset use `npm run probe:physical-action:haos` and expose no new port or raw HTTP output.

The probe adds no browser command, DOM state scraping, direct SmartThings API call, Home Assistant entity, or persistent event journal.

The 72-hour passive HAOS soak remains explicitly deferred until the user requests it again. Its historical operator and deployment-gate procedure remains documented in `docs/haos-soak.md`; do not infer long-idle, host-reboot, or complete API-independence proof from the 0.1.28 live sensor validation.

The HA Core restart continuity scenario uses `npx tsx tools/haos-core-restart-continuity.ts`. Preview mode is non-mutating and execute mode is fail-closed behind the sealed passing soak plus exact Core/Bridge versions. It continuously checks direct Bridge health across the Core restart and writes only a hashed aggregate outside the repository. Execute mode has not been run while the soak is active.

The gated deployment command is `npm run deploy:haos:candidate`; without `--execute` it is a non-mutating preview. Execution requires the exact published `main` commit and packaged manifest SHA-256, repeats the complete preflight immediately before activation, and automatically restores the exact pinned rollback package if rebuild or postflight health verification fails. See `docs/haos-soak.md` for the exact operator sequence.
