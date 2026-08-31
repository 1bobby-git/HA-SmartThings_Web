# SmartThings Web Live Command and Visible Entity Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore verified Home Assistant switch/button execution, expose only executable controls, collapse the approved fireplace Cloud/Local duplicate, and prove the repaired behavior on HAOS.

**Architecture:** Keep Advanced as the primary inventory and state-enrichment source, but gate Advanced POST commands behind explicit per-command evidence and default current controls to the previously verified Web native dispatcher. Canonicalize only strong Cloud/Local duplicate pairs in the Home Assistant inventory model, carry an alias map into SSE handling, and remove registry rows that no longer correspond to executable controls.

**Tech Stack:** TypeScript, Node.js, Vitest, Python 3.11, Home Assistant custom integration APIs, unittest, SQLite-backed Bridge runtime, HAOS Supervisor/QEMU guest agent, GitHub CLI.

---

## File map

- `bridge/src/command/advanced-first-executor.ts`: evidence-gated command transport selection and redacted route diagnostics.
- `bridge/src/runtime.ts`: production policy wiring; Advanced commands start unproven while Web native remains executable.
- `bridge/tests/command/advanced-first-executor.test.ts`: transport order, double-dispatch prevention, and diagnostics regression coverage.
- `custom_components/smartthings_web/models.py`: executable switch classification, Advanced metadata, device alias state, and SSE alias application.
- `custom_components/smartthings_web/device_identity.py`: strong Cloud/Local duplicate detection and deterministic canonical merge.
- `custom_components/smartthings_web/bridge_client.py`: parse Advanced metadata and canonicalize inventory before exposing it to Home Assistant.
- `custom_components/smartthings_web/switch.py`: discover only switch states backed by exact reversible controls.
- `custom_components/smartthings_web/button.py`: discover only the canonical per-device Refresh button plus other exact buttons.
- `custom_components/smartthings_web/__init__.py`: remove stale no-control switches, noncanonical Refresh buttons, and duplicate device cards.
- `custom_components/smartthings_web/tests/test_device_identity.py`: duplicate-pair positive and collision-negative coverage.
- `custom_components/smartthings_web/tests/test_bridge_client.py`: metadata parsing and inventory alias coverage.
- `custom_components/smartthings_web/tests/test_switch.py`: one exact toggle produces one switch; state-only switches produce none.
- `custom_components/smartthings_web/tests/test_button.py`: four component Refresh controls produce one canonical button.
- `custom_components/smartthings_web/tests/test_init.py`: registry cleanup stays scoped to this config entry.
- `package.json`, `package-lock.json`, `custom_components/smartthings_web/manifest.json`, `addon/smartthings_web_bridge/config.yaml`, `addon/smartthings_web_bridge/CHANGELOG.md`: patch release `0.1.147`.
- `docs/advanced-primary-architecture-0.1.147-verification.md`, `docs/architecture.md`, `docs/my-smartthings-actual-behavior.md`: repaired routing and live-evidence record.

### Task 1: Lock command routing failure with tests

**Files:**
- Modify: `bridge/tests/command/advanced-first-executor.test.ts`
- Modify: `bridge/src/command/advanced-first-executor.ts`
- Modify: `bridge/src/runtime.ts`

- [x] **Step 1: Add failing Web-default and diagnostics tests**

Add these cases to `bridge/tests/command/advanced-first-executor.test.ts`:

