# Semantic Protocol Integrity Design

## Status

Approved recommended policy: semantic fail-closed. This remains Phase 1 safety work. It does not normalize inventory into Home Assistant entities or execute commands.

## Goal

Persist a privacy-safe record of the protocol contract that the bridge actually proved, detect incompatible changes in known snapshot or DEVICE_EVENT messages, expose a visible warning, and prevent readiness when the parser can no longer prove correct state.

## Policy

The bridge blocks readiness only when a known, previously supported contract becomes unusable:

- a recognized `find` query receives an ACK whose container or required record fields no longer match its category;
- `api/subscription DEVICE_EVENT` arrives but its required identity/event structure cannot be extracted;
- a completed semantic fingerprint differs from the stored baseline under the same numeric protocol contract version.

The bridge does not declare a protocol change because an optional field appears, a value changes type inside an opaque data field, a device is added or removed, an array count changes, or a different supported device-card variant is present.

## Semantic surfaces

Successful observations add fixed semantic surface identifiers:

```text
snapshot:locations:v1
snapshot:rooms:v1
snapshot:device_cards:v1
snapshot:device_states:v1
snapshot:device_health:v1
snapshot:scenes:v1
event:device_event:v1
```

The current fingerprint is the SHA-256 digest of the sorted, unique surface list. It becomes complete only after all six snapshot categories and at least one valid DEVICE_EVENT are observed in the same browser epoch.

This deliberately fingerprints proven parser semantics rather than raw values or complete object key sets. The existing generic `protocolFingerprint` helper is changed so arrays are count- and order-insensitive and represent unique member shapes, but the readiness gate uses the semantic surface list.

## Persistent files

`bootstrapDataPaths` creates two required private files:

```text
/data/protocol-fingerprint.json 0600
/data/settings.json             0600
```

`settings.json` initially contains only:

```json
{"schema_version":1}
```

`protocol-fingerprint.json` contains no raw frames, identifiers, values, URLs, or credentials:

```json
{
  "schema_version": 1,
  "protocol_contract_version": 1,
  "baseline": null,
  "current": null,
  "change_count": 0,
  "last_mismatch": null
}
```

Writes use a sibling temporary file, mode `0600`, flush/close, and atomic rename. Existing invalid JSON or an unsupported schema is treated as a protocol-integrity failure rather than silently overwritten.

## Runtime components

### ProtocolAnalyzer

The analyzer returns an explicit `protocol_changed` result when a known request/event fails semantic validation. It tracks semantic surfaces and exposes:

- `protocolFingerprint?: string`
- `protocolComplete: boolean`
- `protocolMismatchCount: number`
- `protocolMismatchSurface?: string`

Unknown unrelated Socket.IO traffic remains ignored and cannot contribute to the fingerprint or mismatch counter.

### ProtocolIntegrityStore

`bridge/src/state/protocol-integrity-store.ts` owns the JSON file. It provides:

- `observeCompleteFingerprint(fingerprint)` — creates the first baseline or compares with it;
- `recordMismatch(surface)` — persists one increment per new mismatch key;
- `snapshot()` — returns only safe digest/version/count fields.

If `protocol_contract_version` in `protocol/version.json` increases, the store archives no raw data and establishes a new baseline after a complete epoch. A version bump is the explicit developer acknowledgement that parser semantics changed.

### Runtime state

On a matching complete fingerprint, runtime status exposes `protocolVersion` as `1:<first 16 hex characters>`.

On mismatch:

- state becomes `PROTOCOL_CHANGED`;
- `parserHealthy` becomes false;
- `protocolChangeCount` is updated from the persistent store;
- readiness becomes false through the existing health contract;
- liveness stays true so the add-on and Ingress remain available for repair.

Browser reconnect resets the epoch's observed surfaces but does not delete the persisted baseline or change count.

## Status UI

The Ingress status page displays a dedicated protocol evidence panel:

- green: complete fingerprint matches baseline;
- amber: discovery incomplete, with readiness still false for existing reasons;
- red: `PROTOCOL_CHANGED`, showing only the safe mismatch surface, protocol version, change count, and instructions to keep Phase 2 closed.

No raw payload, URL, identifier, value, or secret is rendered.

## Recovery

The bridge never automatically accepts a mismatch under the same contract version. Recovery requires a code review, sanitized fixture update, parser/test update, and numeric `protocol_version` bump. This is intentionally conservative because accepting an unknown protocol automatically could publish incorrect Home Assistant state later.

## Tests

Tests must prove:

- array order/count and optional inventory variation do not alter the semantic fingerprint;
- all seven surfaces are required before completion;
- known snapshot and DEVICE_EVENT incompatibilities return `protocol_changed`;
- unrelated traffic does not create a mismatch;
- first complete observation creates a baseline;
- a matching restart epoch remains healthy;
- a same-version different fingerprint persists one mismatch and blocks readiness;
- corrupt state fails closed without leaking file contents;
- both JSON files have `0600` and survive bootstrap/restart;
- status HTML contains the protocol warning but no raw data;
- reconnect clears epoch observation but preserves persistent integrity state.

## Completion criteria

The feature is complete when focused tests pass, the full suite/typecheck/build/audits pass, the self-contained add-on image reaches `LOGIN_REQUIRED`, and a fixture-driven complete epoch produces a persisted safe fingerprint while an incompatible known ACK produces `PROTOCOL_CHANGED` and ready=false.
