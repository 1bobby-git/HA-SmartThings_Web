# SmartThings Web Advanced Primary Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make same-session SmartThings Advanced endpoints the primary inventory and command path while preserving the `/location` realtime keeper, existing HA entity identities, and secret boundaries.

**Architecture:** Add a focused Advanced endpoint/session/adapter layer to the TypeScript Bridge, then route its normalized output into the existing `DeviceStore` and command confirmation pipeline. Extend the local Bridge and Home Assistant contracts additively; do not replace platform/entity discovery or existing unique-ID formulas.

**Tech Stack:** TypeScript 7, Playwright Core, Vitest, Node HTTP/SSE, Python Home Assistant custom integration, Python unittest.

---

## File structure

| File | Responsibility |
| --- | --- |
| `bridge/src/advanced/endpoints.ts` | Central same-origin Advanced URL builder |
| `bridge/src/advanced/types.ts` | Request/response, error, inventory, capability, and command receipt types |
| `bridge/src/advanced/parsers.ts` | Endpoint-isolated response parsers and pagination metadata |
| `bridge/src/advanced/authenticated-session.ts` | Same-context fetch plus short-lived Advanced-page fallback |
| `bridge/src/advanced/inventory-adapter.ts` | Paginated inventory and endpoint-specific reads |
| `bridge/src/advanced/capability-cache.ts` | `(capability, version)` definition cache and argument validation |
| `bridge/src/advanced/command-adapter.ts` | Dynamic command body POST and receipt classification |
| `bridge/src/command/command-router.ts` | Advanced → Location-native → other internal → DOM ordering |
| `bridge/src/command/command-confirmation.ts` | Receipt lifecycle, event/status confirmation, stateless policy |
| `bridge/src/realtime/location-realtime-adapter.ts` | Keeper/socket health and reconnect/resubscribe signals |
| `bridge/src/state/reconciliation-coordinator.ts` | Full Advanced sync scheduling and snapshot/event ordering |
| Existing `runtime.ts`, `device-store.ts`, `command-service.ts`, `command-page.ts` | Composition seams only; retain existing behavior behind new interfaces |
| `custom_components/smartthings_web/services.yaml` | HA domain service descriptions and schemas |
| Existing HA client/runtime/config/diagnostics files | Additive service, option, diagnostics, and result-contract support |

## Task 1: Endpoint builder and response parsers

**Files:**
- Create: `bridge/src/advanced/endpoints.ts`
- Create: `bridge/src/advanced/types.ts`
- Create: `bridge/src/advanced/parsers.ts`
- Create: `bridge/tests/advanced/endpoints.test.ts`
- Create: `bridge/tests/advanced/parsers.test.ts`

- [ ] **Step 1: Write failing URL-builder and parser tests**

Cover every required path, encoded IDs, first-page flags, link-first pagination, fallback page calculation, malformed endpoint isolation, duplicate `deviceId` merge with later response winning, and multi-location rows.

```ts
expect(advancedEndpoints.deviceCommands("device/a")).toBe(
  "/advanced/cupcake-api/api/devices/device%2Fa/commands"
);
expect(parseDevicePage({ items: [{ deviceId: "a", label: "old" }], links: { next: "/next" } }))
  .toMatchObject({ items: [{ deviceId: "a" }], next: "/next" });
expect(mergeDevicePages([
  { items: [{ deviceId: "a", label: "old" }] },
  { items: [{ deviceId: "a", label: "new" }, { deviceId: "b" }] }
]).map((row) => row.label)).toEqual(["new", undefined]);
```

- [ ] **Step 2: Run the new tests and verify missing-module failure**

Run: `npx vitest run bridge/tests/advanced/endpoints.test.ts bridge/tests/advanced/parsers.test.ts`

Expected: FAIL because the new Advanced modules do not exist.

- [ ] **Step 3: Implement immutable endpoint builders and narrow parsers**

