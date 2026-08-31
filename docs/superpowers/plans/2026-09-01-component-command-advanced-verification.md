# Component Command and Advanced Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute multi-switch devices as one safe component transaction, confirm every component through Advanced status, and replace false offline availability with timestamped positive/negative evidence.

**Architecture:** DeviceStore will treat Location events and successful status reads as positive liveness evidence and will ignore undated Advanced `OFFLINE`. A dedicated Advanced component transaction executor will serialize component commands and rollback partial dispatches; SafeCommandService will use it only for multi-component switch devices with capability versions, then confirm the complete component vector from DeviceStore after Advanced status resync.

**Tech Stack:** TypeScript, Node.js, Vitest, Python unittest, Home Assistant custom integration, SmartThings Web same-origin Advanced adapter, HAOS Supervisor/QGA.

---

## File map

- `bridge/src/state/device-store.ts`: timestamped health/state precedence and successful-status liveness.
- `bridge/tests/state/device-store.test.ts`: Location event online recovery and newer-health precedence.
- `bridge/tests/state/advanced-inventory-store.test.ts`: undated Advanced offline regression.
- `bridge/src/command/component-command-executor.ts`: serialized Advanced component execution and rollback.
- `bridge/tests/command/component-command-executor.test.ts`: ordering, partial failure, rollback, and sensitive-data-free errors.
- `bridge/src/command/command-service.ts`: multi-component plan selection, vector confirmation, and rollback-on-unconfirmed.
- `bridge/tests/command/command-service.test.ts`: multi-component dispatch, status confirmation, single-component fallback, dangerous-device rejection.
- `bridge/src/command/advanced-first-executor.ts`: expose the component transaction executor through the existing command boundary.
- `bridge/src/runtime.ts`: wire Advanced component execution and mark successful status refresh as online evidence.
- `bridge/src/server/http-server.ts`, `custom_components/smartthings_web/bridge_client.py`: safe new partial-failure error mapping.
- `package.json`, `package-lock.json`, `protocol/version.json`, `addon/smartthings_web_bridge/config.yaml`, `custom_components/smartthings_web/manifest.json`: release `0.1.148`.
- `docs/advanced-primary-architecture-0.1.148-verification.md`, `README.md`, `addon/smartthings_web_bridge/CHANGELOG.md`: evidence and behavior contract.

### Task 1: Make availability follow timestamped evidence

**Files:**
- Modify: `bridge/src/state/device-store.ts`
- Modify: `bridge/tests/state/device-store.test.ts`
- Modify: `bridge/tests/state/advanced-inventory-store.test.ts`

- [x] **Step 1: Add failing liveness tests**

Add tests with these exact behaviors:

```ts
test("ignores undated Advanced OFFLINE health", () => {
  const store = new DeviceStore();
  store.observeAdvancedDeviceSnapshot({
    items: [{
      deviceId: "dev_001",
      locationId: "loc_001",
      health: { state: "OFFLINE" },
      components: []
    }]
  });

  expect(store.snapshot().devices[0]?.online).toBe(true);
});

test("a newer Location state event restores online", () => {
  const store = new DeviceStore();
  observeDeviceSnapshot(store, {
    deviceId: "dev_001", locationId: "loc_001", deviceName: "Light"
  });
  store.observe(liveHealthEvent({
    status: "OFFLINE", eventTime: "2026-09-01T00:00:00Z"
  }));
  store.observe(liveStateEvent({
    value: "on", event_time: "2026-09-01T00:01:00Z"
  }));

  expect(store.snapshot().devices[0]?.online).toBe(true);
  expect(store.snapshot().devices[0]?.healthUpdatedAt).toBe("2026-09-01T00:01:00Z");
});

test("a newer dated health OFFLINE remains authoritative", () => {
  const store = new DeviceStore();
  observeDeviceSnapshot(store, {
    deviceId: "dev_001", locationId: "loc_001", deviceName: "Light"
  });
  store.observe(liveStateEvent({
    value: "on", event_time: "2026-09-01T00:01:00Z"
  }));
  store.observe(liveHealthEvent({
    status: "OFFLINE", eventTime: "2026-09-01T00:02:00Z"
  }));

  expect(store.snapshot().devices[0]?.online).toBe(false);
});
```

