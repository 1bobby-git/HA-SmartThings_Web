# SmartThings Web Bridge Phase 1 Manual Test

Do not enter Samsung credentials into this repository, a config file, an issue, or any chat. Enter credentials only in the real Chromium window exposed through the add-on Ingress noVNC view. Do not capture passwords, MFA codes, CAPTCHA values, cookies, CSRF values, Authorization headers, session tokens, or bridge tokens.

## Add-on and Standalone Paths

1. Home Assistant add-on: run `npm ci`, then `npm run package:addon`; copy the contents of `dist-addon/smartthings_web_bridge` to `/addons/smartthings_web_bridge`, refresh **Settings → Apps → Install app**, then install the local app. Its configured slug is `smartthings_web_bridge` and its installed Supervisor slug is `local_smartthings_web_bridge`. Start it, open Ingress, and use the noVNC Chromium view. Do not copy the raw `addon/smartthings_web_bridge` source folder because it lacks generated monorepo build inputs. Generated text is canonical UTF-8/LF, so equivalent Windows and Linux checkouts produce the same manifest SHA-256 without rewriting monorepo source files. Keep backup copies outside `/addons`; otherwise Supervisor can discover a backup with the same slug and select stale metadata.
2. Standalone bridge: run the built bridge with an isolated data directory and confirm no normal Chrome profile is used.
3. Confirm `/health/live` returns live and `/health/ready` stays unready until the keeper page and observation state are usable.
4. Confirm the keeper tab is `https://my.smartthings.com/location` and only temporary inspection tabs are opened.
5. After login and protocol discovery, confirm readiness remains permitted beyond the old 120-second snapshot boundary while heartbeat and push freshness remain current and the current-context parser proof stays healthy.

## Login and Keep-Login

1. Sign in to Samsung manually in Chromium.
2. Enable any SmartThings Web keep-login option shown by the real site.
3. Record only sanitized evidence: login page visible, login complete page visible, cookie names and expiry classes without values, and local/session storage key names without values.
4. Close no credential dialogs by automation and do not attempt CAPTCHA or MFA bypass.

## Runtime Matrix

Run each scenario and record sanitized pass/fail evidence:

- location-only: keep only `/location` open and trigger a real device event.
- background tab: a 20-second background delivery window is verified; repeat with deliberate device actions and long idle periods to test throttling.
- device matrix: contact, motion, leak, temperature/humidity, battery, plug, power plug, Edge device, Samsung Wi-Fi appliance, third-party cloud device, multi-component device, button, scene, and offline device where available.
- network outage: disconnect network for one minute, restore it, and record reconnect plus any snapshot gap.
- restart: restart Home Assistant Core only, then the add-on, then the host if safe for the environment.
- session restore: the 0.1.24 HAOS run restored `/data/chromium-profile`, returned to `CONNECTED`, and reacquired the complete snapshot after one add-on restart; repeat this check for later releases and record only the state transition and safe counters.
- redaction evidence: verify exported captures contain aliases like `loc_001` and `dev_001`, never raw identifiers or secrets.
- triggered-event correlation: record the time of one safe physical device action and prove the matching DEVICE_EVENT capability/attribute shape without retaining the raw device ID or value.
- dedupe: confirm repeated deliveries with the same event ID collapse to one logical event before Home Assistant integration work begins.

Run `npm run protocol:replay` after updating sanitized fixtures. The command must report the expected unique-event count with zero invalid frames before the evidence can support a GO review.

Run `npm run snapshot:replay` after updating snapshot correlation fixtures. All six required categories must match and `complete` must be true before testing live reconnect recovery.

## Physical-Action Probe (0.1.26 Candidate)

Version 0.1.26 is implemented and packaged locally but has not been deployed to HAOS. Physical-action correlation remains unverified until the updated add-on is deployed after the soak and one real safe user action produces one unique passing result.

Do not install or start 0.1.26 until the active 0.1.25 72-hour soak is sealed.

After that deployment hold is released:

1. Keep exactly one settled SmartThings `/location` keeper page open. Do not open `/advanced`, a device detail, a login page, or another tab during the probe window.
2. Confirm the Bridge is live, ready, `CONNECTED`, has observed devices, and reports zero protocol changes and restarts.
3. Run `npm run probe:physical-action:haos -- status`. The currently deployed 0.1.25 correctly returns the fixed `not_found` result because the probe is not deployed there; after the candidate update it must return a sanitized snapshot.
4. Start one bounded attempt with `npm run probe:physical-action:haos -- arm --action contact_open --window-seconds 60 --wait`. Replace only the fixed action name when testing another supported preset. An optional target may be supplied as `--target-device-alias dev_001`.
5. While the command waits, perform exactly one safe physical action. Do not use a browser command, scene, automation, lock, valve, garage actuator, appliance, or safety system.
6. The operator polls `GET /probe/physical-action` and returns only the sanitized snapshot. Only one matching logical candidate with `state=pass` is countable; `ambiguous`, `fail`, `voided`, or `armed` is not proof.
7. Run `npm run probe:physical-action:haos -- reset` before another attempt. This calls `POST /probe/physical-action/reset` with `{}`. Never retain request bodies, raw values, raw IDs, URLs, headers, cookies, or internal dedupe keys.

