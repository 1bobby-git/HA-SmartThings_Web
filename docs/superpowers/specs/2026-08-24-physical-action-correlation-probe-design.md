# Physical-Action Correlation Probe Design

**Date:** 2026-08-24

**Status:** Approved recommended design

**Decision boundary:** Phase 1 evidence only; `DECISION: LIMITED` remains in force

## Goal

Prove that one safe human-triggered physical device action is followed by one matching logical SmartThings Web `DEVICE_EVENT` while the normal `/location` keeper remains open. The probe must strengthen causal evidence without controlling a device, scraping DOM state, calling a SmartThings API, or creating Home Assistant entities.

The implementation can be completed and tested autonomously. The final live proof still requires the user to perform one explicitly selected safe physical action after the updated add-on is deployed.

## Chosen approach

Add a bounded, in-memory correlation probe inside the Bridge. The existing Playwright/CDP observers, redactor, Socket.IO decoder, protocol analyzer, and deduplicator remain the only SmartThings traffic path. The probe receives a normalized summary only after a sanitized `DEVICE_EVENT` has passed protocol validation and deduplication.

The probe is armed through an internal Bridge HTTP endpoint exposed only through the existing Home Assistant Ingress boundary. It observes for 60 seconds by default and returns `armed`, `pass`, `ambiguous`, `fail`, or `voided`. It never sends a SmartThings request or browser input.

### Rejected approaches

1. **Post-process `bridge.sqlite`:** rejected because it reopens a larger sanitized capture surface, weakens action-time causality, and makes privacy review harder.
2. **Build the permanent event journal first:** rejected because sequence/resume storage and the local HA integration stream belong to Phase 2 after a GO decision.

## Safe action presets

The arm request accepts only a fixed action type, not arbitrary capability, attribute, or value strings:

| Action type | Capability | Attribute | Expected value | `stateChange` requirement |
| --- | --- | --- | --- | --- |
| `contact_open` | `contactSensor` | `contact` | `open` | true |
| `contact_close` | `contactSensor` | `contact` | `closed` | true |
| `motion_active` | `motionSensor` | `motion` | `active` | true |
| `switch_manual_on` | `switch` | `switch` | `on` | true |
| `switch_manual_off` | `switch` | `switch` | `off` | true |
| `button_push` | `button` | `button` | `pushed` | false or true |

The first live attempt should prefer a contact sensor or motion sensor. Locks, valves, garage/door actuators, appliances, scenes, automations, safety systems, and browser-issued commands are excluded.

An optional `targetDeviceAlias` may be supplied only in the stable redacted form `dev_###`. This supports a conservative two-pass flow: a first discovery window can return candidate aliases; a second window can require one candidate alias. Raw device names and IDs are never accepted.

## Components

### 1. Normalized event summary

Extend the protocol analyzer result for both new and duplicate `DEVICE_EVENT` deliveries with a normalized event summary derived from the already-sanitized Socket.IO delivery:

- `deviceAlias`, accepted only when it matches `dev_###`;
- `component`, `capability`, and `attribute`, accepted only as bounded protocol-name tokens;
- `valueType`, such as `string`, `number`, `boolean`, `null`, `array`, or `object`;
- ephemeral `valueForMatch`, available only inside the process for preset comparison and never serialized by the probe;
- `unitPresent` and `stateChange`;
- optional source-event time parsed in memory;
- dedupe identity class, an output-only SHA-256 hash derived from the internal dedupe key, and occurrence number.

The internal dedupe key is never returned. The raw value, raw or aliased event ID, raw device/location ID, payload, headers, URL, cookie, and token never appear in probe output.

### 2. `PhysicalActionCorrelationProbe`

A focused in-memory component owns one correlation window:

- `arm(preset, baseline, now)` validates runtime readiness and creates a deadline;
- `observe(event, receivedAt)` considers only preset-matching events after the arm time;
- duplicate deliveries increment a delivery count for the existing logical candidate instead of creating another candidate;
- `snapshot(runtimeEvidence, now)` calculates the public state and verdict;
- `reset()` clears all probe state.

The component stores no files and has a bounded maximum of 32 logical candidates. A second arm request while a window is active returns conflict rather than silently replacing evidence. Resetting an active or completed window transitions it to `voided` with reason `manual_reset`; a voided result is never countable as pass/fail evidence. A later arm request may replace only `idle`, `voided`, or expired/completed evidence.

### 3. Browser isolation gate

The runtime provides the probe with a boolean isolation prerequisite calculated from the active BrowserContext. Arming requires exactly one non-closed Chromium page, that page must be categorized as `smartthings_location`, and the existing keeper status must identify it as the active keeper. Any extra `/advanced` page, login page, blank page, device/detail page, or unknown page rejects arming with fixed reason `browser_not_isolated`.

The public probe response exposes only the boolean prerequisite and fixed reason. It never exposes page count, page titles, or raw URLs.

### 4. Internal HTTP surface

Add these no-store JSON endpoints to the existing Bridge HTTP server:

- `GET /probe/physical-action` — returns the safe current snapshot;
- `POST /probe/physical-action/arm` — accepts at most 4 KiB JSON with `actionType`, optional `targetDeviceAlias`, and optional 15–120 second `windowSeconds`;
- `POST /probe/physical-action/reset` — voids an active or completed probe; a subsequent arm may start new evidence.

Arming is rejected unless the Bridge is live, ready, `CONNECTED`, has observed devices, reports exactly one isolated `/location` keeper page, and currently reports zero protocol changes and zero restarts. Unsupported methods, oversized bodies, malformed JSON, unknown properties, unsafe aliases, and out-of-range windows fail with fixed error codes. Error responses never echo request bodies.

