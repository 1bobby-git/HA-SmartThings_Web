# Advanced Command Service and Global Web Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose every safe SmartThings Web/Advanced function through native Home Assistant entities or validated command services, with inventory-wide Web naming/icon parity and explicit omission auditing.

**Architecture:** Build a sanitized, capability-aware Advanced command catalog in the Bridge and normalize catalog-backed reversible controls alongside existing Location-native controls. Home Assistant parses the catalog, resolves HA Device Registry IDs to Bridge aliases, exposes `list_commands`, `execute_command`, and `speak`, and applies global entity naming/icon migration rules without device-ID exceptions.

**Tech Stack:** TypeScript 7, Node.js 24, Vitest, Playwright browser context, Node SQLite, Python 3.13, Home Assistant 2026.8, Python unittest, HAOS Supervisor/QGA.

---

## File Structure

New focused units:

- `bridge/src/advanced/command-catalog-types.ts`: sanitized catalog types shared by Bridge state and execution.
- `bridge/src/advanced/safe-command-policy.ts`: centralized dangerous/sensitive command filtering.
- `bridge/src/advanced/command-catalog.ts`: bounded capability-definition loading and descriptor construction.
- `bridge/tests/advanced/safe-command-policy.test.ts`: policy allow/block contracts.
- `bridge/tests/advanced/command-catalog.test.ts`: schema/catalog/cache/reversible-control contracts.
- `tools/smartthings-web-parity-audit-core.ts`: pure inventory-wide parity evaluator.
- `tools/smartthings-web-parity-audit.ts`: local/HAOS-safe audit CLI with sanitized output.
- `tests/smartthings-web-parity-audit.test.ts`: audit invariants and output redaction.

Existing units to modify:

- `bridge/src/state/device-store.ts`: persist catalog descriptors and catalog-backed controls.
- `bridge/src/command/command-service.ts`: exact catalog matching and schema-aware generic execution.
- `bridge/src/command/advanced-first-executor.ts`: explicit Advanced-only route without DOM fallback.
- `bridge/src/runtime.ts`: catalog refresh after Advanced reconciliation and exact runtime policy.
- `bridge/src/server/http-server.ts`: protected catalog read endpoint.
- `custom_components/smartthings_web/models.py`: command descriptors, control transport, and global naming helpers.
- `custom_components/smartthings_web/bridge_client.py`: catalog parsing and protected catalog fetch.
- `custom_components/smartthings_web/services.py`: Device Registry resolution and three services.
- `custom_components/smartthings_web/services.yaml`: HA action UI selectors and field descriptions.
- `custom_components/smartthings_web/const.py`: service constants.
- `custom_components/smartthings_web/switch.py`, `light.py`: Advanced reversible controls and Web labels.
- `custom_components/smartthings_web/entity.py`, `sensor.py`: generic device-type icon fallback.
- `custom_components/smartthings_web/__init__.py`: registry-wide generated-name migration.
- Existing targeted TypeScript/Python tests and release/version files.

### Task 1: Define sanitized command descriptors and the safety policy

**Files:**
- Create: `bridge/src/advanced/command-catalog-types.ts`
- Create: `bridge/src/advanced/safe-command-policy.ts`
- Create: `bridge/tests/advanced/safe-command-policy.test.ts`

- [ ] **Step 1: Write the failing safety-policy tests**

```ts
import { describe, expect, test } from "vitest";
import { safeAdvancedCommandReason } from "../../src/advanced/safe-command-policy.js";
import type { AdvancedCommandDescriptor } from "../../src/advanced/command-catalog-types.js";

const command = (capability: string, name: string, argumentName = "phrase"):
  AdvancedCommandDescriptor => ({
    component: "identifier_main",
    componentRole: "main",
    capability: `identifier_${capability}`,
    capabilityVersion: 1,
    command: name,
    arguments: [{ name: argumentName, required: true, sensitive: false, schema: { type: "string" } }],
    transport: "advanced",
    confirmation: "accepted_receipt",
    label: name,
    labelSource: "capability"
  });

describe("safe Advanced command policy", () => {
  test("allows TTS and ordinary reversible power", () => {
    expect(safeAdvancedCommandReason(command("speechSynthesis", "speak"))).toBeUndefined();
    expect(safeAdvancedCommandReason({ ...command("switch", "on"), arguments: [] })).toBeUndefined();
  });

  test.each([
    ["lock", "unlock", "access control"],
    ["valve", "open", "dangerous actuator"],
    ["ocf", "postOcfCommand", "low-level command"],
    ["samsungim.networkAudioGroupInfo", "setMasterDi", "group reconfiguration"]
  ])("blocks %s.%s", (capability, name) => {
    expect(safeAdvancedCommandReason(command(capability, name))).toBeTruthy();
  });

  test("blocks sensitive argument definitions", () => {
    expect(safeAdvancedCommandReason({
      ...command("speechSynthesis", "speak"),
      arguments: [{ name: "token", required: true, sensitive: true, schema: { type: "string" } }]
    })).toBe("sensitive_argument");
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
npx vitest run bridge/tests/advanced/safe-command-policy.test.ts --pool=threads --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL because the new modules do not exist.

- [ ] **Step 3: Implement the descriptor types and policy**

```ts
// bridge/src/advanced/command-catalog-types.ts
import type { AdvancedCapabilityArgumentDefinition } from "./types.js";

export type AdvancedCommandConfirmation = "accepted_receipt" | "state";

export interface AdvancedCommandDescriptor {
  component: string;
  componentRole?: string;
  capability: string;
  capabilityVersion: number;
  command: string;
  arguments: AdvancedCapabilityArgumentDefinition[];
  transport: "advanced";
  confirmation: AdvancedCommandConfirmation;
  label: string;
  labelSource: "visible_web" | "capability" | "role" | "fallback";
}

export interface AdvancedCommandOmission {
  component: string;
  capability: string;
  command?: string;
  reason:
    | "definition_unavailable"
    | "dangerous_command"
    | "sensitive_argument"
    | "schema_invalid";
}
```

```ts
// bridge/src/advanced/safe-command-policy.ts
import type { AdvancedCommandDescriptor } from "./command-catalog-types.js";

const BLOCKED = /(?:lock|unlock|accesscontrol|door|garage|valve|disarm|postocfcommand|networkaudiogroup|setmaster|setchannel|setrole|setgroup)/iu;