The operator uses the existing HAOS administrator SSH path and container-local Bridge port; it exposes no new network port or token. The underlying fixed endpoints remain `POST /probe/physical-action/arm`, `GET /probe/physical-action`, and `POST /probe/physical-action/reset`.

The probe adds no DOM state source, direct SmartThings API call, Home Assistant entity, command path, or persistent event journal. Keep `DECISION: LIMITED` after a pass until every other Phase 1 gate is independently proven.

## Passive 72-Hour Soak

Run the privacy-safe collector described in `docs/haos-soak.md` with a 300-second interval. Keep its JSONL samples outside the repository. The automatic verdict must reach `pass`; a `pending` result is not completion, and any live/ready/state failure, collection error, counter regression, protocol change, restart count or browser-uptime rollback, invalid-frame increase, excessive sample gap, or sustained memory-growth failure keeps the durability gate closed.

At the beginning and end, separately verify Ingress HTTP 200, internal noVNC HTTP 200, and the noVNC WebSocket upgrade. Record only status codes and sanitized aggregate versions/counters. Do not store the Ingress tokenized path or raw command output.

This soak is passive. Do not combine it with a host reboot, network interruption, or physical device action; those remain independent controlled scenarios.

Before packaging or installing the candidate, run:

```powershell
npm run soak:deployment-gate -- --run-dir <external-run-directory>
```

The gate is read-only and never opens `samples.jsonl`. Exit code `0` with `deploymentEligible=true` is required. A `pending`, failed, malformed, shorter-than-72-hour, over-five-minute interval, sparse/error-bearing, counter-invalid, or SHA-mismatched result exits nonzero and means the candidate must not be deployed. This gate does not deploy, restart, or modify Home Assistant or the add-on.

After the gate passes, run the candidate preflight:

```powershell
npm run deploy:haos:preflight -- --run-dir <external-run-directory> --expected-installed-version 0.1.25 --expected-candidate-version 0.1.26
```

Require exit code `0`. The preflight verifies a clean published `main`, the candidate version and package-manifest SHA-256, and only the installed app's allowlisted slug/version/state/boot/local-build/AppArmor/Ingress posture. It discards the Ingress entry, IP address, options, and all other Supervisor fields. It does not copy files, reload Supervisor, rebuild, stop, start, or restart the app.

## Runtime API-Free Process Audit

Run `npm run audit:api-free:runtime` from the repository root while the logged-in HAOS add-on is healthy. The collector reads only HAOS process/socket ownership and writes a hashed aggregate outside the repository. A passing bounded sample requires the Bridge listener in every sample, zero Bridge-owned external TCP connections, at least one Chromium-owned external TCP connection, and at least two samples. It never stores destination addresses, ports, process IDs, socket identifiers, or packet contents. Treat a pass as bounded process-separation evidence only, not complete network-history or public-API independence proof.

## Protocol Integrity Warning

When a protocol mismatch is suspected, use the add-on Web UI and status page to observe the red protocol warning. Record only sanitized evidence: `PROTOCOL_CHANGED`, parser/readiness state, protocol version, affected semantic category names, and fixture or test references. Liveness and Ingress should remain available while readiness stays false.

To recover, capture sanitized evidence for the new shape, add parser/replay coverage, and review a numeric `protocol_version` bump with the evidence. Do not delete or rewrite `/data/protocol-fingerprint.json` manually. Do not automatically accept the new fingerprint from a live mismatch.

## Decision Rubric

This decision rubric is the only Phase 2 gate input.

- GO: full inventory, initial snapshot, location-wide push events, background delivery, reconnect snapshot, duplicate handling, and at least switch on/off feasibility are all proven without direct SmartThings API calls.
- LIMITED: read events work but control, device coverage, session restore, or snapshot completeness is partial.
- STOP: DOM text is the only state source, push is absent, only visible devices update, full inventory/snapshot is unavailable, direct paid/public SmartThings API is required, frames are not stably interpretable, automation is blocked, or CAPTCHA bypass would be needed.

Phase 2 remains closed until real sanitized traffic supports `DECISION: GO`.