```ts
test("uses the verified Web path until this exact Advanced command is proven", async () => {
  const fallback = legacy();
  const advancedTransport = advanced(async () => ({
    state: "ACCEPTED",
    transport: "advanced",
    acceptedAtMs: 10
  }));
  const executor = new AdvancedFirstCommandExecutor(advancedTransport, fallback);

  await expect(executor.executeDeviceAction(action)).resolves.toMatchObject({
    transport: "location_native"
  });
  expect(advancedTransport.execute).not.toHaveBeenCalled();
  expect(fallback.executeDeviceAction).toHaveBeenCalledOnce();
});

test("uses Advanced only when the exact command evidence policy approves it", async () => {
  const fallback = legacy();
  const advancedTransport = advanced(async () => ({
    state: "ACCEPTED",
    transport: "advanced",
    acceptedAtMs: 10,
    commandId: "command-1"
  }));
  const executor = new AdvancedFirstCommandExecutor(advancedTransport, fallback, {
    canUseAdvanced: (input) =>
      input.deviceId === "dev_001" && input.component === "identifier_main" &&
      input.capability === "identifier_switch" && input.command === "on"
  });

  await expect(executor.executeDeviceAction(action)).resolves.toMatchObject({
    transport: "advanced",
    commandId: "command-1"
  });
  expect(fallback.executeDeviceAction).not.toHaveBeenCalled();
});

test("records safe route diagnostics without identifiers", async () => {
  const diagnostics: object[] = [];
  const fallback = legacy();
  fallback.executeDeviceAction = vi.fn(async () => {
    throw new Error("command_execution_failed");
  });
  const executor = new AdvancedFirstCommandExecutor(
    advanced(async () => { throw new Error("must not run"); }),
    fallback,
    { onDiagnostic: (event) => diagnostics.push(event) }
  );

  await expect(executor.executeDeviceAction(action)).rejects.toThrow("command_execution_failed");
  expect(diagnostics).toEqual([
    { transport: "location_native", stage: "dispatch", outcome: "attempt" },
    { transport: "location_native", stage: "dispatch", outcome: "failed", code: "command_execution_failed" }
  ]);
  expect(JSON.stringify(diagnostics)).not.toContain("dev_001");
});
```

Update the pre-existing tests that intentionally exercise Advanced-first behavior to pass `canUseAdvanced: () => true`; leave the new default-Web test without that option. This keeps the Advanced adapter covered without making it production-default.

- [x] **Step 2: Run the tests and verify RED**

Run:

```powershell
npx vitest run bridge/tests/command/advanced-first-executor.test.ts --pool=threads --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL because the executor still attempts Advanced first and its options do not define `canUseAdvanced` or `onDiagnostic`.

- [x] **Step 3: Implement the minimal evidence gate**

In `bridge/src/command/advanced-first-executor.ts`, add:

```ts
export interface CommandRouteDiagnostic {
  transport: "advanced" | "location_native" | "dom";
  stage: "dispatch" | "receipt";
  outcome: "attempt" | "accepted" | "failed";
  code?: string;
}

export interface AdvancedFirstCommandExecutorOptions {
  now?: () => number;
  domFallbackEnabled?: boolean;
  canUseAdvanced?: (input: DeviceActionExecutionInput) => boolean;
  onDiagnostic?: (event: CommandRouteDiagnostic) => void;
}
```

Store the two callbacks, default `canUseAdvanced` to `() => false`, and before constructing `OrderedCommandRouter` execute the existing combined Web executor when the policy returns false:

```ts
if (!this.#canUseAdvanced(input)) {
  this.#diagnostic({ transport: "location_native", stage: "dispatch", outcome: "attempt" });
  const sentAtMs = this.#now();
  try {
    const transport = (await this.legacy.executeDeviceAction(input)) ?? "location_native";
    this.#diagnostic({ transport, stage: "receipt", outcome: "accepted" });
    return { state: "ACCEPTED", transport, sentAtMs, acceptedAtMs: this.#now() };
  } catch (error) {
    this.#diagnostic({
      transport: "location_native",
      stage: "dispatch",
      outcome: "failed",
      code: safeCommandCode(error)
    });
    throw error;
  }
}
```

Define `safeCommandCode()` to return only `/^command_[a-z0-9_]+$/` messages or `command_execution_failed`; never include request values.

In `bridge/src/runtime.ts`, pass:

```ts
{
  domFallbackEnabled: deps.config.domFallbackEnabled ?? true,
  canUseAdvanced: () => false,
  onDiagnostic: ({ transport, stage, outcome, code }) =>
    log.info(`command_route:${transport}:${stage}:${outcome}${code ? `:${code}` : ""}`)
}
```

- [x] **Step 4: Run command tests and typecheck**

Run:

```powershell
npx vitest run bridge/tests/command/advanced-first-executor.test.ts bridge/tests/command/command-router.test.ts bridge/tests/command/command-service.test.ts --pool=threads --maxWorkers=1 --no-file-parallelism
npm run typecheck
```

Expected: all selected tests pass and TypeScript reports no errors.

- [x] **Step 5: Commit Task 1**

```powershell
git add bridge/src/command/advanced-first-executor.ts bridge/src/runtime.ts bridge/tests/command/advanced-first-executor.test.ts
git commit -m "Restore commands through proven Web transport" -m "Constraint: Advanced POST remains available only after exact live evidence; ambiguous results must never trigger duplicate dispatch.
Confidence: high
Scope-risk: moderate
Directive: Do not enable Advanced commands globally without device-command push proof.
Tested: Advanced executor, router, command service tests, and typecheck.
Not-tested: HAOS physical commands."
```

### Task 2: Expose only executable switch and canonical Refresh controls

**Files:**
- Modify: `custom_components/smartthings_web/models.py`
- Modify: `custom_components/smartthings_web/switch.py`
- Modify: `custom_components/smartthings_web/button.py`
- Modify: `custom_components/smartthings_web/tests/test_models.py`
- Modify: `custom_components/smartthings_web/tests/test_switch.py`
- Modify: `custom_components/smartthings_web/tests/test_button.py`

- [x] **Step 1: Replace wrong switch expectations with failing safety tests**

In `test_switch.py`, replace the state-only creation test with:

```py
async def test_setup_omits_switch_state_without_exact_toggle(self) -> None:
    device, _state = _device(with_control=False)
    runtime = _runtime(device, object())
    entry = SimpleNamespace(runtime_data=runtime, async_on_unload=lambda _callback: None)
    added: list[SmartThingsWebSwitch] = []

    await async_setup_entry(object(), entry, added.extend)

    self.assertEqual(added, [])
