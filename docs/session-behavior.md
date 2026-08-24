# Session Behavior

Manual Samsung login was verified in one controlled Chrome session, and the location page remained connected long enough to receive live Socket.IO subscription events. The raw account/session material was not inspected or persisted.

The tab also continued receiving DEVICE_EVENT, CONTROL_EVENT, and SPIGOT_EVENT messages during a 20-second period when another Chrome tab was selected. Long-idle throttling behavior remains unverified.

Session restore was validated once on the live HAOS 18.2 install with bridge 0.1.24. The persisted headed Chromium profile under `/data/chromium-profile` restored the logged-in SmartThings location after an add-on restart, and the bridge reacquired a complete initial snapshot without another manual login. This does not prove host-reboot or long-idle durability.

The 0.1.25 Supervisor update repeated the same automatic session and complete-snapshot restore and remained ready beyond the former 120-second snapshot boundary. This is a second add-on/browser restart observation, not a host reboot or long-idle result.

Manual testing must continue to record logout, later-release restart, and host reboot behavior before any broad compatibility claim.

The SmartThings Web setting text says login is maintained while the web page remains open and may end when the browser closes. Phase 1 therefore treats the live Chromium process and keeper tab as runtime requirements rather than assuming persisted cookies are sufficient.

If a known incompatible ACK/event shape or corrupt protocol store is detected, the runtime reports PROTOCOL_CHANGED. In that state parser health and readiness remain false, while liveness and Ingress stay available so the operator can observe the red warning and collect sanitized evidence. This is a mismatch state, not a login-recovery or browser-restart success signal.

Short-window background delivery and two add-on/browser restart restores are verified. Host reboot restore, long idle behavior, and long-idle background delivery remain unverified.

The privacy-safe 72-hour passive soak is deferred until the user requests it again. Long-idle items remain unverified.

A fail-closed HA Core restart continuity operator is now implemented. Its live preview verified Core `2026.8.3` boot/watchdog posture, a running Core container, and healthy connected Bridge `0.1.25`, while returning only `soak_gate_blocked` with `remoteMutationPerformed=false`. A live execute-request proof was likewise blocked before output-directory creation and left the Core start time unchanged. Execute mode is gated by the sealed passing soak and exact Core/Bridge versions; it has not restarted Core yet.

Version 0.1.28 is deployed. A Bridge-only restart restored `CONNECTED` state and 213 devices after inventory sequence reset from the 600s to 21 while Home Assistant Core remained running. The current contact state stayed aligned between Bridge and Home Assistant. A targeted component-less contact-open event produced one passing physical-action candidate and updated Home Assistant about 134 ms after its Bridge source time. A separate burst of close/open events remained ordered in Home Assistant, while the strict close attribution window correctly reported `ambiguous` for two candidates.

The Home Assistant OS 18.2 Supervisor install is now verified for enforced AppArmor, sandboxed headed Chromium startup, Ingress status rendering, noVNC delivery of the Samsung Account login page, logged-in add-on observation, targeted physical-action correlation, and repeated automatic session/snapshot restore after add-on updates. Host reboot recovery and long-idle behavior are still manual Phase 1 evidence gaps.
