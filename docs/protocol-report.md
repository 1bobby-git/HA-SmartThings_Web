# Protocol Report

No synthetic SmartThings protocol payloads are included. Protocol notes must come from sanitized real captures only.

Current implemented observation surfaces:

- Playwright request and response metadata.
- Playwright WebSocket open/frame/close metadata.
- Service worker lifecycle metadata.
- CDP WebSocket frames.
- CDP EventSource messages.
- Bounded XHR/fetch response body copies.

Unknown binary frames are represented by metadata rather than payload content.
Text frames and XHR/fetch bodies are redacted before applying a 1 MiB per-record limit. The largest observed initial snapshot frame was about 482 KB, so the current default retains that bounded sample without removing the safety cap.

## Semantic protocol integrity

The runtime keeps semantic protocol integrity evidence in `/data/protocol-fingerprint.json` with file mode 0600. It is separate from `/data/settings.json`, which is also 0600, so user settings and reviewed protocol evidence have independent persistence and permission checks.

The current required semantic surfaces are locations, rooms, device_cards, device_states, device_health, scenes, and DEVICE_EVENT. The six snapshot surfaces must be proven by request/ACK correlation before readiness, and DEVICE_EVENT must prove parser and push health. Optional surfaces and inventory-count variation are not blocking because count changes can be normal account state.

A known incompatible ACK/event shape or corrupt protocol store moves the protocol state to PROTOCOL_CHANGED. In that state parser health remains false, readiness remains false, and Home Assistant integration must not consume the changed contract. The liveness and Ingress status pages stay up so the user can see the red warning, review status, and collect sanitized evidence. The mismatch surface is safe diagnostics only: category names, parser state, readiness state, version numbers, and sanitized evidence references. It must not expose payload bodies or account identifiers.

The same semantic contract cannot self-heal. Recovery requires reviewed sanitized evidence, parser/replay tests that cover the new shape, and a numeric `protocol_version` bump before a new fingerprint can be accepted. Historical change count is not a current-failure signal; only the active stored fingerprint versus the active observed contract controls PROTOCOL_CHANGED.

Current bounded evidence:

Sanitized aggregate artifact: `protocol/fixtures/2026-08-20-controlled-chrome-summary.json` with its adjacent SHA-256 file. The artifact contains no frame bodies, identifiers, values, headers, cookies, or tokens.

- 111 requests were observed during a controlled Chrome reload sample.
- One Socket.IO WebSocket connection to `my.smartthings.com` was observed.
- 25 received and 18 sent frames were observed.
- Sent event families included authenticate, find, get, create, and subscription response shapes.
- Snapshot-shaped aggregates included 2 locations, 9 rooms, 4 scenes, 205 device-card records, 206 unique state device IDs, 1557 capability-attribute state rows, and 212 health records.
- No `api.smartthings.com` request appeared in the bounded sample.
- A later live window received Socket.IO event families `api/subscription DEVICE_EVENT`, `CONTROL_EVENT`, and `SPIGOT_EVENT`.
- DEVICE_EVENT aggregates: 72 deliveries, 27 unique event IDs, 9 unique devices, 66 state-change deliveries, and 6 non-state-change deliveries.
- The DEVICE_EVENT shape carried device/location, component, capability, attribute, value type, unit, event time, event ID, and state-change fields. Values and identifiers were discarded.
- During a 20-second background-tab window, the SmartThings tab was not selected and the same socket remained open while 954 frames arrived: 747 DEVICE_EVENT, 139 CONTROL_EVENT, and 16 SPIGOT_EVENT deliveries.
- A later live aggregate contained the exact capability families `motionSensor`, `presenceSensor`, `battery`, `temperatureMeasurement`, `illuminanceMeasurement`, `signalStrength`, and `airQualitySensor` across 13 unique device IDs. No values or identifiers were retained.

Frame bodies and account identifiers were not persisted to the repository. The observed duplicate delivery ratio confirms a dedupe requirement, but does not yet validate the dedupe formula. Short-window background delivery is verified; long-idle durability is not. The events were not causally tied to a deliberate physical action, so triggered device-change semantics, restart resume, command confirmation, and complete API independence remain unproven.

## Decoder and dedupe replay

Sanitized duplicate fixture: `protocol/fixtures/2026-08-20-device-event-duplicate.sanitized.json` with its adjacent SHA-256 file.

`npm run protocol:replay` passed: 3 sanitized deliveries decoded to 1 logical event, with 2 deliveries classified as duplicates and 0 invalid frames. The identity rule prefers the observed event ID and uses a deterministic canonical SHA-256 fingerprint only when an event ID is unavailable. Version 0.1.25 derives that fallback from the sanitized decoded Socket.IO delivery rather than the observer-specific capture envelope, so the same missing-ID delivery seen by Playwright and CDP collapses while a changed value or source timestamp remains distinct.