```

Update `_multi_component_switch_device()` to accept one main toggle and assert:

```py
async def test_setup_exposes_only_the_component_with_an_exact_toggle(self) -> None:
    device = _multi_component_switch_device(with_main_control=True)
    runtime = _runtime(device, object())
    entry = SimpleNamespace(runtime_data=runtime, async_on_unload=lambda _callback: None)
    added: list[SmartThingsWebSwitch] = []

    await async_setup_entry(object(), entry, added.extend)

    self.assertEqual([entity.state_key[0] for entity in added], ["main"])
```

In `test_button.py`, add:

```py
async def test_component_refresh_controls_expose_one_main_button(self) -> None:
    controls = {
        f"advanced:refresh:{component}:refresh": BridgeControl(
            f"advanced:refresh:{component}:refresh", "button", "Refresh",
            component=component, capability="refresh", attribute="refresh",
            commands=("refresh",),
        )
        for component in ("switch2", "switch4", "switch3", "main")
    }
    main_state = BridgeState("main", "switch", "switch", "off", None, None, "main")
    device = BridgeDevice(
        "dev_151", "loc_001", None, "거실 간접등", "switch", True,
        states={main_state.key: main_state}, controls=controls,
    )
    runtime = self._bootstrap_runtime(device)
    added: list[SmartThingsWebButton] = []

    await async_setup_entry(object(), _FakeEntry(runtime), added.extend)

    self.assertEqual(len(added), 1)
    self.assertEqual(added[0].control.component, "main")
```

- [x] **Step 2: Verify the new tests fail**

Run:

```powershell
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_switch.py'
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_button.py'
```

Expected: the state-only and four-component fixtures create too many entities.

- [x] **Step 3: Require an exact reversible toggle in `control_kind()`**

In `models.py`, after the dangerous-domain checks in `control_kind()` add:

```py
toggle = toggle_control_for_state(device, switch_state)
if (
    toggle is None
    or not safe_observed_control(toggle)
    or not safe_generic_toggle_control(toggle)
):
    return None
```

Keep the existing light-vs-switch classification after this gate. `switch.py` then discovers only exact controls without a second policy branch.

- [x] **Step 4: Canonicalize Refresh controls**

In `models.py`, add:

```py
def canonical_refresh_control(device: BridgeDevice) -> BridgeControl | None:
    candidates = [
        control for control in device.controls.values()
        if _is_observed_refresh_control(control)
    ]
    if not candidates:
        return None
    main_components = {
        state.component for state in device.states.values()
        if (state.component_role or "").strip().lower() == "main"
    }
    return min(
        candidates,
        key=lambda control: (
            control.component not in main_components,
            control.component or "",
            control.control_id,
        ),
    )

def refresh_controls(device: BridgeDevice) -> list[BridgeControl]:
    control = canonical_refresh_control(device)
    return [] if control is None else [control]

def noncanonical_refresh_controls(device: BridgeDevice) -> list[BridgeControl]:
    canonical = canonical_refresh_control(device)
    return [
        control for control in device.controls.values()
        if _is_observed_refresh_control(control) and control != canonical
    ]