No new port, authentication mechanism, host permission, or public route is introduced. Home Assistant Ingress remains the access boundary.

## Data flow

1. The user or operator arms one fixed safe action preset after the Bridge proves exactly one isolated `/location` keeper page.
2. The probe captures only safe baseline counters and the monotonic arm time.
3. The user physically performs that action while only the `/location` keeper is present.
4. Existing Playwright and CDP observers see the same browser WebSocket delivery.
5. Existing redaction aliases identifiers before capture persistence or analysis.
6. The protocol analyzer validates the event shape and deduplicates Playwright/CDP deliveries.
7. The probe compares the ephemeral value to the preset and retains only the boolean match plus safe metadata.
8. After the deadline, the HTTP snapshot reports the verdict.
9. Detailed live evidence remains outside the repository. A reviewed aggregate fixture and SHA sidecar may be added only after a real pass.

## Public result schema

The public snapshot contains:

- schema version and state: `idle`, `armed`, `pass`, `ambiguous`, `fail`, or `voided`;
- action type and optional target device alias;
- window duration, elapsed time, and remaining time;
- baseline and current aggregate event/protocol/restart counters;
- candidate count and failure reasons;
- for each candidate: device alias, component, capability, attribute, value type, unit-present flag, state-change flag, expected-value-match boolean, logical-event identity class, output-only SHA-256 logical-event hash, unique logical-event count, delivery count, receive-after-arm milliseconds, and optional source-after-arm milliseconds.

It does not contain an absolute action timestamp, raw source timestamp, raw value, raw identifier, raw or aliased event ID, internal dedupe key, device name, location, URL, header, or payload. The logical-event hash must not contain or preserve the `event_id:` or `fingerprint:` key prefix.

## Verdict rules

`pass` requires all of the following after the deadline:

- runtime stayed live, ready, and `CONNECTED`;
- exactly one non-closed page remained and it stayed the `/location` keeper;
- protocol change and restart counts stayed zero;
- invalid-frame count did not increase from baseline;
- decoded/unique/duplicate counters did not regress;
- exactly one unique logical candidate matches the preset and optional target alias;
- its expected value matched;
- its receive time is after arm and within the window;
- `stateChange=true`, except for the `button_push` preset;
- protocol parsing remained healthy.

`ambiguous` is returned when two or more logical candidates satisfy the action preset or when a target-free discovery run cannot uniquely identify one device alias.

`fail` is returned for no match, runtime health regression, protocol mismatch, restart, invalid-frame increase, counter regression, unsafe normalized event data, candidate overflow, or explicit internal probe failure.

`voided` is returned after an explicit reset of any armed or completed window. It is an operator cancellation marker, not evidence, and cannot be converted to pass/fail without a new arm window.

A pass proves only one action shape on one aliased device in one environment. It does not prove device-family parity, radio transport, command behavior, host reboot recovery, long-idle durability, or complete API independence, and it does not open Phase 2 by itself.

## Error handling and lifecycle

- A browser context reset or protocol pipeline reset marks an active probe failed before analyzer state is cleared.
- Probe failure is fail-closed and remains visible until reset; resetting it produces `voided`, not an implicit success or an erased verdict.
- Expiration is evaluated from monotonic elapsed time; source-event timestamps are supporting evidence only.
- Missing or skewed source-event time does not invalidate a receive-time match, but the public candidate records that source delta was unavailable.
- The Bridge stopping discards the in-memory probe; absence after restart is not treated as successful evidence.
- Probe code never logs request content, values, candidate aliases, or event summaries.

## Test strategy

Use strict red-green TDD with synthetic records only under `bridge/tests`; do not add synthetic payloads to `protocol/fixtures`.

Required tests:

1. normalized event extraction preserves safe aliases and semantic field names while excluding raw values and IDs;
2. Playwright/CDP duplicate deliveries produce one logical candidate with two deliveries;
3. one preset match becomes `pass` only after expiry;
4. two plausible matches become `ambiguous`;
5. target alias filtering selects one candidate;
6. no matching event becomes `fail`;
7. invalid-frame increase, protocol change, restart, readiness loss, or counter regression becomes `fail`;
8. context reset marks an active probe failed;
9. exactly one keeper `/location` page permits arming, while keeper plus `/advanced`, login, blank, device/detail, or arbitrary page rejects with `browser_not_isolated` and no raw URL;
10. resetting an armed or completed probe produces `voided`, and only a new arm can begin evidence again;
11. malformed, oversized, unknown-property, or unsafe arm requests return fixed errors without echoing input;
12. GET/arm/reset responses contain no raw value, URL, token, raw or aliased event ID, internal dedupe key, header, or payload;
13. public logical-event hashes contain neither `event_id:` nor `fingerprint:` and cannot reproduce the input key;
14. malformed requests and observed candidates leave captured logs free of bodies, values, aliases, event summaries, URLs, IDs, headers, and payloads;
15. existing health, status, snapshot, dedupe, protocol, and add-on tests remain green.

## Rollout and verification

1. Implement and verify locally without touching the running 0.1.25 HAOS add-on.
2. Allow the active 72-hour 0.1.25 soak to finish; do not restart or update the add-on during that run.
3. Package the probe as the next add-on version and deploy only after the soak completion evidence is sealed.
4. Reconfirm session/snapshot restoration and normal readiness on the new version.
5. Arm a contact or motion preset, ask the user to perform one safe physical action, and wait for the full window.
6. Review the safe result, run privacy/API/fixture audits, and commit only a sanitized aggregate plus SHA if the verdict passes.
7. Keep `DECISION: LIMITED` until every other GO requirement is separately proven.