The runtime capture sink now feeds already-sanitized incoming Playwright/CDP text frames through the same analyzer. A valid DEVICE_EVENT updates safe counters for decoded deliveries, unique events, duplicates, journal size, and invalid frames, and only then marks parser/push state healthy. Integration tests replay the fixture through that runtime path.

This proves decoder/dedupe integration against one real sanitized event shape and automated missing-ID fallback behavior. It does not yet prove a real SmartThings event without an event ID, restart persistence of an event journal, or physical-action correlation.

The in-memory physical-action probe introduced in 0.1.26 is deployed with 0.1.27, but physical-action correlation remains unverified. A targeted contact attempt failed closed on `unsafe_event` because an unrelated live DEVICE_EVENT omitted its component. The numeric `protocol_version` remains 1 because 0.1.27 normalizes the already observed event time and component omission without accepting a new external protocol surface.

## Snapshot ACK replay

Sanitized correlation fixture: `protocol/fixtures/2026-08-20-snapshot-ack-correlations.sanitized.json` with its adjacent SHA-256 file.

`npm run snapshot:replay` passed: 6 request/ACK correlations matched the required locations, rooms, device_cards, device_states, device_health, and scenes categories; all six counts matched the controlled-session aggregates and no request remained pending. The sanitized fixture now retains only the stable `find` query names and request field names needed to identify a successful empty category without retaining request values.

The runtime capture sink tracks sent event ack IDs and received ACKs. It marks `initialSnapshotComplete` only after all six categories are observed, including a valid zero-count response, keeps readiness false until a valid DEVICE_EVENT also proves push/parser health, and resets the snapshot/dedupe epoch on browser-context reconnect. Version 0.1.23 keeps that current-context initial snapshot proof valid after the old 120-second wall-clock TTL; heartbeat freshness, recent push traffic, and current-context parser proof remain the live readiness gates. Non-empty arrays must be homogeneous per-record matches, and a request hint that conflicts with the response shape fails closed.

This verifies completeness classification and readiness gating with sanitized real shapes. It does not yet normalize the full inventory into Home Assistant models or prove snapshot recovery on a live add-on reconnect.

## Packaged add-on smoke

Packaged container smoke artifact: `protocol/fixtures/2026-08-20-addon-smoke-summary.json` with its adjacent SHA-256 file.

The image `ha-smartthings-web-addon:phase1-release-candidate` was built from `dist-addon/smartthings_web_bridge` only with package manifest SHA-256 `1c72223a3876404c5865449f60c7c16e1c0f503ab86e1c963ba9ac5ffe1bf59a` and observed as local image ID `sha256:9fc550052b29d3745fc3ef385fb4bc225ca570f2b8d4aea78f4a532b9b816001`. In Docker Desktop on amd64/linux, the container reached liveness with `LOGIN_REQUIRED` after 14 seconds, readiness stayed blocked, headed Chromium was running, and the browser restart count stayed 0. The observed runtime versions were Node 24.18.1, Playwright 1.62.1, and Chromium 151.0.7922.34.

The later exact 0.1.26 candidate was built on Docker Desktop Engine 29.6.2 for Linux amd64 from package manifest SHA-256 `d4a9cc60b9dae10bce32f082a5f5d4bbd3aea0080fc83e69e3542e18f5ac22a6`; the resulting local image ID was `sha256:9e28bc662d027ffee2743371a1c1c1b967ac2a878e78353dd9ea6f060c03f1b6`. A direct read inside the image returned the same SHA-256 for `/app/addon-package-manifest.json`, proving that deployment postflight can bind the running image to the authorized package. With a fresh `/data` volume, the bridge reached liveness 200 and reported bridge version 0.1.26, but Docker Desktop's default container security did not permit this add-on's required Chromium sandbox and the isolated smoke ended in `BROWSER_FAILED` with readiness 503. This later run verifies the packaged runtime identity path only; it is not HAOS Chromium, login, readiness, or physical-action evidence. Its temporary container and volume were removed and Docker Desktop was stopped.

Ingress checks returned live 200, ready 503, status 200, noVNC 200, and denied-client 403, with 0 published host ports. Existing supervised processes remained present. Private persisted files kept the expected modes, including `/data/settings.json` and `/data/protocol-fingerprint.json` at 0600.