def button_controls(device: BridgeDevice) -> list[BridgeControl]:
    refresh = canonical_refresh_control(device)
    return [
        control for control in device.controls.values()
        if control.kind == "button"
        and safe_observed_control(control)
        and (not _is_observed_refresh_control(control) or control == refresh)
    ]
```

- [x] **Step 5: Run focused Python tests**

```powershell
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_switch.py'
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_button.py'
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_models.py'
```

Expected: all focused tests pass.

- [x] **Step 6: Commit Task 2**

```powershell
git add custom_components/smartthings_web/models.py custom_components/smartthings_web/switch.py custom_components/smartthings_web/button.py custom_components/smartthings_web/tests/test_models.py custom_components/smartthings_web/tests/test_switch.py custom_components/smartthings_web/tests/test_button.py
git commit -m "Expose only executable SmartThings controls" -m "Constraint: Advanced state remains observable but cannot become a Home Assistant control without an exact reversible action.
Confidence: high
Scope-risk: moderate
Directive: Keep control discovery fail-closed and one Refresh button per device.
Tested: Switch, button, and model unit tests.
Not-tested: Existing HA registry cleanup and rendered UI."
```

### Task 3: Remove stale non-executable registry rows

**Files:**
- Modify: `custom_components/smartthings_web/__init__.py`
- Modify: `custom_components/smartthings_web/tests/test_init.py`

- [x] **Step 1: Add a failing scoped migration test**

Add a `test_migration_removes_non_executable_switches_and_duplicate_refresh` fixture with one device containing four switch states, one exact main toggle, and four Refresh controls. Seed registry rows for all eight controls and assert after `_migrate_entity_registry()`:

```py
self.assertEqual(
    set(registry.removed),
    {
        "switch.geosil_ganjeobdeung_seuwici_2",
        "switch.geosil_ganjeobdeung_seuwici_3",
        "switch.geosil_ganjeobdeung_seuwici_4",
        "button.geosil_ganjeobdeung_refresh_2",
        "button.geosil_ganjeobdeung_refresh_3",
        "button.geosil_ganjeobdeung_refresh_4",
    },
)
self.assertIsNotNone(registry.async_get("switch.geosil_ganjeobdeung"))
self.assertIsNotNone(registry.async_get("button.geosil_ganjeobdeung_refresh"))
```

- [x] **Step 2: Run the exact test and verify RED**

```powershell
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_init.py'
```

Expected: the six stale rows remain because `expected_uids` currently includes every state/control.

- [x] **Step 3: Build explicit stale sets in `_migrate_entity_registry()`**

Add:

```py
stale_unobserved_switch_ids: set[str] = set()
stale_noncanonical_refresh_ids: set[str] = set()
```

For each device, collect switch state IDs whose `control_kind(device, state)` is `None`. Determine the canonical Refresh ID from `refresh_controls(device)` and add every other observed refresh control ID to the stale set. In the registry loop remove only rows from this integration/config entry:

```py
if (
    entity_entry.domain == Platform.SWITCH
    and entity_entry.unique_id in stale_unobserved_switch_ids
):
    remove_registry_entity(entity_entry.entity_id)
    continue
if (
    entity_entry.domain == Platform.BUTTON
    and entity_entry.unique_id in stale_noncanonical_refresh_ids
):
    remove_registry_entity(entity_entry.entity_id)
    continue
```

Import and use `noncanonical_refresh_controls(device)` for the stale Refresh set so registry migration uses the same allowlist logic as button discovery.

- [x] **Step 4: Run migration and platform tests**

```powershell
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_init.py'
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_switch.py'
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_button.py'
```

Expected: all pass and only the intended stale rows are removed.

- [x] **Step 5: Commit Task 3**

```powershell
git add custom_components/smartthings_web/__init__.py custom_components/smartthings_web/tests/test_init.py
git commit -m "Remove non-executable control registry rows" -m "Constraint: Cleanup is limited to this integration entry and complete ready inventory.
Confidence: high
Scope-risk: moderate
Directive: Never delete official SmartThings, manually-created, or executable canonical entities.
Tested: Registry migration, switch, and button tests.
Not-tested: Live Home Assistant registry and dashboards."
```

### Task 4: Canonicalize the approved fireplace Cloud/Local pair

**Files:**
- Create: `custom_components/smartthings_web/device_identity.py`
- Create: `custom_components/smartthings_web/tests/test_device_identity.py`
- Modify: `custom_components/smartthings_web/models.py`
- Modify: `custom_components/smartthings_web/bridge_client.py`
- Modify: `custom_components/smartthings_web/tests/test_bridge_client.py`

- [x] **Step 1: Add metadata and alias model fields**

Add to `models.py`:

```py
@dataclass(frozen=True)
class BridgeAdvancedDeviceMetadata:
    owner_id: str | None = None
    parent_device_id: str | None = None
    execution_context: str | None = None
    linked_device_ids: tuple[str, ...] = ()