export function safeAdvancedCommandReason(
  descriptor: AdvancedCommandDescriptor
): "dangerous_command" | "sensitive_argument" | undefined {
  if (descriptor.arguments.some((argument) => argument.sensitive)) {
    return "sensitive_argument";
  }
  const identity = [
    descriptor.componentRole,
    descriptor.capability,
    descriptor.command,
    descriptor.label,
    ...descriptor.arguments.map((argument) => argument.name)
  ].filter(Boolean).join(" ").replaceAll(/[_.:\s-]+/gu, "");
  return BLOCKED.test(identity) ? "dangerous_command" : undefined;
}
```

- [ ] **Step 4: Run the policy test and typecheck**

Run:

```powershell
npx vitest run bridge/tests/advanced/safe-command-policy.test.ts --pool=threads --maxWorkers=1 --no-file-parallelism
npm run typecheck
```

Expected: policy tests PASS and typecheck exits 0.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- bridge/src/advanced/command-catalog-types.ts bridge/src/advanced/safe-command-policy.ts bridge/tests/advanced/safe-command-policy.test.ts
git commit -m "Filter Advanced commands through one safe policy" -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: safe-command-policy Vitest and typecheck."
```

### Task 2: Build and cache the Advanced command catalog

**Files:**
- Create: `bridge/src/advanced/command-catalog.ts`
- Create: `bridge/tests/advanced/command-catalog.test.ts`
- Modify: `bridge/src/state/device-store.ts`
- Modify: `bridge/tests/state/advanced-inventory-store.test.ts`

- [ ] **Step 1: Write failing catalog and capability-binding tests**

```ts
test("deduplicates capability loads and publishes typed safe commands", async () => {
  const load = vi.fn(async () => ({
    id: "speechSynthesis",
    version: 1,
    attributes: {},
    commands: {
      speak: {
        name: "speak",
        arguments: [{ name: "phrase", required: true, sensitive: false, schema: { type: "string" } }]
      }
    }
  }));
  const catalog = new AdvancedCommandCatalog(load, { concurrency: 2 });
  const bindings = [
    { deviceId: "dev_001", component: "identifier_main", componentRole: "main", capability: "identifier_speech", rawCapability: "speechSynthesis", version: 1 },
    { deviceId: "dev_002", component: "identifier_main", componentRole: "main", capability: "identifier_speech", rawCapability: "speechSynthesis", version: 1 }
  ];

  const result = await catalog.build(bindings);

  expect(load).toHaveBeenCalledOnce();
  expect(result.commandsByDevice.get("dev_001")?.[0]).toMatchObject({
    command: "speak",
    capability: "identifier_speech",
    arguments: [{ name: "phrase", schema: { type: "string" } }]
  });
});

test("DeviceStore returns capability bindings even when a capability has no state", () => {
  const store = new DeviceStore();
  store.observeAdvancedInventorySnapshot({
    devices: [{
      deviceId: "dev_001",
      locationId: "loc_001",
      components: [{
        id: "identifier_main",
        capabilities: [{ id: "identifier_speech", version: 1 }]
      }]
    }]
  });
  expect(store.capabilityBindings("dev_001")).toEqual([
    { component: "identifier_main", componentRole: "main", capability: "identifier_speech", version: 1 }
  ]);
});
```

- [ ] **Step 2: Run catalog/store tests and verify RED**

Run:

```powershell
npx vitest run bridge/tests/advanced/command-catalog.test.ts bridge/tests/state/advanced-inventory-store.test.ts --pool=threads --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL because `AdvancedCommandCatalog` and `capabilityBindings()` do not exist.

- [ ] **Step 3: Implement bounded catalog loading**

```ts
// bridge/src/advanced/command-catalog.ts
import { CapabilityDefinitionCache, type CapabilityDefinitionLoader } from "./capability-cache.js";
import type { AdvancedCommandDescriptor, AdvancedCommandOmission } from "./command-catalog-types.js";
import { safeAdvancedCommandReason } from "./safe-command-policy.js";

export interface CapabilityBinding {
  deviceId: string;
  component: string;
  componentRole?: string;
  capability: string;
  rawCapability: string;
  version: number;
}

export class AdvancedCommandCatalog {
  readonly #cache: CapabilityDefinitionCache;
  readonly #concurrency: number;

  constructor(loader: CapabilityDefinitionLoader, options: { concurrency?: number } = {}) {
    this.#cache = new CapabilityDefinitionCache(loader);
    this.#concurrency = options.concurrency ?? 4;
  }

  async build(bindings: readonly CapabilityBinding[]): Promise<{
    commandsByDevice: Map<string, AdvancedCommandDescriptor[]>;
    omissions: AdvancedCommandOmission[];
  }> {
    const commandsByDevice = new Map<string, AdvancedCommandDescriptor[]>();
    const omissions: AdvancedCommandOmission[] = [];
    await mapWithConcurrency(bindings, this.#concurrency, async (binding) => {
      try {
        const definition = await this.#cache.get(binding.rawCapability, binding.version);
        for (const command of Object.values(definition.commands)) {
          const descriptor: AdvancedCommandDescriptor = {
            component: binding.component,
            ...(binding.componentRole ? { componentRole: binding.componentRole } : {}),
            capability: binding.capability,
            capabilityVersion: binding.version,
            command: command.name,
            arguments: command.arguments,
            transport: "advanced",
            confirmation: statefulCommand(command.name) ? "state" : "accepted_receipt",
            label: command.name,
            labelSource: "capability"
          };
          const reason = safeAdvancedCommandReason(descriptor);
          if (reason) {
            omissions.push({ component: binding.component, capability: binding.capability, command: command.name, reason });
            continue;
          }
          const entries = commandsByDevice.get(binding.deviceId) ?? [];
          entries.push(descriptor);
          commandsByDevice.set(binding.deviceId, entries);
        }
      } catch {
        omissions.push({ component: binding.component, capability: binding.capability, reason: "definition_unavailable" });
      }
    });
    return { commandsByDevice, omissions };
  }
}

async function mapWithConcurrency<T>(items: readonly T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      if (item !== undefined) await run(item);
    }
  }));
}

