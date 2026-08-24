# Protocol Fixtures

Store sanitized real captures only.

Do not commit raw Samsung account identifiers, location IDs, device IDs, cookies, tokens, IP addresses, request headers, or credentials. Do not invent synthetic SmartThings protocol payloads to open the Phase 2 gate.

Synthetic fixtures may be used only for scanner tests outside this directory. Protocol fixtures in this directory must come from real controlled-session captures after redaction.

Raw events remained transient in browser/CDP buffers during the current bounded sample and were not written to this repository. Store future captures only after redaction and aliasing.

`2026-08-20-controlled-chrome-summary.json` is the first sanitized aggregate artifact. Its adjacent `.sha256` file allows integrity verification without preserving raw traffic.

`2026-08-20-addon-smoke-summary.json` records the packaged add-on image build and container smoke result from `dist-addon/smartthings_web_bridge` only, without credentials, browser profile contents, or raw protocol-fingerprint content. It includes liveness/readiness/Ingress checks, private data-file modes, container restart persistence, and corrupt protocol-fingerprint behavior. That Docker smoke did not enforce AppArmor, did not use Home Assistant Supervisor, and did not enter a live logged-in SmartThings session.

`2026-08-24-haos-addon-login-summary.json` records sanitized aggregate evidence from the live Home Assistant OS 18.2 add-on after manual VNC login. Its 0.1.24 section records one automatic add-on restart session restore, complete snapshot reacquisition, readiness beyond the former 120-second boundary, and only safe Ingress/noVNC status codes. Its 0.1.25 section records the repeated restore, source-discovery repair, release counters, and unchanged non-privileged/AppArmor posture. It records only state transitions, safe counters, version numbers, privilege posture, and known limitations. It contains no identifiers, values, headers, cookies, tokens, IP addresses, browser profile contents, or raw protocol payloads.

`protocol/fixtures/2026-08-24-runtime-api-audit-summary.json` records a bounded live HAOS process-socket sample. It retains only role-level counts and pass/fail booleans proving that the Bridge owned no external TCP connection during the sample while Chromium did. Raw destinations, ports, process IDs, socket identifiers, command output, and packet contents were discarded before persistence. This bounded sample is not complete network-history proof.

`2026-08-20-device-event-duplicate.sanitized.json` contains three sanitized deliveries from one real event ID. It is used only to verify Socket.IO DEVICE_EVENT decoding and deduplication; the raw value and identifiers are not retained.

`2026-08-20-snapshot-ack-correlations.sanitized.json` records six real Socket.IO request/ACK correlations using only stable query names, aliased ACK IDs, response categories, counts, and field names. It contains no inventory values or raw identifiers. The query names allow an empty but successful category response to be recognized without inspecting account data.