Use the existing frame helpers in `device-store.test.ts`; do not add test-only production methods.

- [x] **Step 2: Verify RED**

```powershell
npx vitest run bridge/tests/state/device-store.test.ts bridge/tests/state/advanced-inventory-store.test.ts --pool=threads --maxWorkers=1 --no-file-parallelism
```

Expected: undated Advanced OFFLINE sets `online=false`, and Location state events do not restore it.

- [x] **Step 3: Apply timestamped health precedence**

In `#applyAdvancedDeviceSnapshot()` replace direct online assignment with:

```ts
const online = advancedOnlineState(row);
const healthUpdatedAt = advancedHealthUpdatedAt(row);
if (online !== undefined && (online || healthUpdatedAt !== null)) {
  changed = this.#setDeviceHealth(device, online, healthUpdatedAt) || changed;
}
```

Add:

```ts
function advancedHealthUpdatedAt(source: Record<string, unknown>): string | null {
  const health = asRecord(source.healthState ?? source.health);
  return validTimestamp(
    source.healthUpdatedAt ?? source.health_updated_at ??
    health?.updatedAt ?? health?.updated_at ?? health?.eventTime
  );
}
```

In `#applyDeviceEvent()`, after parsing the state and before publishing, call:

```ts
const livenessChanged = this.#setDeviceHealth(device, true, state.updatedAt);
```

When liveness changes, publish one inventory event before the state event so HA receives the availability change. Keep sequence numbers monotonic and persist once after both events.

- [x] **Step 4: Add successful-status liveness API**

Add a public method:

```ts
observeOnlineEvidence(deviceId: string, observedAtMs: number): void {
  const device = this.#devices.get(deviceId);
  if (!device) return;
  const updatedAt = new Date(observedAtMs).toISOString();
  if (!this.#setDeviceHealth(device, true, updatedAt)) return;
  const sequence = this.#nextSequence();
  this.#publish({ schemaVersion: 1, sequence, type: "inventory" });
  this.#schedulePersist();
}
```

`runtime.ts` must call it after `getDeviceStatus()` succeeds, before returning `CommandResyncEvidence`.

- [x] **Step 5: Verify GREEN and commit**

```powershell
npx vitest run bridge/tests/state/device-store.test.ts bridge/tests/state/advanced-inventory-store.test.ts bridge/tests/runtime.test.ts --pool=threads --maxWorkers=1 --no-file-parallelism
npm run typecheck
git add bridge/src/state/device-store.ts bridge/src/runtime.ts bridge/tests/state/device-store.test.ts bridge/tests/state/advanced-inventory-store.test.ts
git commit -m "Prefer current state evidence over stale offline health" -m "Constraint: Keep newer dated health failures authoritative while ignoring undated Advanced OFFLINE.
Confidence: high
Scope-risk: moderate
Directive: Every successful state/status observation must advance device liveness with a timestamp.
Tested: DeviceStore, Advanced inventory, runtime tests, and typecheck.
Not-tested: HAOS false-unavailable devices."
```

### Task 2: Implement serialized Advanced component transactions

**Files:**
- Create: `bridge/src/command/component-command-executor.ts`
- Create: `bridge/tests/command/component-command-executor.test.ts`
- Modify: `bridge/src/command/command-service.ts`
- Modify: `bridge/src/command/advanced-first-executor.ts`

- [x] **Step 1: Define and test the transaction contract**

Add to `command-service.ts`:

```ts
export interface ComponentActionExecutionInput {
  deviceId: string;
  component: string;
  capability: string;
  capabilityVersion: number;
  command: "on" | "off";
  arguments: BridgeJsonValue[];
}

export interface ComponentTransactionExecutionInput {
  actions: ComponentActionExecutionInput[];
  rollbackActions: ComponentActionExecutionInput[];
}
```

Extend `SafeCommandExecutor`:

```ts
executeComponentTransaction?(
  input: ComponentTransactionExecutionInput
): Promise<CommandTransportReceipt[]>;
```

Create tests:

```ts
test("executes component actions in stable order", async () => {
  const transport = fakeAdvanced();
  const executor = new ComponentCommandExecutor(transport);
  const receipts = await executor.execute(transaction("off"));
  expect(transport.execute).toHaveBeenCalledTimes(4);
  expect(transport.execute.mock.calls.map(([request]) => request.component)).toEqual([
    "main", "switch2", "switch3", "switch4"
  ]);
  expect(receipts.every((receipt) => receipt.transport === "advanced")).toBe(true);
});

test("rolls back completed components after a partial dispatch failure", async () => {
  const transport = fakeAdvanced({ failAt: 3 });
  const executor = new ComponentCommandExecutor(transport);
  await expect(executor.execute(transaction("off"))).rejects.toThrow(
    "component_command_partial_failure"
  );
  expect(lastCommands(transport)).toEqual(["off", "off", "off", "on", "on"]);
});

test("reports rollback failure without raw identifiers", async () => {
  const transport = fakeAdvanced({ failAt: 3, rollbackFails: true });
  await expect(new ComponentCommandExecutor(transport).execute(transaction("off")))
    .rejects.toThrow("component_command_rollback_failed");
});
```

- [x] **Step 2: Verify RED**

```powershell
npx vitest run bridge/tests/command/component-command-executor.test.ts --pool=threads --maxWorkers=1 --no-file-parallelism
```

Expected: module and executor interface are missing.

- [x] **Step 3: Implement minimal transaction executor**

`component-command-executor.ts`:

```ts
export class ComponentCommandExecutor {
  constructor(private readonly advanced: CommandTransport) {}

  async execute(input: ComponentTransactionExecutionInput): Promise<CommandTransportReceipt[]> {
    const receipts: CommandTransportReceipt[] = [];
    const completed: number[] = [];
    try {
      for (const [index, action] of input.actions.entries()) {
        receipts.push(await this.advanced.execute(action));
        completed.push(index);
      }
      return receipts;
    } catch {
      let rollbackFailed = false;
      for (const index of completed.reverse()) {
        try {
          await this.advanced.execute(input.rollbackActions[index]);
        } catch {
          rollbackFailed = true;
        }
      }
      throw new Error(
        rollbackFailed
          ? "component_command_rollback_failed"
          : "component_command_partial_failure"
      );
    }
  }
}
```

Map each action to `RoutedCommandRequest` without logging IDs. `AdvancedFirstCommandExecutor` owns one `ComponentCommandExecutor` and delegates `executeComponentTransaction()` to it.

- [x] **Step 4: Verify GREEN and commit**

```powershell
npx vitest run bridge/tests/command/component-command-executor.test.ts bridge/tests/command/advanced-first-executor.test.ts --pool=threads --maxWorkers=1 --no-file-parallelism
npm run typecheck
git add bridge/src/command/component-command-executor.ts bridge/src/command/advanced-first-executor.ts bridge/src/command/command-service.ts bridge/tests/command/component-command-executor.test.ts
git commit -m "Execute multi-switch components as one Advanced transaction" -m "Constraint: Serialize component commands and rollback completed components on partial failure.
Confidence: high
Scope-risk: moderate
Directive: Never retry an uncertain component transaction through another transport.
Tested: Component executor, Advanced executor tests, and typecheck.
Not-tested: Live bathroom light components."
```

### Task 3: Confirm the complete component vector in SafeCommandService