@dataclass
class BridgeDevice:
    device_id: str
    location_id: str
    room_id: str | None
    name: str
    device_type: str | None
    online: bool
    presentation: BridgeDevicePresentation | None = None
    states: dict[tuple[str, str, str], BridgeState] = field(default_factory=dict)
    controls: dict[str, "BridgeControl"] = field(default_factory=dict)
    advanced: BridgeAdvancedDeviceMetadata | None = None
    health_updated_at: str | None = None

@dataclass
class BridgeInventory:
    sequence: int
    ready: bool
    bridge_version: str
    protocol_version: str
    locations: dict[str, BridgeLocation | str]
    rooms: dict[str, tuple[str, str]]
    devices: dict[str, BridgeDevice]
    scenes: dict[str, BridgeScene] = field(default_factory=dict)
    device_aliases: dict[str, str] = field(default_factory=dict)
```

At the beginning of `SmartThingsWebRuntime.handle_event()` map an aliased SSE device ID to its canonical ID before sequence and state handling:

```py
device_id = event.get("deviceId")
canonical_id = self.inventory.device_aliases.get(device_id, device_id)
if isinstance(device_id, str) and canonical_id != device_id:
    event = {**event, "deviceId": canonical_id}
```

Merge `device_aliases` in `_apply_inventory()` and keep only aliases whose canonical device still exists.

- [x] **Step 2: Write duplicate identity tests**

Create `test_device_identity.py` with helpers that build Cloud `dev_185` and Local child `dev_602`. Add:

```py
def test_merges_one_strong_cloud_local_pair_and_keeps_cloud_id(self) -> None:
    result = canonicalize_duplicate_devices({
        "dev_185": cloud_fireplace(),
        "dev_602": local_fireplace(),
    })
    self.assertEqual(set(result.devices), {"dev_185"})
    self.assertEqual(result.aliases, {"dev_602": "dev_185"})
    self.assertEqual(result.devices["dev_185"].states[SWITCH_KEY].value, "off")
    self.assertEqual(
        result.devices["dev_185"].advanced.linked_device_ids,
        ("dev_602",),
    )

def test_does_not_merge_same_name_devices_without_strong_pair_evidence(self) -> None:
    local = local_fireplace()
    local.advanced = replace(local.advanced, owner_id="identifier_other")
    result = canonicalize_duplicate_devices({"dev_185": cloud_fireplace(), "dev_602": local})
    self.assertEqual(set(result.devices), {"dev_185", "dev_602"})
    self.assertEqual(result.aliases, {})
```

Also cover a third candidate, missing parent, same execution context, weak state overlap, and conflicting unique controls; all must remain separate.

- [x] **Step 3: Verify identity tests fail before implementation**

```powershell
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_device_identity.py'
```

Expected: import failure because `device_identity.py` and metadata types do not exist.

- [x] **Step 4: Implement strong canonicalization**

Create `device_identity.py` with:

```py
@dataclass(frozen=True)
class CanonicalizedDevices:
    devices: dict[str, BridgeDevice]
    aliases: dict[str, str]

def canonicalize_duplicate_devices(
    devices: dict[str, BridgeDevice],
) -> CanonicalizedDevices:
    result = deepcopy(devices)
    aliases: dict[str, str] = {}
    groups: dict[tuple[str, str | None, str, str | None, str], list[BridgeDevice]] = {}
    for device in devices.values():
        metadata = device.advanced
        if metadata is None or not metadata.owner_id:
            continue
        key = (
            device.location_id,
            device.room_id,
            " ".join(device.name.casefold().split()),
            device.device_type,
            metadata.owner_id,
        )
        groups.setdefault(key, []).append(device)
    for candidates in groups.values():
        pair = _strong_cloud_local_pair(candidates)
        if pair is None:
            continue
        cloud, local = pair
        result[cloud.device_id] = _merge_pair(cloud, local)
        result.pop(local.device_id, None)
        aliases[local.device_id] = cloud.device_id
    return CanonicalizedDevices(result, aliases)
