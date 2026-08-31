# SmartThings Web Advanced Primary Architecture Design

## Status and authority

This design implements the user-provided `HA-SmartThings_Web_Advanced_Architecture_Addendum.md`. The addendum is treated as the approved product requirement, not as repository or tool instructions. Existing repository safety rules still apply: keep the integration domain `smartthings_web`, keep the authenticated browser session private, do not use the official SmartThings API/PAT/OAuth/SmartApp/webhook paths, do not log secrets or raw identifiers, and preserve existing Home Assistant identities.

## Objective

Promote the authenticated SmartThings Advanced web application's internal same-origin endpoints to the primary inventory and device-command path, while retaining the `/location` page only as the long-lived Socket.IO realtime keeper. Reuse the existing normalized `DeviceStore`, push-confirmation machinery, local authenticated Bridge API, Home Assistant runtime, platform modules, and entity identity rules.

## Verified starting point

The baseline at `main` commit `64a9101` is version `0.1.145`. Fresh pre-change checks passed 795 Vitest tests, 216 Python tests, and TypeScript type checking.

| Area | Current implementation | Required change |
| --- | --- | --- |
| Browser/session | One headed persistent Chromium context, one `/location` keeper, temporary Advanced/command pages | Add an explicit authenticated-session facade; keep the same context and keeper |
| Advanced inventory | One temporary Advanced page observes/fetches the device list as enrichment | Make a paginated Advanced adapter authoritative for inventory and initial status; add endpoint-specific methods and isolated parsers |
| Realtime | `/location` Socket.IO feeds `DeviceStore` and HA SSE | Keep it as the delta source; resubscribe and trigger full Advanced reconciliation after reconnect |
| Commands | Location-native Cake client first, then verified DOM interactions | Insert direct Advanced command first; retain native Cake second and DOM only as an explicit final unsupported-command fallback |
| Confirmation | Per-device queue, request dedupe, event/snapshot confirmation, timeout | Add explicit receipt/confirmation states, status recheck, stateless semantics, command transport metadata, and event-time matching |
| State | SQLite-backed normalized inventory with timestamp ordering and HA sequence-gap recovery | Add source/fetched metadata, capability definition cache, endpoint statistics, and exactly-once event application |
| HA identity | `deviceId_component_capability_attribute` state unique IDs and `(smartthings_web, deviceId)` device identifiers | Preserve without migration; add regression gates against duplicates and identity rotation |
| HA services/options | Entity services and safe-control/read-only option only | Add the generic domain command and bounded maintenance services plus advanced options |
| Diagnostics/docs | Aggregate redacted diagnostics; docs say Advanced is observation-only | Add adapter/realtime/command metrics and document the new architecture in Korean |

## Considered approaches

### 1. Replace the bridge with a new Advanced-only service

Rejected. It would discard mature keeper, redaction, store, command confirmation, packaging, and HA compatibility code. It would also create the highest risk of duplicate devices and session drift.

### 2. Add direct `fetch` calls inside `runtime.ts` and `command-page.ts`

Rejected. This is smaller initially but keeps endpoint paths, response parsing, session recovery, command error classification, and fallback policy coupled to already-large files. It would be hard to test endpoint changes in isolation.

### 3. Add adapter seams around the existing store and confirmation pipeline

Selected. `AuthenticatedSmartThingsSession` owns same-context requests and temporary Advanced page fallback. Advanced inventory and command adapters depend on that interface. The current Location-native and DOM executor is wrapped by an ordered command router. All transports feed the existing `DeviceStore` and confirmation coordinator, so HA entities and IDs do not change.

## Target architecture

```text
AuthenticatedSmartThingsSession
├─ AdvancedEndpointBuilder
├─ AdvancedInventoryAdapter
├─ AdvancedCommandAdapter
├─ LocationRealtimeAdapter
├─ CommandConfirmationCoordinator
├─ StateReconciliationCoordinator
└─ DomFallbackAdapter
       │
       └─ existing DeviceStore -> Bridge HTTP/SSE -> SmartThingsWebRuntime -> existing HA entities
```

The interfaces are implemented as focused TypeScript modules under `bridge/src/advanced`, `bridge/src/realtime`, and `bridge/src/command`. Existing public Bridge routes remain backward compatible. New response fields are additive.

## Authenticated session and request execution

`AuthenticatedSmartThingsSession` receives the existing Playwright `BrowserContext` and keeper manager. Its request order is:

1. Same-origin `fetch` in the authenticated `/location` page.
2. Same-context request support when it can preserve the browser session and origin contract.
3. A short-lived hidden Advanced page when CSRF/origin rules reject the keeper request.

Temporary pages are closed after the request batch. Cookies, storage state, authorization headers, CSRF values, and raw response bodies never enter logs or persisted diagnostics. Authentication failures are classified and surfaced to the existing login-repair path; one session-recovery lock prevents concurrent relogin work.

## Endpoint and parser separation

`AdvancedEndpointBuilder` is the only module that knows Cupcake paths. It provides paths for locations, rooms, devices, status, health, preferences, profiles, capabilities, commands, history, rules, scenes, hubs, and drivers.