function statefulCommand(command: string): boolean {
  return /^(?:on|off|set|open|close|mute|unmute)/u.test(command);
}
```

Add a `componentRoles` map to `MutableDevice` and populate it from each Advanced component row. Implement the following public read-only projection backed by the existing capability-version map:

```ts
capabilityBindings(deviceId: string): Array<{
  component: string;
  componentRole?: string;
  capability: string;
  version: number;
}> {
  const device = this.#devices.get(deviceId);
  if (!device) return [];
  return [...device.capabilityVersions.entries()]
    .map(([key, version]) => {
      const [component, capability] = key.split("\u0000");
      if (!component || !capability) return undefined;
      const componentRole = device.componentRoles.get(component);
      return { component, ...(componentRole ? { componentRole } : {}), capability, version };
    })
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .sort((left, right) => `${left.component}\u0000${left.capability}`.localeCompare(`${right.component}\u0000${right.capability}`));
}
```

- [ ] **Step 4: Run catalog/store tests and typecheck**

Run:

```powershell
npx vitest run bridge/tests/advanced/command-catalog.test.ts bridge/tests/state/advanced-inventory-store.test.ts --pool=threads --maxWorkers=1 --no-file-parallelism
npm run typecheck
```

Expected: tests PASS and typecheck exits 0.

- [ ] **Step 5: Commit Task 2**

```powershell
git add -- bridge/src/advanced/command-catalog.ts bridge/src/state/device-store.ts bridge/tests/advanced/command-catalog.test.ts bridge/tests/state/advanced-inventory-store.test.ts
git commit -m "Build a cached safe Advanced command catalog" -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: catalog and Advanced inventory tests plus typecheck."
```

### Task 3: Persist catalog descriptors and synthesize Advanced reversible controls

**Files:**
- Modify: `bridge/src/state/device-store.ts`
- Modify: `bridge/src/runtime.ts`
- Modify: `bridge/tests/state/device-store.test.ts`
- Modify: `bridge/tests/runtime.test.ts`

- [ ] **Step 1: Write failing persistence/projection tests**

```ts
test("projects safe Advanced on/off as one explicit Advanced toggle", () => {
  const store = new DeviceStore();
  store.observeAdvancedInventorySnapshot({
    locations: [{ locationId: "loc_001", name: "Home" }],
    rooms: [],
    devices: [{
      deviceId: "dev_001",
      locationId: "loc_001",
      deviceType: "light_bulb",
      components: [{
        id: "identifier_main",
        label: "Main",
        capabilities: [{
          id: "identifier_switch",
          version: 1,
          status: { switch: { value: "off", timestamp: "2026-09-01T00:00:00Z" } }
        }]
      }]
    }]
  });
  const descriptor = (command: "on" | "off") => ({
    component: "identifier_main",
    componentRole: "main",
    capability: "identifier_switch",
    capabilityVersion: 1,
    command,
    arguments: [],
    transport: "advanced" as const,
    confirmation: "state" as const,
    label: "Power",
    labelSource: "capability" as const
  });
  store.observeAdvancedCommandCatalog("dev_001", [
    descriptor("on"),
    descriptor("off")
  ], []);

  const device = store.snapshot().devices[0];
  expect(device?.controls).toContainEqual(expect.objectContaining({
    id: "advanced:identifier_main:identifier_switch:switch",
    kind: "toggle",
    attribute: "switch",
    commands: ["on", "off"],
    transport: "advanced"
  }));
});