**Files:**
- Modify: `bridge/src/command/command-service.ts`
- Modify: `bridge/tests/command/command-service.test.ts`
- Modify: `bridge/src/server/http-server.ts`
- Modify: `custom_components/smartthings_web/bridge_client.py`
- Modify: `custom_components/smartthings_web/tests/test_bridge_client.py`

- [x] **Step 1: Add failing service tests**

Add tests covering:

```ts
test("uses component transaction for a multi-switch aggregate", async () => {
  const fixture = multiSwitchFixture(["main", "switch2", "switch3", "switch4"]);
  fixture.executor.executeComponentTransaction = vi.fn(async () => advancedReceipts(4));
  fixture.resync.mockImplementation(async () => {
    fixture.setAllSwitchStates("off", "COMMAND_STATUS_RECHECK");
    return { authoritativeSnapshot: false, startedAtMs: Date.now() };
  });

  const result = await fixture.service.execute(request("off"));

  expect(fixture.executor.executeDeviceAction).not.toHaveBeenCalled();
  expect(fixture.executor.executeComponentTransaction).toHaveBeenCalledOnce();
  expect(result).toMatchObject({
    status: "confirmed",
    confirmation: "inventory_snapshot",
    transport: "advanced",
    lifecycle: "CONFIRMED_BY_STATUS"
  });
});

test("rolls back when Advanced status does not confirm every component", async () => {
  const fixture = multiSwitchFixture(["main", "switch2", "switch3", "switch4"]);
  fixture.leaveComponentOn("switch4");
  await expect(fixture.service.execute(request("off"))).rejects.toThrow(
    "command_confirmation_timeout"
  );
  expect(fixture.executor.executeComponentTransaction).toHaveBeenCalledTimes(2);
});

test("keeps single-component devices on the verified Web path", async () => {
  const fixture = multiSwitchFixture(["main"]);
  await fixture.service.execute(request("off"));
  expect(fixture.executor.executeDeviceAction).toHaveBeenCalledOnce();
  expect(fixture.executor.executeComponentTransaction).not.toHaveBeenCalled();
});
```

Also test missing capability versions and dangerous device types reject component transactions.

- [x] **Step 2: Verify RED**

```powershell
npx vitest run bridge/tests/command/command-service.test.ts --pool=threads --maxWorkers=1 --no-file-parallelism
```

- [x] **Step 3: Build the component plan**

Add a helper that returns `undefined` unless:

- command is `on` or `off`
- requested state has role `main`
- at least two `switch` states exist
- every state has a non-negative capability version
- device type/control is not dangerous

Sort states by role: `main`, numeric `switchN`, then component token. Build target actions only for states that differ from the requested value. Build rollback actions from the original state vector.

- [x] **Step 4: Execute, resync, verify, and rollback**

Before normal single-state waiting, use the component plan. Execute the transaction, call `resync({ deviceId })`, then verify every component state from `devices.snapshot()`.

If every component matches, return:

```ts
confirmed(clientRequestId, sequence, "inventory_snapshot", "advanced")
```

If any component does not match, execute a second component transaction containing the original state vector, resync again, verify rollback, then throw `command_confirmation_timeout`. If rollback does not match, throw `component_command_rollback_failed`.

- [x] **Step 5: Map safe errors through HTTP and HA**

Add `component_command_partial_failure` and `component_command_rollback_failed` to `SafeCommandErrorCode`, HTTP 502 mapping, and `_SAFE_BRIDGE_ERROR_CODES`. The HA error message must expose only these fixed codes.

- [x] **Step 6: Verify and commit**

```powershell
npx vitest run bridge/tests/command/command-service.test.ts bridge/tests/server/http-server.test.ts --pool=threads --maxWorkers=1 --no-file-parallelism
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_bridge_client.py'
npm run typecheck
git add bridge/src/command/command-service.ts bridge/tests/command/command-service.test.ts bridge/src/server/http-server.ts custom_components/smartthings_web/bridge_client.py custom_components/smartthings_web/tests/test_bridge_client.py
git commit -m "Confirm aggregate switches from Advanced component status" -m "Constraint: Success requires every component value; partial or rollback failures remain explicit and non-sensitive.
Confidence: high
Scope-risk: moderate
Directive: Preserve the single-component Web path and forbid dangerous component transactions.
Tested: Command service, HTTP server, HA bridge client tests, and typecheck.
Not-tested: Live bathroom light rollback."
```