`AdvancedInventoryAdapter` calls the session and passes payloads to endpoint-specific parsers. A parser failure affects only its endpoint or device. Inventory pagination follows server links/page metadata first and only falls back to `isNext/max/page`. Pages are merged by raw SmartThings `deviceId`, with later responses winning. Identifiers are put into the existing in-memory alias map before redaction and only aliased values enter `DeviceStore` or Bridge responses.

The normalized model adds optional metadata for device classification, parent/child relations, owner/profile/presentation IDs, execution context, capability versions, page counts, and data source timestamps. Existing required fields and public keys remain unchanged.

## Capability cache and validation

Capability definitions are cached by `(capabilityId, version)`. Definitions retain command names, argument schemas, enums, numeric ranges, units, required flags, and sensitive flags. The command validator rejects unknown commands, missing arguments, invalid types, out-of-range values, and unsafe values before a network request. Custom capability identifiers use the same schema path as standard capabilities.

The cache is bounded and session-scoped. Sensitive schema fields are never included in diagnostics. Missing or malformed definitions do not stop inventory; they only make that command unavailable until a later reconciliation succeeds.

## Command routing and error policy

The ordered router is fixed:

1. `AdvancedCommandAdapter`
2. Existing `/location` native Cake command
3. Other already-verified internal paths
4. `DomFallbackAdapter`

Only an explicit unsupported-command result advances to the next adapter. Authentication, permission, offline, invalid arguments, HTTP errors, parser changes, timeouts, and transient network failures do not silently become DOM clicks. Transient network failures use a small bounded retry policy. DOM fallback is separately configurable and must match an existing verified observed control.

Dangerous lock, valve, garage, and door controls remain fail-closed unless the existing repository safety policy is separately changed with live evidence.

## Command confirmation

The internal lifecycle is `PENDING`, `ACCEPTED`, `CONFIRMED_BY_EVENT`, `CONFIRMED_BY_STATUS`, `ACCEPTED_UNCONFIRMED`, `FAILED`, or `TIMEOUT`. An Advanced HTTP 200/`ACCEPTED` response is only a receipt.

For stateful commands, the coordinator registers the expected state before sending, then matches post-send Location events by device, component, capability, attribute, normalized value, and event time. `commandId` is auxiliary. If no event arrives within the first window, it makes one Advanced status request. A matching status confirms the command; otherwise it returns timeout/unconfirmed according to the request contract. HA state is never optimistically changed.

Stateless commands return receipt success after `ACCEPTED` without waiting for a nonexistent persistent attribute. A relevant event upgrades the evidence when available. Stateless commands never mutate unrelated device state.

## Realtime and reconciliation

`LocationRealtimeAdapter` keeps the current `/location` page and Socket.IO observer. It tracks connection state, last event, heartbeat, reconnect count/time, and subscription state. Reconnect uses exponential backoff, resubscribes, then invokes `StateReconciliationCoordinator` for a full Advanced snapshot.

`DeviceStore` remains the central store. Each value gains source and observation time metadata. Event deduplication occurs before store publication using `eventType + eventId`, or the required fallback tuple when no event ID exists. Per-attribute event time prevents stale delivery from reverting a newer value. An older Advanced snapshot cannot overwrite a newer Location event.

Full Advanced reconciliation occurs on initial start, successful login, Socket.IO resubscribe, user reload, suspected topology change, and a configurable low-frequency interval. Healthy realtime operation does not trigger short-interval polling.

## Home Assistant compatibility and services

The Bridge inventory continues to feed the existing `SmartThingsWebRuntime` and platform modules. No entity key, unique ID, config-entry unique ID, domain, device registry identifier, user name, area assignment, enabled state, automation reference, or dashboard reference is changed.

The integration registers `smartthings_web.execute_command` with `device_id`, `component`, `capability`, and `command`, plus optional `arguments`, `confirm`, and `timeout`. It also provides bounded `reload_inventory`, `refresh_device`, and `reconnect_realtime` maintenance services. Service schemas reject raw secrets and invalid command arguments.

Config flow versioning is additive. New options have safe defaults and do not require deleting or re-adding the config entry.

## Diagnostics and security

Diagnostics expose only allowlisted aggregate fields: architecture/version, session/login/keeper/socket state, reconnect timestamps/counts, Advanced sync/page/device/location counts, pending command count, last transport/confirmation, adapter failure counts, and DOM fallback count.

Email, account/location/device/room IDs, cookies, authorization, CSRF, tokens, IP/MAC/SSID/serial values, certificates, coordinates, raw payloads, and browser profile data remain excluded. Logs use adapter/endpoint categories and aliases only.

## Verification strategy

Implementation follows red-green-refactor slices. Required automated coverage includes pagination beyond 200, duplicate merge, multiple locations, capability caching and argument validation, dynamic command bodies, receipt-not-success behavior, event/status/timeout confirmation, commandId-free matching, event dedupe and ordering, reconnect reconciliation, adapter outage isolation, final-only DOM fallback, unchanged unique IDs, duplicate-entity prevention, services/options, and diagnostics redaction.

Fresh final verification must run Vitest, Python unittest discovery, TypeScript typecheck, build, package checks, API-free audit adjusted to allow only same-origin Cupcake endpoints, fixture/secret audits, and documentation/version gates. Tests requiring the real account remain outside default CI. No live deployment or physical-device claim is made without a separate authorized deployment and post-command push proof.