```

`_strong_cloud_local_pair()` must require exactly two candidates, one `CLOUD`, one `LOCAL`, a Local parent, overlapping switch plus at least three light-state attributes, and no control ID unique to the Local candidate. `_merge_pair()` deep-copies the Cloud device, chooses newer states with parsed `updated_at`, retains the Cloud controls/public ID, sets `health_updated_at` to the newer value, and records the Local alias/parent metadata.

- [x] **Step 5: Parse metadata and canonicalize inventory**

In `bridge_client.py`, parse only allowlisted Advanced fields:

```py
def _parse_advanced_metadata(raw: Any) -> BridgeAdvancedDeviceMetadata | None:
    if not isinstance(raw, dict):
        return None
    owner = raw.get("ownerId") if isinstance(raw.get("ownerId"), str) else None
    parent = raw.get("parentDeviceId") if isinstance(raw.get("parentDeviceId"), str) else None
    context = raw.get("executionContext") if raw.get("executionContext") in {"CLOUD", "LOCAL"} else None
    return BridgeAdvancedDeviceMetadata(owner, parent, context)
```

After parsing all devices:

```py
canonical = canonicalize_duplicate_devices(devices)
devices = canonical.devices
```

Pass `device_aliases=canonical.aliases` into `BridgeInventory`.

- [x] **Step 6: Run identity, client, runtime, and registry tests**

```powershell
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_device_identity.py'
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_bridge_client.py'
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_models.py'
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_init.py'
```

Expected: all pass; aliased SSE events update the canonical device and stale duplicate rows are removable.

- [x] **Step 7: Commit Task 4**

```powershell
git add custom_components/smartthings_web/device_identity.py custom_components/smartthings_web/models.py custom_components/smartthings_web/bridge_client.py custom_components/smartthings_web/tests/test_device_identity.py custom_components/smartthings_web/tests/test_bridge_client.py custom_components/smartthings_web/tests/test_models.py
git commit -m "Collapse proven Cloud and Local device mirrors" -m "Constraint: Preserve the Cloud public identifier and merge only strong same-owner Cloud/Local child pairs.
Rejected: Merge by name and room alone | it can hide distinct physical devices.
Confidence: medium
Scope-risk: moderate
Directive: Keep collision guards and alias SSE events before applying state.
Tested: Identity, bridge client, runtime model, and registry tests.
Not-tested: Live fireplace registry and UI."
```

### Task 5: Release version, documentation, and complete local verification

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `custom_components/smartthings_web/manifest.json`
- Modify: `addon/smartthings_web_bridge/config.yaml`
- Modify: `addon/smartthings_web_bridge/CHANGELOG.md`
- Modify: `docs/architecture.md`
- Modify: `docs/my-smartthings-actual-behavior.md`
- Create: `docs/advanced-primary-architecture-0.1.147-verification.md`

- [ ] **Step 1: Bump every component to `0.1.147`**

Run:

```powershell
npm version 0.1.147 --no-git-tag-version
```

Update the integration manifest and add-on config versions to `0.1.147`. Add changelog bullets for evidence-gated Web command execution, executable-only switches, canonical Refresh, scoped registry cleanup, and strong Cloud/Local canonicalization.

- [ ] **Step 2: Update architecture and verification docs**

Document that Advanced remains the data source but command execution requires per-command evidence; current unproven controls use Web native. The verification record must list local tests separately from future HAOS evidence and must not claim physical success yet.

- [ ] **Step 3: Run targeted verification**

```powershell
npx vitest run bridge/tests/command/advanced-first-executor.test.ts bridge/tests/command/command-router.test.ts bridge/tests/command/command-service.test.ts tests/addon-config.test.ts tests/protocol-version-contract.test.ts tests/documentation-gate.test.ts --pool=threads --maxWorkers=1 --no-file-parallelism
python -m unittest discover -s custom_components/smartthings_web/tests -p 'test_*.py'
npm run typecheck
```

Expected: selected Node tests, all Python tests, and typecheck pass.

- [ ] **Step 4: Run complete verification**

```powershell
npm test -- --pool=threads --maxWorkers=1 --no-file-parallelism
npm run build
npm run package:addon
npm run audit:secrets
npm run audit:api-free
npm run audit:fixtures
git diff --check
```

Expected: all 67+ Node files and 225+ Python tests pass, build/package complete, all audits pass, and no whitespace errors remain.

- [ ] **Step 5: Commit Task 5**

```powershell
git add package.json package-lock.json custom_components/smartthings_web/manifest.json addon/smartthings_web_bridge/config.yaml addon/smartthings_web_bridge/CHANGELOG.md docs/architecture.md docs/my-smartthings-actual-behavior.md docs/advanced-primary-architecture-0.1.147-verification.md
git commit -m "Prepare the verified SmartThings Web 0.1.147 repair" -m "Constraint: Separate local verification from pending HAOS physical and rendered proof.
Confidence: high
Scope-risk: moderate
Directive: Do not publish until live switch, button, push, registry, and UI gates pass.
Tested: Full Node/Python suites, typecheck, build, packaging, and audits.
Not-tested: HAOS deployment and physical devices."
```

### Task 6: Merge, release, deploy, and prove live behavior

**Files:**
- Modify after evidence: `docs/advanced-primary-architecture-0.1.147-verification.md`

- [ ] **Step 1: Review the branch before integration**

Run the required scoped cleanup and review gates. `ai-slop-cleaner` must inspect only changed files. `$code-review` must end with `APPROVE` and architect status `CLEAR`; otherwise record ultragoal review blockers and keep the Codex goal active.

- [ ] **Step 2: Merge to main and push**

From the primary checkout, merge `codex/live-command-visible-entity-repair` with a Lore-compliant merge commit. Confirm `HEAD == origin/main` after push and preserve unrelated untracked capture artifacts.

- [ ] **Step 3: Package and publish HACS `v0.1.147`**

Build integration and add-on archives from the exact main SHA, calculate SHA-256 digests, create tag `v0.1.147`, publish the GitHub release, upload both archives, and confirm it is `Latest` and targets the exact merge SHA.

- [ ] **Step 4: Back up and deploy exact artifacts to HAOS**

Back up `/mnt/data/supervisor/apps/local/smartthings_web_bridge`, `/mnt/data/supervisor/homeassistant/custom_components/smartthings_web`, and the affected Home Assistant registries. Upload the release archives through QGA, verify both archive hashes, atomically replace sources, reload the store, update the local app with a Supervisor backup, and restart Core/add-on as required.

- [ ] **Step 5: Prove runtime identity before control**

Verify app/integration version `0.1.147`, runtime package-manifest SHA, `live=true`, `ready=true`, `CONNECTED`, `architectureVersion`, and two Home Assistant SSE connections. Stop if Samsung login/MFA is required.

- [ ] **Step 6: Prove one switch action and restore its original state**

Select a benign exact-toggle entity from the live inventory. Record its original Bridge and HA state. Call Home Assistant `switch.turn_on` or `switch.turn_off`, require a newer matching Location push and HA state, then restore the original state and require the reverse push. Do not use lock, valve, door, appliance safety, or aquarium-critical targets.

- [ ] **Step 7: Prove one canonical button action**

Press one canonical device Refresh button from Home Assistant. Require an accepted result through Web native and bounded authoritative refresh evidence. Confirm no duplicate component buttons exist for that device.

- [ ] **Step 8: Prove registry and rendered UI**

Read registry counts for `dev_151`, `dev_185`, and aliased `dev_602`. Require one living-room indirect-light switch, one Refresh button, one fireplace device card, and no stale secondary switches/buttons. Open the actual Home Assistant device pages and capture rendered evidence.

- [ ] **Step 9: Record live evidence and push the final documentation commit**

Update the `0.1.147` verification record with timestamps, exact SHA/version/hash, command lifecycle/transport, before/after state, registry counts, and UI evidence paths. Re-run the documentation gate and push the evidence commit.

- [ ] **Step 10: Complete ultragoal quality gate**

Run post-cleaner verification, scoped `ai-slop-cleaner`, repeat verification, and final `$code-review`. When recommendation is `APPROVE` and architect status is `CLEAR`, call `update_goal({status: "complete"})`, save the fresh goal snapshot, checkpoint the final OMX story with the required quality-gate JSON, and confirm `omx ultragoal status` reports `8/8 complete`.