```ts
export const advancedEndpoints = {
  devices: (query: URLSearchParams) => `/advanced/cupcake-api/api/devices?${query}`,
  deviceStatus: (id: string) => `${deviceBase(id)}/status`,
  deviceHealth: (id: string) => `${deviceBase(id)}/health`,
  devicePreferences: (id: string) => `${deviceBase(id)}/preferences`,
  deviceCommands: (id: string) => `${deviceBase(id)}/commands`,
  locations: () => "/advanced/cupcake-api/api/locations?allowed=true",
  rooms: (id: string) => `/advanced/cupcake-api/api/locations/${encodeURIComponent(id)}/rooms`,
  profile: (id: string) => `/advanced/cupcake-api/api/deviceprofiles/${encodeURIComponent(id)}`,
  capability: (id: string, version: number) =>
    `/advanced/cupcake-api/api/capabilities/${encodeURIComponent(id)}/${version}`,
  history: () => "/advanced/cupcake-api/api/history/devices",
  rules: () => "/advanced/cupcake-api/api/rules",
  clientRules: () => "/advanced/cupcake-api/clientv1/rules",
  scenes: () => "/advanced/cupcake-api/clientv3/scenes",
  hub: (id: string) => `/advanced/cupcake-api/api/hubdevices/${encodeURIComponent(id)}`,
  hubDrivers: (id: string) => `/advanced/cupcake-api/api/hubdevices/${encodeURIComponent(id)}/drivers`
} as const;
```

Parsers return `AdvancedParseError` per endpoint rather than throwing through the whole inventory run. Raw identifiers remain in parser results only until the caller registers aliases and redacts the payload.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npx vitest run bridge/tests/advanced/endpoints.test.ts bridge/tests/advanced/parsers.test.ts && npm run typecheck`

Expected: PASS.

## Task 2: Authenticated session and paginated inventory adapter

**Files:**
- Create: `bridge/src/advanced/authenticated-session.ts`
- Create: `bridge/src/advanced/inventory-adapter.ts`
- Create: `bridge/tests/advanced/authenticated-session.test.ts`
- Create: `bridge/tests/advanced/inventory-adapter.test.ts`
- Modify: `bridge/src/browser/keeper-page.ts`

- [ ] **Step 1: Write failing session-order and pagination tests**

The tests use fake Playwright pages. Prove keeper `fetch` first, same-context fallback second when available, hidden Advanced page last, hidden page closure, shared context, 235-item pagination, link precedence, fallback `page=1`, and duplicate last-write-wins.

```ts
expect(calls).toEqual(["keeper-fetch"]);
expect(result.pages).toHaveLength(2);
expect(result.devices).toHaveLength(235);
expect(result.devices.find((row) => row.deviceId === "duplicate")?.label).toBe("latest");
expect(hiddenPage.close).toHaveBeenCalledOnce();
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run bridge/tests/advanced/authenticated-session.test.ts bridge/tests/advanced/inventory-adapter.test.ts`

Expected: FAIL because the session and adapter are absent.

- [ ] **Step 3: Implement the request contract**

```ts
export interface AuthenticatedSmartThingsSession {
  request<T>(request: AdvancedRequest, parser: AdvancedParser<T>): Promise<T>;
  requestBatch<T>(requests: readonly AdvancedRequest[], parser: AdvancedParser<T>): Promise<T[]>;
}