test("restores catalog-backed controls after DeviceStore restart", () => {
  const root = mkdtempSync(join(tmpdir(), "stw-command-catalog-"));
  const sqlitePath = join(root, "bridge.sqlite");
  const first = new DeviceStore({ sqlitePath });
  first.observeAdvancedInventorySnapshot({
    locations: [{ locationId: "loc_001", name: "Home" }],
    rooms: [],
    devices: [{ deviceId: "dev_001", locationId: "loc_001", components: [] }]
  });
  const catalog = ["on", "off"].map((command) => ({
    component: "identifier_main",
    componentRole: "main",
    capability: "identifier_switch",
    capabilityVersion: 1,
    command,
    arguments: [],
    transport: "advanced" as const,
    confirmation: "state" as const,
    label: "Power",
    labelSource: "capability" as const
  }));
  first.observeAdvancedCommandCatalog("dev_001", catalog, []);
  first.close();
  const restored = new DeviceStore({ sqlitePath });
  expect(restored.snapshot().devices[0]?.controls?.some((control) => control.transport === "advanced")).toBe(true);
  restored.close();
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
npx vitest run bridge/tests/state/device-store.test.ts bridge/tests/runtime.test.ts --pool=threads --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL because catalog state and `transport` are absent.

- [ ] **Step 3: Extend state and runtime**

Extend `BridgeDeviceControl` with:

```ts
transport?: "location_native" | "advanced";
```

Extend mutable/persisted devices with sanitized `advancedCommands` and `commandOmissions`. Implement:

```ts
observeAdvancedCommandCatalog(
  deviceId: string,
  commands: readonly AdvancedCommandDescriptor[],
  omissions: readonly AdvancedCommandOmission[]
): void
```

The method replaces only catalog-owned descriptors/controls, preserves Location controls, and creates an Advanced toggle only when the same component/capability advertises both argument-free `on` and `off`. Runtime calls the catalog after each complete Advanced reconciliation, resolves raw capabilities through `VolatileIdentifierMap`, and merges results by alias.

- [ ] **Step 4: Run persistence/runtime tests and package typecheck**

```powershell
npx vitest run bridge/tests/state/device-store.test.ts bridge/tests/runtime.test.ts --pool=threads --maxWorkers=1 --no-file-parallelism
npm run typecheck
npm run build
```

Expected: tests PASS, typecheck/build exit 0.

- [ ] **Step 5: Commit Task 3**

```powershell
git add -- bridge/src/state/device-store.ts bridge/src/runtime.ts bridge/tests/state/device-store.test.ts bridge/tests/runtime.test.ts
git commit -m "Persist safe Advanced controls across Bridge restarts" -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: DeviceStore/runtime tests, typecheck, and build."
```

### Task 4: Route catalog commands Advanced-only and preserve existing command paths

**Files:**
- Modify: `bridge/src/command/command-service.ts`
- Modify: `bridge/src/command/advanced-first-executor.ts`
- Test: `bridge/tests/command/command-service.test.ts`
- Test: `bridge/tests/command/advanced-first-executor.test.ts`

- [ ] **Step 1: Write failing exact-route tests**

```ts
test("executes an exact catalog TTS command through Advanced only", async () => {
  const store = readyDeviceStore();
  store.observeAdvancedCommandCatalog("dev_001", [{
    component: "main",
    componentRole: "main",
    capability: "identifier_speech",
    capabilityVersion: 1,
    command: "speak",
    arguments: [{ name: "phrase", required: true, sensitive: false, schema: { type: "string" } }],
    transport: "advanced",
    confirmation: "accepted_receipt",
    label: "Speak",
    labelSource: "capability"
  }], []);
  const executeDeviceAction = vi.fn(async () => ({
    state: "ACCEPTED" as const,
    transport: "advanced" as const,
    acceptedAtMs: Date.now()
  }));
  const service = new SafeCommandService({
    devices: store,
    status: connectedStatus(),
    executor: { executeDeviceAction },
    timeoutMs: 1_000,
    resync: vi.fn(async () => undefined)
  });

  await expect(service.execute({
    targetType: "device",
    targetId: "dev_001",
    component: "main",
    capability: "identifier_speech",
    command: "speak",
    arguments: ["SmartThings Web test"],
    clientRequestId: "request_speak_001",
    confirm: false
  })).resolves.toMatchObject({ transport: "advanced", lifecycle: "ACCEPTED_UNCONFIRMED" });
  expect(executeDeviceAction).toHaveBeenCalledWith(expect.objectContaining({ requireAdvanced: true }));
});

test("never falls from an Advanced-only command to Location or DOM", async () => {
  const advancedTransport = advanced(async () => {
    throw new CommandTransportError("unsupported", "advanced");
  });
  const fallback = {
    executeDeviceAction: vi.fn(async () => "location_native" as const),
    executeLocationNative: vi.fn(async () => undefined),
    executeDomFallback: vi.fn(async () => undefined)
  };
  const executor = new AdvancedFirstCommandExecutor(advancedTransport, fallback);
  await expect(executor.executeDeviceAction({ ...action, requireAdvanced: true })).rejects.toThrow("command_control_not_found");
  expect(fallback.executeLocationNative).not.toHaveBeenCalled();
  expect(fallback.executeDomFallback).not.toHaveBeenCalled();
  expect(fallback.executeDeviceAction).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run command tests and verify RED**

```powershell
npx vitest run bridge/tests/command/command-service.test.ts bridge/tests/command/advanced-first-executor.test.ts --pool=threads --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL because catalog matching and `requireAdvanced` do not exist.

- [ ] **Step 3: Implement exact catalog matching and Advanced-only dispatch**

Change `DeviceActionExecutionInput.command` to `string` and add:

```ts
requireAdvanced?: boolean;
```

In `SafeCommandService`, resolve arbitrary commands only from the target device's exact catalog entry, validate arguments with the descriptor schema, and set `requireAdvanced: true`. Keep the current observed-control validation for native HA entity commands.

In `AdvancedFirstCommandExecutor.executeDeviceAction`:

```ts
if (input.requireLocationNative === true) return await this.#executeVerifiedWeb(input);
if (input.requireAdvanced === true) return await this.#executeAdvancedOnly(input);
if (!this.#canUseAdvanced(input)) return await this.#executeVerifiedWeb(input);
```

`#executeAdvancedOnly` invokes the Advanced transport exactly once through its existing retry policy, maps unsupported to `command_control_not_found`, and never constructs a Location/DOM router.

- [ ] **Step 4: Run all command tests and typecheck**

```powershell
npx vitest run bridge/tests/command --pool=threads --maxWorkers=1 --no-file-parallelism
npm run typecheck
```

Expected: command suite PASS; existing bathroom composite and native controls remain green.

- [ ] **Step 5: Commit Task 4**

```powershell
git add -- bridge/src/command/command-service.ts bridge/src/command/advanced-first-executor.ts bridge/tests/command/command-service.test.ts bridge/tests/command/advanced-first-executor.test.ts
git commit -m "Route catalog commands through Advanced without fallback" -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: full Bridge command suite and typecheck."
```

### Task 5: Expose the catalog to Home Assistant models and client

**Files:**
- Modify: `bridge/src/server/http-server.ts`
- Modify: `bridge/tests/server/http-server.test.ts`
- Modify: `custom_components/smartthings_web/models.py`
- Modify: `custom_components/smartthings_web/bridge_client.py`
- Test: `custom_components/smartthings_web/tests/test_models.py`
- Test: `custom_components/smartthings_web/tests/test_bridge_client.py`

- [ ] **Step 1: Write failing API/parser tests**

```python
def test_parse_catalog_descriptor_and_advanced_control() -> None:
    inventory = parse_inventory({
        "schemaVersion": 1,
        "ready": True,
        "bridgeVersion": "0.1.154",
        "protocolVersion": "5:test",
        "locations": [{"id": "loc_001", "name": "Home"}],
        "rooms": [],
        "scenes": [],
        "devices": [{
            "id": "dev_204",
            "locationId": "loc_001",
            "roomId": None,
            "name": "Galaxy Home Mini",
            "type": "ai_speaker_lux_one",
            "online": True,
            "states": [],
            "commands": [{
                "component": "identifier_main",
                "componentRole": "main",
                "capability": "identifier_speech",
                "capabilityVersion": 1,
                "command": "speak",
                "arguments": [{"name": "phrase", "required": True, "sensitive": False, "schema": {"type": "string"}}],
                "transport": "advanced",
                "confirmation": "accepted_receipt",
                "label": "Speak",
                "labelSource": "capability",
            }],
            "controls": [{
                "id": "advanced:main:switch:switch",
                "kind": "toggle",
                "label": "Power",
                "component": "main",
                "capability": "switch",
                "attribute": "switch",
                "commands": ["on", "off"],
                "transport": "advanced",
            }],
        }],
    })
    device = inventory.devices["dev_204"]
    assert device.commands[0].command == "speak"
    assert device.commands[0].arguments[0].name == "phrase"
    assert device.controls["advanced:main:switch:switch"].transport == "advanced"

async def test_catalog_endpoint_requires_auth_and_filters_one_device(self) -> None:
    client = SmartThingsWebBridgeClient(object(), "http://bridge.local", "x" * 32)
    client._request_json = AsyncMock(return_value={"commands": [], "omissions": {}})
    response = await client.async_list_commands("dev_204")
    self.assertEqual(response, {"commands": [], "omissions": {}})
    client._request_json.assert_awaited_once_with(
        "GET", "/api/v1/commands/catalog?deviceId=dev_204", auth=True
    )
```

- [ ] **Step 2: Run tests and verify RED**

```powershell
npx vitest run bridge/tests/server/http-server.test.ts --pool=threads --maxWorkers=1 --no-file-parallelism
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_bridge_client.py'
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_models.py'
```

Expected: FAIL because catalog API/models are absent.

- [ ] **Step 3: Add protected API and Python dataclasses**

Add `GET /api/v1/commands/catalog?deviceId=dev_N` after authentication. It returns only the selected device's catalog and omission counts.

Add Python dataclasses:

```python
@dataclass(frozen=True)
class BridgeCommandArgument:
    name: str
    required: bool
    sensitive: bool
    schema: dict[str, Any]
    unit: str | None = None

@dataclass(frozen=True)
class BridgeCommandDescriptor:
    component: str
    component_role: str | None
    capability: str
    capability_version: int
    command: str
    arguments: tuple[BridgeCommandArgument, ...]
    transport: str
    confirmation: str
    label: str
    label_source: str
```

Extend `BridgeDevice` with `commands`, and `BridgeControl` with `transport`. Parse only bounded aliases/tokens and supported schema keys.

- [ ] **Step 4: Run API/parser tests**

Run the commands from Step 2 plus `npm run typecheck`. Expected: all PASS.

- [ ] **Step 5: Commit Task 5**

```powershell
git add -- bridge/src/server/http-server.ts bridge/tests/server/http-server.test.ts custom_components/smartthings_web/models.py custom_components/smartthings_web/bridge_client.py custom_components/smartthings_web/tests/test_models.py custom_components/smartthings_web/tests/test_bridge_client.py
git commit -m "Expose sanitized command catalogs to Home Assistant" -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: HTTP server, Bridge client, model tests, and typecheck."
```

### Task 6: Implement list, execute, and speak services

**Files:**
- Modify: `custom_components/smartthings_web/const.py`
- Modify: `custom_components/smartthings_web/services.py`
- Modify: `custom_components/smartthings_web/services.yaml`
- Test: `custom_components/smartthings_web/tests/test_services.py`

- [ ] **Step 1: Write failing service tests**

```python
import smartthings_web.services as services_module
from unittest.mock import AsyncMock, patch

async def test_speak_resolves_ha_device_id_and_forwards_exact_descriptor(self) -> None:
    client = SimpleNamespace(async_execute_command=AsyncMock())
    descriptor = SimpleNamespace(
        component="identifier_main",
        capability="identifier_speech",
        command="speak",
        arguments=(SimpleNamespace(name="phrase", required=True, sensitive=False, schema={"type": "string"}),),
    )
    galaxy = SimpleNamespace(commands=(descriptor,))
    runtime = SimpleNamespace(
        client=client,
        inventory=SimpleNamespace(devices={"dev_204": galaxy}),
    )
    hass = SimpleNamespace(
        config_entries=SimpleNamespace(
            async_entries=lambda _domain: [SimpleNamespace(runtime_data=runtime)]
        )
    )

    await async_handle_speak(
        hass,
        SimpleNamespace(data={"device_id": "dev_204", "phrase": "안녕하세요"}),
    )

    client.async_execute_command.assert_awaited_once_with(
        target_type="device",
        target_id="dev_204",
        component="identifier_main",
        capability="identifier_speech",
        command="speak",
        arguments=["안녕하세요"],
        confirm=False,
        timeout=30,
    )

async def test_list_commands_returns_safe_schema_only(self) -> None:
    descriptor = SimpleNamespace(
        component="identifier_main",
        capability="identifier_speech",
        command="speak",
        arguments=(SimpleNamespace(name="phrase", required=True, sensitive=False, schema={"type": "string"}),),
    )
    runtime = SimpleNamespace(
        client=SimpleNamespace(),
        inventory=SimpleNamespace(devices={"dev_204": SimpleNamespace(commands=(descriptor,))}),
    )
    hass = SimpleNamespace(
        config_entries=SimpleNamespace(
            async_entries=lambda _domain: [SimpleNamespace(runtime_data=runtime)]
        )
    )
    result = await async_handle_list_commands(
        hass, SimpleNamespace(data={"device_id": "dev_204"})
    )
    assert result["commands"][0]["arguments"][0]["name"] == "phrase"

def test_speak_rejects_control_characters_and_oversize_text(self) -> None:
    with self.assertRaises(vol.Invalid):
        SPEAK_SCHEMA({"device_id": "ha_device_1", "phrase": "bad\x00text"})

def test_device_registry_id_resolves_to_one_bridge_alias(self) -> None:
    registry = SimpleNamespace(
        async_get=lambda device_id: SimpleNamespace(
            id=device_id,
            identifiers={("smartthings_web", "dev_204")},
        )
    )
    with patch.object(services_module.dr, "async_get", return_value=registry):
        self.assertEqual(_bridge_alias_for_device(SimpleNamespace(), "ha_device_1"), "dev_204")
```

- [ ] **Step 2: Run service tests and verify RED**

```powershell
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_services.py'
```

Expected: FAIL because the new services and Device Registry resolver are absent.

- [ ] **Step 3: Implement service handlers and UI definitions**

Add constants `SERVICE_LIST_COMMANDS` and `SERVICE_SPEAK`. Implement `_bridge_alias_for_device(hass, value)` that accepts `dev_N` or resolves exactly one `(DOMAIN, dev_N)` identifier from the HA Device Registry.

Register `list_commands` with response support, `execute_command` with the existing generic body plus HA device IDs, and `speak` with:

```python
SPEAK_SCHEMA = vol.Schema({
    vol.Required("device_id"): str,
    vol.Required("phrase"): vol.All(
        str,
        vol.Length(min=1, max=1024),
        lambda value: value if not any(ord(char) < 32 for char in value) else vol.Invalid("phrase"),
    ),
})
```

`async_handle_speak` requires exactly one `speechSynthesis.speak` descriptor with one string `phrase` argument and calls `async_execute_command(..., confirm=False)`.

Update `services.yaml` to use a device selector restricted to `smartthings_web` and an object selector for ordered arguments.

- [ ] **Step 4: Run service and complete Python tests**

```powershell
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_services.py'
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_*.py'
```

Expected: all Python tests PASS.

- [ ] **Step 5: Commit Task 6**

```powershell
git add -- custom_components/smartthings_web/const.py custom_components/smartthings_web/services.py custom_components/smartthings_web/services.yaml custom_components/smartthings_web/tests/test_services.py
git commit -m "Add capability-aware command and speech services" -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: services tests and full Python suite."
```

### Task 7: Project Advanced toggles into switch/light entities globally

**Files:**
- Modify: `custom_components/smartthings_web/models.py`
- Modify: `custom_components/smartthings_web/switch.py`
- Modify: `custom_components/smartthings_web/light.py`
- Test: `custom_components/smartthings_web/tests/test_models.py`
- Test: `custom_components/smartthings_web/tests/test_switch.py`
- Test: `custom_components/smartthings_web/tests/test_light.py`

- [ ] **Step 1: Write failing projection tests**

```python
def test_advanced_reversible_switch_is_a_light_with_light_state_evidence() -> None:
    switch = BridgeState("main", "switch", "switch", "off", None, "2026-09-01T00:00:00Z")
    level = BridgeState("main", "switchLevel", "level", 40, "%", "2026-09-01T00:00:00Z")
    control = BridgeControl(
        "advanced:main:switch:switch",
        "toggle",
        "Power",
        component="main",
        capability="switch",
        attribute="switch",
        commands=("on", "off"),
        transport="advanced",
    )
    device = BridgeDevice(
        "dev_light",
        "loc_001",
        None,
        "Mood Light",
        "light_bulb",
        True,
        states={switch.key: switch, level.key: level},
        controls={control.control_id: control},
    )
    switch = next(state for state in device.states.values() if state.attribute == "switch")
    assert control_kind(device, switch) == "light"

async def test_advanced_light_forwards_advanced_control_identity(self) -> None:
    switch_state = BridgeState("main", "switch", "switch", "off", None, "2026-09-01T00:00:00Z")
    control = BridgeControl(
        "advanced:main:switch:switch",
        "toggle",
        "Power",
        component="main",
        capability="switch",
        attribute="switch",
        commands=("on", "off"),
        transport="advanced",
    )
    device = BridgeDevice(
        "dev_light", "loc_001", None, "Mood Light", "light_bulb", True,
        states={switch_state.key: switch_state},
        controls={control.control_id: control},
    )
    client = SimpleNamespace(async_execute_command=AsyncMock())
    runtime = SimpleNamespace(
        client=client,
        inventory=SimpleNamespace(devices={device.device_id: device}),
    )
    light = SmartThingsWebLight(runtime, device, switch_state)
    await light.async_turn_on()
    client.async_execute_command.assert_awaited_once_with(
        target_type="device",
        target_id=device.device_id,
        component=switch_state.component,
        capability=switch_state.capability,
        attribute="switch",
        control_id="advanced:identifier_main:identifier_switch:switch",
        control_label="Power",
        command="on",
        arguments=[],
    )
```

- [ ] **Step 2: Run model/switch/light tests and verify RED**

```powershell
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_models.py'
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_switch.py'
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_light.py'
```

Expected: FAIL until `transport=advanced` controls are parsed and accepted.

- [ ] **Step 3: Implement transport-aware native entity projection**

Keep exact component/capability/attribute matching. Permit an Advanced toggle only when its catalog-owned ID advertises both `on` and `off`, its transport is `advanced`, and it passed the Bridge safety policy. Do not relax `safe_observed_control` for arbitrary controls.

Switch/light command code continues passing the exact control ID; the Bridge determines the transport from the catalog-owned control.

- [ ] **Step 4: Run all entity tests**

```powershell
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_models.py'
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_switch.py'
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_light.py'
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_media_player.py'
```

Expected: all PASS; media ownership remains unchanged.

- [ ] **Step 5: Commit Task 7**

```powershell
git add -- custom_components/smartthings_web/models.py custom_components/smartthings_web/switch.py custom_components/smartthings_web/light.py custom_components/smartthings_web/tests/test_models.py custom_components/smartthings_web/tests/test_switch.py custom_components/smartthings_web/tests/test_light.py
git commit -m "Project safe Advanced power into native HA controls" -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: model, switch, light, and media-player tests."
```

### Task 8: Apply Web labels and device icons inventory-wide

**Files:**
- Modify: `custom_components/smartthings_web/models.py`
- Modify: `custom_components/smartthings_web/switch.py`
- Modify: `custom_components/smartthings_web/entity.py`
- Modify: `custom_components/smartthings_web/sensor.py`
- Modify: `custom_components/smartthings_web/__init__.py`
- Test: `custom_components/smartthings_web/tests/test_models.py`
- Test: `custom_components/smartthings_web/tests/test_switch.py`
- Test: `custom_components/smartthings_web/tests/test_entity.py`
- Test: `custom_components/smartthings_web/tests/test_sensor.py`
- Test: `custom_components/smartthings_web/tests/test_init.py`

- [ ] **Step 1: Write failing global naming/icon tests**

```python
def test_same_component_switches_use_distinct_web_labels() -> None:
    first = BridgeState("main", "switch", "switch", "off", None, "2026-09-01T00:00:00Z")
    second = BridgeState("main", "yjswitchstatus", "switch", "off", None, "2026-09-01T00:00:00Z")
    controls = (
        BridgeControl("power", "toggle", "Power", component="main", capability="switch", attribute="switch", commands=("on", "off")),
        BridgeControl("status", "toggle", "yjswitchstatus", component="main", capability="yjswitchstatus", attribute="switch", commands=("on", "off")),
    )
    device = BridgeDevice(
        "dev_outlet", "loc_001", None, "멀티탭", "outlet_1", True,
        states={first.key: first, second.key: second},
        controls={control.control_id: control for control in controls},
    )
    assert switch_name_overrides(device) == {
        first.key: "전원",
        second.key: "장치 상태",
    }

def test_generic_refrigerator_sensor_gets_device_icon() -> None:
    generic_state = BridgeState("main", "custom", "status", "normal", None, "2026-09-01T00:00:00Z")
    refrigerator = BridgeDevice(
        "dev_fridge", "loc_001", None, "냉장고", "refrigerator", True,
        states={generic_state.key: generic_state},
    )
    runtime = SimpleNamespace(inventory=SimpleNamespace(devices={"dev_fridge": refrigerator}))
    generic_description = SensorDescription("Status", state_class=None)
    sensor = SmartThingsWebSensor(runtime, refrigerator, generic_state, generic_description)
    assert sensor.icon == "mdi:fridge"

def test_temperature_sensor_keeps_functional_device_class_icon() -> None:
    temperature_state = BridgeState("main", "temperature", "temperature", 3.0, "C", "2026-09-01T00:00:00Z")
    refrigerator = BridgeDevice(
        "dev_fridge", "loc_001", None, "냉장고", "refrigerator", True,
        states={temperature_state.key: temperature_state},
    )
    runtime = SimpleNamespace(inventory=SimpleNamespace(devices={"dev_fridge": refrigerator}))
    sensor = SmartThingsWebSensor(runtime, refrigerator, temperature_state, SENSOR_STATES["temperature"])
    assert sensor.device_class == SensorDeviceClass.TEMPERATURE
    assert sensor.__dict__.get("_attr_icon") is None

def test_registry_migration_updates_original_name_without_entity_id_or_user_name(self) -> None:
    first = BridgeState("main", "switch", "switch", "off", None, "2026-09-01T00:00:00Z")
    control = BridgeControl("power", "toggle", "Power", component="main", capability="switch", attribute="switch", commands=("on", "off"))
    device = BridgeDevice(
        "dev_outlet", "loc_001", None, "멀티탭", "outlet_1", True,
        states={first.key: first}, controls={control.control_id: control},
    )
    before = SimpleNamespace(
        entity_id="switch.meoltitaeb",
        domain="switch",
        platform=DOMAIN,
        unique_id="dev_outlet_main_switch_switch",
        device_id="ha_device_outlet",
        name="내 전원",
        original_name=None,
        disabled_by=None,
    )
    registry = FakeRegistry([before])
    self.patch_registry(registry)
    _migrate_entity_registry(
        object(),
        SimpleNamespace(entry_id="entry_001", data={CONF_LOCATION_ID: "loc_001"}),
        BridgeInventory(
            sequence=1, ready=True, bridge_version="0.1.154", protocol_version="5:test",
            locations={"loc_001": "Home"}, rooms={}, devices={"dev_outlet": device},
        ),
    )
    after = registry.async_get("switch.meoltitaeb")
    assert after.entity_id == "switch.meoltitaeb"
    assert after.name == "내 전원"
    assert after.original_name == "전원"
```

- [ ] **Step 2: Run naming/icon/migration tests and verify RED**

```powershell
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_switch.py'
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_entity.py'
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_sensor.py'
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_init.py'
```

Expected: tests fail on duplicate switch names and absent refrigerator icon.

- [ ] **Step 3: Implement global label and icon rules**

Replace `secondary_switch_name_overrides()` with `switch_name_overrides()` that groups all safe switch states, including same-component/different-capability states. Use this label priority:

```python
WEB_CONTROL_LABELS_KO = {
    "power": "전원",
    "yjswitchstatus": "장치 상태",
    "device status": "장치 상태",
}
```

Then prefer visible label, localized known Web label, component role, and deterministic fallback. Apply overrides during discovery and registry migration.

Expose `device_icon_for(device)` from `entity.py`. In `SmartThingsWebSensor.__init__`, set `_attr_icon` only when `description.device_class is None`; leave functional device-class sensors untouched.

Extend the `test_init.py` `FakeRegistry.async_update_entity` stub so registry-name migrations are exercised through the real method shape:

```python
def async_update_entity(
    self,
    entity_id: str,
    *,
    new_unique_id: str | None = None,
    new_entity_id: str | None = None,
    original_name: str | None = None,
) -> None:
    entry = self.async_get(entity_id)
    if entry is None:
        raise KeyError(entity_id)
    if new_unique_id is not None:
        entry.unique_id = new_unique_id
    if new_entity_id is not None:
        entry.entity_id = new_entity_id
    if original_name is not None:
        entry.original_name = original_name
```

- [ ] **Step 4: Run naming/icon/migration and full Python tests**

Run the Step 2 commands followed by full Python discovery. Expected: all PASS.

- [ ] **Step 5: Commit Task 8**

```powershell
git add -- custom_components/smartthings_web/models.py custom_components/smartthings_web/switch.py custom_components/smartthings_web/entity.py custom_components/smartthings_web/sensor.py custom_components/smartthings_web/__init__.py custom_components/smartthings_web/tests/test_models.py custom_components/smartthings_web/tests/test_switch.py custom_components/smartthings_web/tests/test_entity.py custom_components/smartthings_web/tests/test_sensor.py custom_components/smartthings_web/tests/test_init.py
git commit -m "Apply Web labels and device icons across all devices" -m "Confidence: high" -m "Scope-risk: broad" -m "Tested: naming, icon, registry, and full Python tests."
```

### Task 9: Add the inventory-wide parity audit

**Files:**
- Create: `tools/smartthings-web-parity-audit-core.ts`
- Create: `tools/smartthings-web-parity-audit.ts`
- Create: `tests/smartthings-web-parity-audit.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing audit tests**

```ts
test("reports every safe omission and zero dangerous exposure", () => {
  const inventory = {
    devices: [{
      id: "dev_003",
      controls: [],
      advancedCommands: [],
      commandOmissions: [{ capability: "identifier_missing", reason: "definition_unavailable" }]
    }]
  };
  const projection = [{
    deviceId: "dev_003",
    entityId: "sensor.device_status",
    uniqueId: "dev_003_main_status_status",
    domain: "sensor",
    originalName: "Status",
    userNamed: false
  }];
  const report = evaluateWebParity(inventory, projection);
  expect(report.summary.dangerousCommandsExposed).toBe(0);
  expect(report.summary.duplicateUniqueIds).toBe(0);
  expect(report.omissions).toEqual([
    expect.objectContaining({ deviceId: "dev_003", reason: "definition_unavailable" })
  ]);
});

test("serialized report contains aliases and counts but no raw IDs or secrets", () => {
  const json = JSON.stringify(evaluateWebParity(
    { devices: [{ id: "dev_001", controls: [], advancedCommands: [], commandOmissions: [] }] },
    [{ deviceId: "dev_001", entityId: "sensor.safe", uniqueId: "dev_001_main_safe_value", domain: "sensor", originalName: "Safe", userNamed: false }]
  ));
  expect(json).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27}/iu);
  expect(json).not.toMatch(/cookie|authorization|token|phrase/iu);
});
```

- [ ] **Step 2: Run the audit test and verify RED**

```powershell
npx vitest run tests/smartthings-web-parity-audit.test.ts --pool=threads --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL because audit modules do not exist.

