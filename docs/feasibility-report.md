# Feasibility Report

A bounded controlled Chrome sample reached SmartThings location after manual Samsung login. The sample observed read-only CDP/browser traffic only; raw events remained transient in browser/CDP buffers and were not written to the repository.

Aggregated evidence:

- 111 requests in the bounded reload sample.
- One `wss://my.smartthings.com/socket.io/` connection.
- 25 received and 18 sent WebSocket frames.
- Socket.IO sent event families included authenticate, find, get, create, and subscription response shapes.
- No `api.smartthings.com` request appeared in this bounded sample.
- Snapshot-shaped aggregate evidence included 2 locations, 9 rooms, 4 scenes, 205 device-card records, 206 unique state device IDs, 1557 capability-attribute state rows, and 212 health records.
- Health aggregate: 196 ONLINE and 16 OFFLINE.
- Device-card aggregate: BASIC 170, CLOUD 34, CAMERA 1.
- Broad standard, custom, and `samsungce` capability names were present.
- A later live window received `api/subscription DEVICE_EVENT`, `CONTROL_EVENT`, and `SPIGOT_EVENT` messages over the same Socket.IO connection.
- The DEVICE_EVENT window contained 72 deliveries, 27 unique event IDs, and 9 unique device IDs; 66 deliveries declared `stateChange: true` and 6 declared `stateChange: false`.
- The observed DEVICE_EVENT schema included event ID, device/location ID, component, capability, attribute, value type, unit, event time, and state-change fields. Only aggregate counts and field names were retained.
- A 20-second test with the SmartThings tab in the background kept the socket open and received 954 frames: 747 DEVICE_EVENT, 139 CONTROL_EVENT, and 16 SPIGOT_EVENT deliveries.
- A subsequent live aggregate included the exact capability families `motionSensor`, `presenceSensor`, `battery`, `temperatureMeasurement`, `illuminanceMeasurement`, `signalStrength`, and `airQualitySensor` across 13 unique device IDs. This proves multi-capability live delivery, not the transport type or physical protocol of each device.

This supports initial inventory/state snapshot, a live push transport, and short-window background delivery. It is not a GO decision. Six sanitized request/ACK correlations now prove that the snapshot completeness gate sees locations, rooms, device cards, device states, device health, and scenes before marking the snapshot complete. Stable query names also let a successful empty category count as observed, while mixed or request/response-conflicting shapes fail closed. The live events were not causally tied to a user-triggered physical action. An event-ID dedupe algorithm collapses 3 sanitized deliveries from one real event into 1 logical event, and the runtime capture path exposes only safe aggregate counters. One HAOS add-on/browser restart restored the session and complete snapshot; long-idle background durability, host-reboot recovery, exact Zigbee/Edge/cloud-to-cloud classification, command execution, and paid/public SmartThings API independence beyond the sampled windows remain unproven.

A live Home Assistant OS 18.2 add-on run on 2026-08-24 proved that version 0.1.22 starts sandboxed headed Chromium under the enforced Supervisor AppArmor profile and serves the real Samsung Account login page through Ingress/noVNC. After manual VNC login, the same add-on reached `CONNECTED`, reported `observedDeviceCount=213`, initially returned readiness true, decoded live DEVICE_EVENT traffic with increasing safe counters, and kept `protocolChangeCount=0` and `restartCount=0`.

That logged-in run also exposed a readiness semantics defect: the initial snapshot proof was treated as stale after 120 seconds even though the browser context stayed connected and push/parser counters continued to update. Version 0.1.23 changes that gate so the current-context initial snapshot proof persists until a reconnect/context reset clears it, while heartbeat freshness, recent push traffic, and current-context parser proof still gate readiness.

Version 0.1.24 then attached Playwright/CDP observers before reloading a restored authenticated keeper. On the same HAOS install, the persisted session returned automatically after an add-on restart, the bridge reacquired the complete snapshot and `observedDeviceCount=213`, and readiness remained true with `initialSnapshotAgeMs=147196`, beyond the former 120000 ms boundary. Live counters continued increasing with `protocolChangeCount=0` and `restartCount=0`.

Version 0.1.25 adds a source-independent sanitized payload fingerprint for the missing-event-ID fallback so a changed value or event timestamp is not collapsed into an earlier logical event. It was deployed through Supervisor after duplicate-slug source backups were moved outside the local app discovery root. The session and snapshot restored again, and readiness remained true at `initialSnapshotAgeMs=145892` with 213 observed devices, 170 decoded deliveries, 85 unique logical events, 85 duplicate deliveries, `protocolChangeCount=0`, and `restartCount=0`. This live sample validates the release path and normal event-ID dedupe path; no real missing-ID SmartThings event was observed.

A privacy-safe external 72-hour passive soak started on 2026-08-24 with a 300-second interval. Its first corrected-run sample was `live=true`, `ready=true`, `state=CONNECTED`, with 213 observed devices, `protocolChangeCount=0`, `restartCount=0`, and an invalid-frame baseline of 2. Start-boundary checks returned Ingress 200, noVNC asset 200, and noVNC WebSocket 101. The evaluator also detects a successful browser/context restart through browser-uptime rollback even when `restartCount` stays zero. This run is still `pending`; it is not long-idle durability evidence until the full duration completes without a failure.

The HA Core restart continuity operator is implemented but remains non-mutating while that soak runs. A live preview confirmed Core `2026.8.3` with boot and watchdog enabled, a running Core container, and Bridge `0.1.25` live, ready, `CONNECTED`, with the current snapshot and browser uptime present. The preview returned only `soak_gate_blocked` and did not send a restart. Actual Core-restart continuity is still unverified.

A separate read-only HAOS process-socket audit sampled the live 0.1.25 container four times over 19.597 seconds. The Bridge listener was present in every sample, Bridge-owned external TCP connections remained zero, and Chromium-owned external TCP connections were present in every sample with a maximum of three. The tool discarded destination addresses, ports, process IDs, socket identifiers, and raw command output before writing the reviewed aggregate. This strengthens runtime traffic separation evidence but remains a bounded sample rather than complete network-history or paid/public API-independence proof.

A second read-only audit classified the retained sanitized capture database inside the live container without exporting URLs or hostnames. Across 1,999 URL-source records spanning about 6 hours 46 minutes, 1,985 valid network URL records included 12 consumer SmartThings Web records and zero public SmartThings API records. This strengthens classification beyond the initial 111-request window, but retained rows can double-count one exchange and are not guaranteed to be complete network history.

Version 0.1.27 is deployed to HAOS. It repaired the live DeviceStore-to-SSE-to-Home-Assistant sensor path, preserved 213 devices and 352 registered entities across a Bridge sequence reset, and produced matched temperature, humidity, contact, motion, and power updates without SmartThings polling. Sampled changed values reached Home Assistant in 0.091 to 1.222 seconds. Physical-action attribution remains unverified because the bounded probe failed closed on an unrelated component-less event before the requested contact action.

Phase 2 remains closed until sanitized real captures prove the remaining host-reboot/long-idle durability, physical-action device-event correlation, command, and API-independence requirements.

DECISION: LIMITED