export interface AdvancedInventorySnapshot {
  devices: AdvancedDeviceRow[];
  locations: AdvancedLocationRow[];
  rooms: AdvancedRoomRow[];
  pageCount: number;
  fetchedAtMs: number;
}
```

Implement bounded timeouts, authentication/error classification, page closure in `finally`, no secret logging, and link-loop protection. Expose keeper-manager accessors without changing its one-keeper invariant.

- [ ] **Step 4: Run focused tests, existing keeper tests, and typecheck**

Run: `npx vitest run bridge/tests/advanced bridge/tests/browser/keeper-page.test.ts && npm run typecheck`

Expected: PASS.

## Task 3: Promote Advanced inventory through reconciliation into DeviceStore

**Files:**
- Create: `bridge/src/state/reconciliation-coordinator.ts`
- Create: `bridge/tests/state/reconciliation-coordinator.test.ts`
- Modify: `bridge/src/state/device-store.ts`
- Modify: `bridge/tests/state/device-store.test.ts`
- Modify: `bridge/src/runtime.ts`
- Modify: `bridge/tests/runtime.test.ts`

- [ ] **Step 1: Write failing reconciliation and compatibility tests**

Prove Advanced initial snapshot is authoritative, `/location` delta remains newer, stale snapshot cannot revert a pushed value, reconnect schedules one full Advanced sync, endpoint failure leaves realtime active, page count is recorded, and the same aliased device/component/capability/attribute keys are retained.

```ts
expect(store.snapshot().devices.map((device) => device.id)).toEqual(["dev_001"]);
expect(state.value).toBe("on");
expect(state.source).toBe("LOCATION_EVENT");
expect(sync).toHaveBeenCalledOnce();
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run bridge/tests/state/reconciliation-coordinator.test.ts bridge/tests/state/device-store.test.ts bridge/tests/runtime.test.ts`

Expected: FAIL on missing coordinator/source metadata.

- [ ] **Step 3: Implement coordinator and optional store metadata**

```ts
export type StateSource =
  | "ADVANCED_SNAPSHOT"
  | "LOCATION_EVENT"
  | "COMMAND_STATUS_RECHECK"
  | "DOM_FALLBACK";

export interface ReconciliationTrigger {
  reason: "startup" | "login" | "reconnect" | "reload" | "topology" | "interval";
  requestedAtMs: number;
}
```

Coalesce concurrent full-sync requests. Register raw identifiers with `VolatileIdentifierMap`, redact, normalize, and call existing store merge methods. Do not delete the existing HA-facing snapshot shape.

- [ ] **Step 4: Run focused tests and full Bridge tests**

Run: `npx vitest run bridge/tests/state/reconciliation-coordinator.test.ts bridge/tests/state/device-store.test.ts bridge/tests/runtime.test.ts && npm run test:bridge -- --reporter=dot`

Expected: PASS.

## Task 4: Capability definition cache and dynamic argument validation

**Files:**
- Create: `bridge/src/advanced/capability-cache.ts`
- Create: `bridge/tests/advanced/capability-cache.test.ts`
- Modify: `bridge/src/state/device-store.ts`
- Modify: `bridge/tests/state/device-store.test.ts`

- [ ] **Step 1: Write failing cache and schema tests**

Cover one fetch per `(id, version)`, separate versions, custom capability IDs, required arguments, enums, integers/numbers, min/max, units, sensitive field exclusion, unsupported command, and malformed definition isolation.

```ts
await cache.get("switchLevel", 1);
await cache.get("switchLevel", 1);
expect(fetchDefinition).toHaveBeenCalledOnce();
expect(() => validateArguments(definition, "setLevel", [101])).toThrowError("invalid_arguments");
expect(validateArguments(definition, "setLevel", [70])).toEqual([70]);
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run bridge/tests/advanced/capability-cache.test.ts`

Expected: FAIL because the cache is absent.

- [ ] **Step 3: Implement bounded promise cache and validator**

```ts
type CapabilityCacheKey = `${string}@${number}`;

export class CapabilityDefinitionCache {
  readonly #entries = new Map<CapabilityCacheKey, Promise<AdvancedCapabilityDefinition>>();
  get(capabilityId: string, version: number): Promise<AdvancedCapabilityDefinition> {
    const key: CapabilityCacheKey = `${capabilityId}@${version}`;
    const existing = this.#entries.get(key);
    if (existing) return existing;
    const loaded = this.load(capabilityId, version).catch((error) => {
      this.#entries.delete(key);
      throw error;
    });
    this.#entries.set(key, loaded);
    return loaded;
  }
}
```

Keep failed loads retryable and cache size bounded. Add optional version/schema/control metadata without changing existing control IDs.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npx vitest run bridge/tests/advanced/capability-cache.test.ts bridge/tests/state/device-store.test.ts && npm run typecheck`