- [ ] **Step 3: Implement the pure evaluator and CLI**

The evaluator returns:

```ts
interface WebParityReport {
  schemaVersion: 1;
  summary: {
    devices: number;
    safeCommands: number;
    locationControls: number;
    advancedControls: number;
    projectedEntities: number;
    omissions: number;
    dangerousCommandsExposed: number;
    duplicateUniqueIds: number;
    duplicateGeneratedNames: number;
  };
  omissions: Array<{ deviceId: string; component?: string; capability?: string; command?: string; reason: string }>;
}
```

The CLI accepts a Bridge inventory/catalog payload and a sanitized HA entity projection shaped as `{deviceId, entityId, uniqueId, domain, originalName, userNamed}[]`. It can fetch the local Bridge using the existing private-file/environment token mechanism or read both inputs from explicit local JSON files. It prints one JSON report and exits nonzero when dangerous exposure, duplicate unique IDs, duplicate generated names, or unexplained omissions are present. Add package script `audit:web-parity`.

- [ ] **Step 4: Run audit tests and all static audits**

```powershell
npx vitest run tests/smartthings-web-parity-audit.test.ts --pool=threads --maxWorkers=1 --no-file-parallelism
npm run audit:secrets
npm run audit:api-free
npm run audit:fixtures
```