### Task 4: Release 0.1.148 and verify locally

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `protocol/version.json`
- Modify: `bridge/src/runtime.ts`
- Modify: `addon/smartthings_web_bridge/config.yaml`
- Modify: `addon/smartthings_web_bridge/CHANGELOG.md`
- Modify: `custom_components/smartthings_web/manifest.json`
- Modify: `README.md`
- Create: `docs/advanced-primary-architecture-0.1.148-verification.md`

- [x] **Step 1: Bump version surfaces**

```powershell
npm version 0.1.148 --no-git-tag-version
```

Update runtime, protocol, add-on, integration, version tests, changelog, and README to `0.1.148`.

- [x] **Step 2: Run complete local gates**

```powershell
npm test -- --pool=threads --maxWorkers=1 --no-file-parallelism
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_*.py'
npm run typecheck
npm run build
npm run package:addon
npm run audit:secrets
npm run audit:api-free
npm run audit:fixtures
git diff --check
```

- [x] **Step 3: Record candidate evidence and commit**

Record exact test counts and package manifest SHA in the verification document, clearly separating local evidence from live HAOS proof.

```powershell
git add package.json package-lock.json protocol/version.json bridge/src/runtime.ts addon/smartthings_web_bridge/config.yaml addon/smartthings_web_bridge/CHANGELOG.md custom_components/smartthings_web/manifest.json README.md docs/advanced-primary-architecture-0.1.148-verification.md tests/addon-config.test.ts tests/protocol-version-contract.test.ts
git commit -m "Prepare SmartThings Web 0.1.148 component verification" -m "Constraint: Publish only after reviewed local gates and reversible HAOS component proof.
Confidence: high
Scope-risk: moderate
Directive: Keep original component vectors for every live test and rollback.
Tested: Full local suite, build, package, and audits.
Not-tested: HAOS component transaction."
```

### Task 5: Review, merge, deploy, and prove live behavior

**Files:**
- Modify after live proof: `docs/advanced-primary-architecture-0.1.148-verification.md`

- [ ] **Step 1: Run cleaner and APPROVE/CLEAR review**

Run scoped `ai-slop-cleaner`, repeat verification, and run `$code-review`. Do not merge unless recommendation is `APPROVE` and architect status is `CLEAR`.

- [ ] **Step 2: Merge/push and publish Latest `v0.1.148`**

Merge with a Lore commit, push `main`, package from the exact merge SHA, publish integration/add-on assets, and verify release digests.

- [ ] **Step 3: Back up and deploy exact assets to HAOS**

Back up add-on source, integration source, entity/device/config registries, and the running 0.1.147 source. Deploy exact asset hashes, update the local app with Supervisor backup, restart Core, and verify runtime manifest.

- [ ] **Step 4: Verify availability recovery**

Require current Location-event devices previously marked false offline to become available. Preserve devices with a newer dated explicit health OFFLINE.

- [ ] **Step 5: Execute reversible bathroom component transaction**

Read and record the original four-component status vector. Execute the opposite aggregate state from HA. Require Advanced status for all components and matching HA representative state. Execute rollback to the original vector and verify all components again.

- [ ] **Step 6: Verify regression samples**

Run a reversible living-room indirect-light command and confirm its original state. Verify no new secondary HA switch entities appear and no official API/security boundary is crossed.

- [ ] **Step 7: Record live evidence and final review**

Update the verification document with SHA, asset/runtime hashes, component before/after/rollback vectors, availability counts, and rendered HA evidence. Push the evidence commit and repeat final cleaner, tests, and APPROVE/CLEAR review.