A container restart returned live 200, reached `LOGIN_REQUIRED`, preserved the checked data-file hashes, and had Chromium running. A corrupt protocol-fingerprint smoke wrote invalid content only into a temporary volume and restarted the container; liveness stayed 200, readiness stayed 503, state became `PROTOCOL_CHANGED`, parser health stayed false, Chromium was not running, protocol version remained `1:discovering`, and the status page showed the changed protocol, closed Phase 2 gate, and readiness block. Logs exposed only the fixed event name `protocol_integrity_store_failed`, not the invalid file content.

The smoke used Docker Desktop rather than Home Assistant Supervisor. AppArmor was not enforced, and no Samsung credentials or live SmartThings session were entered into the container. Temporary container, volume, and network state were removed afterward, and Docker was stopped.

## Live HAOS add-on validation

On 2026-08-24, the packaged local add-on was updated to bridge version `0.1.22` on Home Assistant OS 18.2. Supervisor loaded `local_smartthings_web_bridge` in enforce mode with `Privileged=false`, bridge networking, `full_access=false`, and an empty add-on privilege list. Chromium 151.0.7922.34 launched as UID 1001 with Playwright's sandbox enabled after the AppArmor profile was limited to the observed user-namespace setup operations.

The live endpoint returned HTTP 200 with `state=LOGIN_REQUIRED`, `restartCount=0`, and the expected bridge and browser versions before login. Readiness returned HTTP 503 as designed before login and protocol discovery. The authenticated Home Assistant Ingress status page showed the same state, and its internal noVNC connection rendered the real Samsung Account login page.

After manual VNC login, the same 0.1.22 add-on reached `CONNECTED` with `observedDeviceCount=213`, readiness initially true, decoded live DEVICE_EVENT counters increasing, `protocolChangeCount=0`, `restartCount=0`, and protocol fingerprint `1:93ad956a7d0c0139`. Sanitized aggregate evidence is recorded in `protocol/fixtures/2026-08-24-haos-addon-login-summary.json`.

After the readiness correction, 0.1.24 was deployed through Supervisor. Its persisted session restored automatically, observer-first keeper reload reacquired all required snapshot categories, and readiness remained true at `initialSnapshotAgeMs=147196` with 213 observed devices and increasing live event counters. The Supervisor-facing Ingress backend returned 200, the noVNC asset returned 200, and its WebSocket upgrade returned 101. AppArmor remained enforced with `Privileged=false`, bridge networking, and no added Docker capabilities.

Version 0.1.25 was then deployed after moving duplicate-slug source backups outside Supervisor's local app discovery root. Supervisor reported installed/latest `0.1.25` with no update pending, the persisted session and complete snapshot restored, and readiness stayed true at `initialSnapshotAgeMs=145892`. The bridge reported 213 devices, 170 decoded deliveries, 85 unique logical events, 85 duplicate deliveries, `protocolChangeCount=0`, and `restartCount=0`. AppArmor remained enforced, the container remained non-privileged on bridge networking with no added capabilities, and no matching AppArmor denial appeared in the post-update window.

A 72-hour read-only external soak is now running at 300-second intervals. The corrected run began with 213 devices, ready `CONNECTED` state, protocol changes and restart count at zero, invalid-frame baseline 2, and successful 200/200/101 Ingress, noVNC asset, and WebSocket start checks. Detailed JSONL stays outside the repository; only a reviewed aggregate and SHA may be retained after completion. Its current status is `pending`, so no long-idle claim is made yet.

A read-only retained-capture origin audit then classified 1,999 URL-source records from the live 0.1.25 Bridge database entirely inside the container. Of 1,985 valid network URL records, 12 were consumer SmartThings Web records and zero were public SmartThings API records. Only fixed category counts and the capture time range were exported. The hashed reviewed fixture is `protocol/fixtures/2026-08-24-haos-capture-origin-audit-summary.json`; retained rows are supporting sampled evidence, not complete network history.

A separate HA Core restart continuity operator now has a live non-mutating preview. It reconstructed only Core version/boot/watchdog/container-running posture and allowlisted Bridge health, found every prerequisite healthy except the pending soak, and reported `remoteMutationPerformed=false`. No Core restart occurred; execute mode remains held until the soak is sealed.

The 0.1.26 package candidate is deliberately held outside HAOS until that 0.1.25 soak completes. It adds no browser input, DOM state scraping, direct SmartThings API request, Home Assistant entity, command path, or persistent event journal, and it is not live physical-action evidence.

This proves HAOS packaging, enforced-profile startup, headed Chromium, Ingress, noVNC delivery, manual logged-in capture, repeated add-on/browser restart restore, initial snapshot recognition/reacquisition, and live push/parser observation through the add-on path. It does not prove a real missing-ID event, host reboot recovery, physical-action correlation, command confirmation, or long-idle durability.