Expected: PASS.

## Task 5: Advanced command adapter and ordered router

**Files:**
- Create: `bridge/src/advanced/command-adapter.ts`
- Create: `bridge/tests/advanced/command-adapter.test.ts`
- Create: `bridge/src/command/command-router.ts`
- Create: `bridge/tests/command/command-router.test.ts`
- Modify: `bridge/src/browser/command-page.ts`
- Modify: `bridge/tests/browser/command-page.test.ts`
- Modify: `bridge/src/runtime.ts`

- [ ] **Step 1: Write failing command-body and fallback-order tests**

Cover dynamic device/component/capability/command/arguments, raw-ID resolution, schema validation before send, `ACCEPTED` receipt parsing, auth/permission/offline/HTTP/timeout/parser classification, bounded transient retry, and fallback only on `UNSUPPORTED`.

```ts
expect(post.body).toEqual({ commands: [{ component: "main", capability: "switch", command: "on", arguments: [] }] });
expect(order).toEqual(["advanced"]);
expect(orderAfterUnsupported).toEqual(["advanced", "location-native"]);
expect(orderAfterNetworkFailure).toEqual(["advanced"]);
expect(orderAfterAllUnsupported).toEqual(["advanced", "location-native", "other-internal", "dom"]);
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run bridge/tests/advanced/command-adapter.test.ts bridge/tests/command/command-router.test.ts`

Expected: FAIL because both modules are absent.

- [ ] **Step 3: Implement command receipt and ordered router**

```ts
export interface CommandTransportReceipt {
  state: "ACCEPTED" | "UNSUPPORTED";
  transport: "advanced" | "location_native" | "internal" | "dom";
  commandId?: string;
  acceptedAtMs: number;
}

export class OrderedCommandRouter {
  async execute(request: ValidatedCommandRequest): Promise<CommandTransportReceipt> {
    for (const transport of this.transports) {
      const receipt = await transport.execute(request);
      if (receipt.state !== "UNSUPPORTED") return receipt;
    }
    throw new SafeCommandError("unsupported_command");
  }
}
```

Split the existing command page's native and DOM methods behind distinct adapters. Preserve all dangerous-control fail-closed checks.

- [ ] **Step 4: Run command, browser, and runtime tests**

Run: `npx vitest run bridge/tests/advanced/command-adapter.test.ts bridge/tests/command bridge/tests/browser/command-page.test.ts bridge/tests/runtime.test.ts && npm run typecheck`

Expected: PASS.

## Task 6: Explicit confirmation lifecycle, event/status confirmation, and stateless commands

**Files:**
- Create: `bridge/src/command/command-confirmation.ts`
- Create: `bridge/tests/command/command-confirmation.test.ts`
- Modify: `bridge/src/command/command-service.ts`
- Modify: `bridge/tests/command/command-service.test.ts`
- Modify: `bridge/src/state/device-store.ts`
- Modify: `bridge/src/server/http-server.ts`
- Modify: `bridge/tests/server/http-server.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Cover `ACCEPTED` not final for stateful commands, event matching with empty command ID, post-send event time, numeric tolerance, one status recheck, event/status/timeouts, stateless receipt success, no unrelated state mutation, and additive Bridge response fields.

```ts
expect(result.status).toBe("confirmed");
expect(result.lifecycle).toBe("CONFIRMED_BY_EVENT");
expect(statusRecheck).not.toHaveBeenCalled();
expect(statusConfirmed.lifecycle).toBe("CONFIRMED_BY_STATUS");
expect(stateless.lifecycle).toBe("ACCEPTED_UNCONFIRMED");
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run bridge/tests/command/command-confirmation.test.ts bridge/tests/command/command-service.test.ts bridge/tests/server/http-server.test.ts`

Expected: FAIL on missing lifecycle/status recheck behavior.

- [ ] **Step 3: Implement coordinator and additive result contract**

```ts
export type CommandLifecycle =
  | "PENDING"
  | "ACCEPTED"
  | "CONFIRMED_BY_EVENT"
  | "CONFIRMED_BY_STATUS"
  | "ACCEPTED_UNCONFIRMED"
  | "FAILED"
  | "TIMEOUT";