Expected: all PASS.

- [ ] **Step 5: Commit Task 9**

```powershell
git add -- tools/smartthings-web-parity-audit-core.ts tools/smartthings-web-parity-audit.ts tests/smartthings-web-parity-audit.test.ts package.json
git commit -m "Audit Web command and entity parity across inventory" -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: parity audit test and all static audits."
```

### Task 10: Final verification, release, HAOS deployment, and live proof

**Files:**
- Modify: `README.md`
- Modify: `addon/smartthings_web_bridge/CHANGELOG.md`
- Modify: `addon/smartthings_web_bridge/config.yaml`
- Modify: `bridge/src/runtime.ts`
- Modify: `bridge/src/inspector/protocol-contract.ts`
- Modify: `bridge/tests/inspector/protocol-analyzer.test.ts`
- Modify: `custom_components/smartthings_web/manifest.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `protocol/version.json`
- Modify: `tests/addon-config.test.ts`
- Modify: `tests/protocol-version-contract.test.ts`
- Create: `docs/advanced-command-service-global-parity-0.1.154-verification.md`

- [ ] **Step 1: Run complete pre-release verification**

```powershell
npm test
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_*.py'
npm run typecheck
npm run build
npm run package:addon
npm run audit:secrets
npm run audit:api-free
npm run audit:fixtures
git diff --check
```

Expected: every command exits 0. Record exact test counts and package-manifest SHA-256.

- [ ] **Step 2: Run cleanup and independent reviews**

Apply the scoped AI-slop cleanup to modified files without changing behavior. Request independent code and architecture review covering catalog safety, Advanced-only routing, global registry migration, API isolation, and audit completeness. Resolve every blocker and rerun targeted/full gates.

- [ ] **Step 3: Bump and lock version 0.1.154**

Update all listed version surfaces to `0.1.154`. Changelog and README must state:

- global safe command catalog and services
- Advanced-only reversible control projection
- global Web-label naming migration
- generic device-type icon fallback
- inventory-wide parity audit
- dangerous-command exclusions and no official API/DOM-state authority

Lock the machine-readable surfaces exactly:

```json
// package.json, package-lock.json, integration manifest
"version": "0.1.154"
```

```json
// protocol/version.json
{"bridge_version":"0.1.154","protocol_version":5}
```

```yaml
# addon/smartthings_web_bridge/config.yaml
version: 0.1.154
```

```ts
// bridge/src/runtime.ts
const bridgeVersion = "0.1.154";
```

```ts
// bridge/src/inspector/protocol-contract.ts
export const PROTOCOL_CONTRACT_VERSION = 5;
```

Update `tests/addon-config.test.ts`, `tests/protocol-version-contract.test.ts`, and `bridge/tests/inspector/protocol-analyzer.test.ts` to require protocol version 5.

Update version tests and create the verification document with local evidence.

- [ ] **Step 4: Commit, push, and publish exact release assets**

Use explicit allowlists and Lore commits. Push `main`, verify remote SHA, build add-on/integration archives from the exact release commit, verify SHA-256, publish `v0.1.154` as latest, and read back release target/assets.

- [ ] **Step 5: Back up and deploy to HAOS**

Create a pre-0.1.154 backup outside Supervisor scan paths containing add-on source, integration source, Bridge SQLite, config entries, device registry, and entity registry. Upload assets through QGA, verify hashes, atomically replace sources, reload/update/start the add-on, run `ha core check`, restart Core, and wait for external root/API 200/401 plus Bridge `CONNECTED`/ready.

- [ ] **Step 6: Run live acceptance probes**

Run only safe reversible probes:

1. `smartthings_web.list_commands` for Galaxy Home Mini includes exact `speechSynthesis.speak` with required string `phrase`.
2. `smartthings_web.speak` sends `SmartThings Web 테스트입니다`; confirm valid Advanced accepted receipt and physical audible output where observable.
3. Rattan light and Mood Light initial states are recorded, then on/off is exercised and restored to the original state with push/status confirmation.
4. Multi-outlet keeps both entity IDs; generated names read `전원` and `장치 상태`; each channel is toggled and restored independently.
5. Refrigerator generic sensors expose `mdi:fridge`; temperature/contact device-class icons remain functional.
6. Generate the HA projection with a read-only Home Assistant registry script, feed it with the live Bridge catalog to `audit:web-parity`, and require zero dangerous exposure, duplicate unique IDs, duplicate generated names, and unexplained safe omissions.
7. Recheck bathroom composite on/off, `dev_324` liveness, explicit offline devices, SSE freshness, and no new foreign-owned registry mutation.

- [ ] **Step 7: Record final evidence and clean staging**

Update the verification document with release SHA, asset/package hashes, backup path/hashes, service results, final restored device states, audit counts, Core start time, and Bridge health. Commit/push the evidence document. Resolve and remove only exact temporary HAOS staging paths after verifying they are under `/mnt/data/supervisor/tmp`.

## Spec Coverage

| Approved requirement | Implemented by |
| --- | --- |
| Sanitized global Advanced catalog and safety exclusions | Tasks 1-3 |
| Exact Advanced-only execution without DOM/native fallback | Task 4 |
| Catalog transport to HA and three services | Tasks 5-6 |
| Missing safe switch/light projection for all devices | Tasks 3 and 7 |
| Global Web labels and registry-safe migration | Task 8 |
| Generic device-type icons with device-class preservation | Task 8 |
| Inventory-wide parity/omission audit | Task 9 |
| Full tests, reviews, release, HAOS restart, real-device proof | Task 10 |
| Official-API/secret/dangerous-command boundaries | Tasks 1, 4, 9, and 10 |

No approved spec requirement is left without an implementation or verification task.

## Plan Author Self-review

- [x] Every approved spec requirement maps to a task above.
- [x] Placeholder and vague-step scans are clean.
- [x] Type and method names are consistent across catalog, inventory, client, service, entity, and audit tasks.
- [x] Every production-code task starts with a failing test and includes the exact RED/GREEN command.

## Execution Completion Checklist

- [ ] No device registry IDs, raw SmartThings IDs, secrets, phrases, or dangerous commands are persisted in fixtures or output.
- [ ] Existing user capture/profile files remain unstaged and unmodified.
- [ ] Final completion includes release and live HAOS proof, not local tests alone.