```

Register the waiter before sending, use existing per-device queue/dedupe, match event time after send, and invoke one adapter status read only after the event window. Keep old `status`, `sequence`, and `confirmation` fields for current HA clients.

- [ ] **Step 4: Run command/server tests and Bridge suite**

Run: `npx vitest run bridge/tests/command bridge/tests/server/http-server.test.ts && npm run test:bridge -- --reporter=dot`

Expected: PASS.

## Task 7: Realtime adapter, event dedupe, and reconnect reconciliation

**Files:**
- Create: `bridge/src/realtime/location-realtime-adapter.ts`
- Create: `bridge/tests/realtime/location-realtime-adapter.test.ts`
- Modify: `bridge/src/inspector/event-deduplicator.ts`
- Modify: `bridge/tests/inspector/event-deduplicator.test.ts`
- Modify: `bridge/src/state/device-store.ts`
- Modify: `bridge/tests/state/device-store.test.ts`
- Modify: `bridge/src/runtime.ts`
- Modify: `bridge/src/state/runtime-state.ts`

- [ ] **Step 1: Write failing reconnect and exactly-once tests**

Prove event-ID dedupe before store publication, fallback-key dedupe, old eventTime rejection, heartbeat/socket timestamps, exponential backoff bounds, resubscribe followed by one full Advanced sync, and Advanced outage leaving realtime state available.

```ts
expect(publishedEvents).toHaveLength(1);
expect(reconnectDelays).toEqual([1_000, 2_000, 4_000]);
expect(callOrder).toEqual(["reconnect", "resubscribe", "advanced-sync"]);
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run bridge/tests/realtime/location-realtime-adapter.test.ts bridge/tests/inspector/event-deduplicator.test.ts bridge/tests/state/device-store.test.ts bridge/tests/runtime.test.ts`

Expected: FAIL on missing adapter/pre-store dedupe/reconnect sync.

- [ ] **Step 3: Implement keeper health and pre-store dedupe**

Keep TTL and size bounds. Do not dedupe different event times without event IDs. Publish health/stateless button events once. Add aggregate runtime fields only.

- [ ] **Step 4: Run realtime/store/runtime tests**

Run: `npx vitest run bridge/tests/realtime bridge/tests/inspector/event-deduplicator.test.ts bridge/tests/state/device-store.test.ts bridge/tests/runtime.test.ts && npm run typecheck`

Expected: PASS.

## Task 8: Home Assistant services, options, diagnostics, and identity regressions

**Files:**
- Create: `custom_components/smartthings_web/services.yaml`
- Create: `custom_components/smartthings_web/services.py`
- Create: `custom_components/smartthings_web/tests/test_services.py`
- Modify: `custom_components/smartthings_web/__init__.py`
- Modify: `custom_components/smartthings_web/bridge_client.py`
- Modify: `custom_components/smartthings_web/models.py`
- Modify: `custom_components/smartthings_web/config_flow.py`
- Modify: `custom_components/smartthings_web/const.py`
- Modify: `custom_components/smartthings_web/diagnostics.py`
- Modify: `custom_components/smartthings_web/tests/test_bridge_client.py`
- Modify: `custom_components/smartthings_web/tests/test_models.py`
- Modify: `custom_components/smartthings_web/tests/test_config_flow.py`
- Modify: `custom_components/smartthings_web/tests/test_diagnostics.py`
- Modify: `custom_components/smartthings_web/tests/test_init.py`
- Modify: `custom_components/smartthings_web/strings.json`
- Modify: `custom_components/smartthings_web/translations/en.json`
- Modify: `custom_components/smartthings_web/translations/ko.json`

- [ ] **Step 1: Write failing HA service/options/result/identity tests**

Prove generic command payload/timeout/confirm validation, reload/refresh/reconnect routing, one domain registration for multiple entries, unload cleanup, new Advanced transport/lifecycle parsing, safe defaults, redacted diagnostics, unchanged unique IDs, and no duplicate entity for the same canonical tuple.

```py
self.assertEqual(state_unique_id(device, state), "dev_001_main_switch_switch")
self.assertEqual(result.transport, "advanced")
self.assertEqual(result.lifecycle, "CONFIRMED_BY_EVENT")
self.assertNotIn("dev_001", json.dumps(diagnostics))
```

- [ ] **Step 2: Verify RED**

Run: `python -m unittest custom_components.smartthings_web.tests.test_services custom_components.smartthings_web.tests.test_bridge_client custom_components.smartthings_web.tests.test_models custom_components.smartthings_web.tests.test_config_flow custom_components.smartthings_web.tests.test_diagnostics custom_components.smartthings_web.tests.test_init`

Expected: FAIL because services and new result/options fields are absent.

- [ ] **Step 3: Implement additive HA contracts**

Register services at integration setup, route by config entry/location/device, use `voluptuous` schemas, and unregister only when the last entry unloads. Keep entity platforms untouched. Bump config-flow version only if persisted option migration requires it; otherwise preserve version 1 and default missing options in code.

- [ ] **Step 4: Run focused and full Python tests**

Run: `python -m unittest discover -s custom_components\smartthings_web\tests -p 'test_*.py'`

Expected: PASS with the existing intentional warning lines only.

## Task 9: Diagnostics, documentation, release metadata, and complete verification

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/my-smartthings-actual-behavior.md`
- Modify: `addon/smartthings_web_bridge/CHANGELOG.md`
- Modify: `addon/smartthings_web_bridge/config.yaml`
- Modify: `custom_components/smartthings_web/manifest.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `protocol/version.json`
- Modify: `tests/documentation-gate.test.ts`
- Modify: `tests/protocol-version-contract.test.ts`
- Modify: `tests/addon-config.test.ts`
- Modify: `tools/api-free-audit.ts`
- Modify: `tests/audit-tools.test.ts`

- [ ] **Step 1: Write failing documentation/version/audit tests**

Require Korean documentation for Advanced-primary inventory, Advanced-first commands, retained `/location` keeper, compatibility, migration, fallback, security, and live-verification limits. Change the API-free audit from banning all Cupcake paths to allowing only `https://my.smartthings.com/advanced/cupcake-api/` inside the authenticated browser layer while continuing to ban `api.smartthings.com`, PAT/OAuth/webhooks, cookie replay, and external direct clients.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/documentation-gate.test.ts tests/protocol-version-contract.test.ts tests/addon-config.test.ts tests/audit-tools.test.ts`

Expected: FAIL until docs, versions, and audit policy agree.

- [ ] **Step 3: Update Korean docs, changelog, and synchronized versions**

Document verified local behavior separately from live account proof. Increment the release version once after all code behavior is stable and keep all existing synchronized version surfaces consistent.

- [ ] **Step 4: Run the complete verification matrix**

Run sequentially:

```powershell
npm test -- --reporter=dot
python -m unittest discover -s custom_components\smartthings_web\tests -p 'test_*.py'
npm run typecheck
npm run build
npm run package:addon
npm run audit:api-free
npm run audit:fixtures
npm run audit:secrets
```

Expected: every command exits 0; Vitest and Python report zero failures; no secret/API audit violations.

- [ ] **Step 5: Review final diff and record remaining live-only gaps**

Run: `git status --short`, `git diff --check`, and `git diff main...HEAD --stat`.

Confirm all required files are intentional, no capture profile/artifact was staged, and the final report explicitly labels real SmartThings command, physical-action, reconnect, reboot, and long-idle proof as unverified until a separately authorized deployment run is completed.

