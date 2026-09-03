from __future__ import annotations

from pathlib import Path

ROOT = Path.cwd()


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, value: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(value, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    value = read(path)
    count = value.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:140]!r}")
    write(path, value.replace(old, new, 1))


def replace_in_section(
    path: str,
    start_marker: str,
    end_marker: str,
    old: str,
    new: str,
) -> None:
    value = read(path)
    start = value.find(start_marker)
    if start < 0:
        raise SystemExit(f"{path}: section start not found: {start_marker!r}")
    end = value.find(end_marker, start + len(start_marker))
    if end < 0:
        raise SystemExit(f"{path}: section end not found: {end_marker!r}")
    section = value[start:end]
    count = section.count(old)
    if count != 1:
        raise SystemExit(
            f"{path}: expected one section match, found {count}: {old[:140]!r}"
        )
    write(path, value[:start] + section.replace(old, new, 1) + value[end:])


# DeviceStore must keep newer equal-value events for command confirmation. Reduce
# durable writes without suppressing the event stream used by SafeCommandService.
path = "bridge/src/state/device-store.ts"
replace_once(
    path,
    "  #setDeviceHealth(device: MutableDevice, online: boolean, updatedAt: string | null): boolean {\n"
    "    if (isOlderOrUndated(updatedAt, device.healthUpdatedAt)) {\n"
    "      return false;\n"
    "    }\n"
    "    if (device.online === online) {\n"
    "      // Keep ordering evidence in memory without publishing or persisting a\n"
    "      // status that did not semantically change.\n"
    "      device.healthUpdatedAt = updatedAt;\n"
    "      return false;\n"
    "    }\n"
    "    device.healthUpdatedAt = updatedAt;\n"
    "    device.online = online;\n"
    "    return true;\n"
    "  }",
    "  #setDeviceHealth(device: MutableDevice, online: boolean, updatedAt: string | null): boolean {\n"
    "    if (isOlderOrUndated(updatedAt, device.healthUpdatedAt)) {\n"
    "      return false;\n"
    "    }\n"
    "    if (device.online === online && device.healthUpdatedAt === updatedAt) {\n"
    "      return false;\n"
    "    }\n"
    "    device.healthUpdatedAt = updatedAt;\n"
    "    device.online = online;\n"
    "    return true;\n"
    "  }",
)
replace_once(
    path,
    "    if (\n"
    "      current &&\n"
    "      !momentaryEvent &&\n"
    '      state.attribute !== "signalMetrics" &&\n'
    "      sameStatePayload(current, state)\n"
    "    ) {\n"
    "      // Preserve the newest ordering timestamp in memory, but do not publish a\n"
    "      // Home Assistant state event or rewrite the full inventory snapshot.\n"
    "      device.states.set(key, cloneState(state));\n"
    "      return false;\n"
    "    }\n"
    "    device.states.set(key, cloneState(state));",
    "    if (current && !momentaryEvent && JSON.stringify(current) === JSON.stringify(state)) {\n"
    "      return false;\n"
    "    }\n"
    "    device.states.set(key, cloneState(state));",
)
replace_in_section(
    path,
    "  #applyDeviceEvent(input: unknown): void {",
    "  #applyDeviceHealthEvent(input: unknown): void {",
    "    const stateChanged = this.#setState(device, state);\n"
    "    if (!stateChanged) {\n"
    "      return;\n"
    "    }\n"
    "    const wasOnline = device.online;",
    "    const previousState = device.states.get(stateKey(state));\n"
    "    const durableStateChanged =\n"
    "      previousState === undefined || !sameStatePayload(previousState, state);\n"
    "    const stateChanged = this.#setState(device, state);\n"
    "    if (!stateChanged) {\n"
    "      return;\n"
    "    }\n"
    "    const wasOnline = device.online;",
)
replace_in_section(
    path,
    "  #applyDeviceEvent(input: unknown): void {",
    "  #applyDeviceHealthEvent(input: unknown): void {",
    "    this.#schedulePersist();\n",
    "    if (durableStateChanged || !wasOnline) {\n"
    "      this.#schedulePersist();\n"
    "    }\n",
)
replace_in_section(
    path,
    "  #applyDeviceHealthEvent(input: unknown): void {",
    "  #applySecurityArmStateEvent(input: unknown): void {",
    "    const device = current ?? this.#ensureDevice(deviceId, locationId as string);\n"
    "    if (!this.#setDeviceHealth(device, online, updatedAt)) {\n"
    "      return;\n"
    "    }\n"
    "    const sequence = this.#nextSequence();",
    "    const device = current ?? this.#ensureDevice(deviceId, locationId as string);\n"
    "    const onlineChanged = device.online !== online;\n"
    "    if (!this.#setDeviceHealth(device, online, updatedAt)) {\n"
    "      return;\n"
    "    }\n"
    "    if (!onlineChanged) {\n"
    "      return;\n"
    "    }\n"
    "    const sequence = this.#nextSequence();",
)
replace_in_section(
    path,
    "  observeOnlineEvidence(deviceId: string, observedAtMs: number): void {",
    "  reset(): void {",
    "    this.#schedulePersist();\n",
    "    if (!wasOnline) {\n"
    "      this.#schedulePersist();\n"
    "    }\n",
)

# Remove the over-aggressive test inserted by the first patch pass. Command
# confirmation requires equal-value newer events to remain observable.
path = "bridge/tests/state/device-store.test.ts"
overaggressive_test = r'''

  test("suppresses timestamp-only state and health churn while retaining ordering evidence", () => {
    const store = new DeviceStore();
    observeSnapshotState(store, {
      componentId: "main",
      capabilityId: "temperatureMeasurement",
      attributeName: "temperature",
      value: 21.5,
      unit: "C",
      timestamp: "2026-09-04T00:00:00.000Z"
    });
    observeHealthSnapshot(store, {
      deviceId: "dev_001",
      locationId: "loc_001",
      status: "ONLINE",
      updatedAt: "2026-09-04T00:00:01.000Z"
    });
    const before = store.currentSequence();
    const listener = vi.fn();
    store.subscribe(listener);

    store.observe(
      liveStateEvent({
        capability: "temperatureMeasurement",
        attribute: "temperature",
        value: 21.5,
        unit: "C",
        event_time: Date.parse("2026-09-04T00:01:00.000Z")
      })
    );
    store.observe(
      liveHealthEvent({
        locationId: "loc_001",
        status: "ONLINE",
        eventTime: "2026-09-04T00:01:01.000Z"
      })
    );

    expect(store.currentSequence()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    expect(store.snapshot().devices[0]).toMatchObject({
      online: true,
      healthUpdatedAt: "2026-09-04T00:01:01.000Z",
      states: [
        expect.objectContaining({
          attribute: "temperature",
          value: 21.5,
          updatedAt: "2026-09-04T00:01:00.000Z"
        })
      ]
    });
  });
'''
replace_once(path, overaggressive_test, "")
replace_in_section(
    path,
    '  test("retries a transient coalesced persistence failure without interrupting live publish", async () => {',
    '  test("does not mask graceful shutdown when the final best-effort persistence flush is locked", () => {',
    "      await vi.advanceTimersByTimeAsync(30);",
    "      await vi.advanceTimersByTimeAsync(5_100);",
)
replace_in_section(
    path,
    '  test("retries a transient coalesced persistence failure without interrupting live publish", async () => {',
    '  test("does not mask graceful shutdown when the final best-effort persistence flush is locked", () => {',
    "      await vi.advanceTimersByTimeAsync(300);",
    "      await vi.advanceTimersByTimeAsync(5_100);",
)

# Suppress only Home Assistant-visible state writes when the semantic payload is
# unchanged. The Bridge still sees and confirms every newer command event.
path = "custom_components/smartthings_web/models.py"
replace_once(
    path,
    "        current = device.states.get(state.key)\n"
    "        new_state_key = current is None\n"
    "        value_became_available = (\n"
    "            current is not None\n"
    "            and not state_has_entity_value(current)\n"
    "            and state_has_entity_value(state)\n"
    "        )\n"
    "        repeated_event = (\n"
    "            current is not None\n"
    "            and state.attribute in EVENT_ATTRIBUTES\n"
    "            and _timestamp(state.updated_at) == _timestamp(current.updated_at)\n"
    "        )\n"
    "        if current is not None and not _state_is_newer(state, current) and not repeated_event:\n"
    "            return False\n"
    "        self.inventory.sequence = sequence\n"
    "        device.states[state.key] = state\n"
    "        self._notify_listeners(\n",
    "        current = device.states.get(state.key)\n"
    "        new_state_key = current is None\n"
    "        value_became_available = (\n"
    "            current is not None\n"
    "            and not state_has_entity_value(current)\n"
    "            and state_has_entity_value(state)\n"
    "        )\n"
    "        repeated_event = (\n"
    "            current is not None\n"
    "            and state.attribute in EVENT_ATTRIBUTES\n"
    "            and _timestamp(state.updated_at) == _timestamp(current.updated_at)\n"
    "        )\n"
    "        if current is not None and not _state_is_newer(state, current) and not repeated_event:\n"
    "            return False\n"
    "        semantic_duplicate = (\n"
    "            current is not None\n"
    "            and state.attribute not in EVENT_ATTRIBUTES | {\"signalMetrics\"}\n"
    "            and _state_payload_equal(current, state)\n"
    "        )\n"
    "        self.inventory.sequence = sequence\n"
    "        device.states[state.key] = state\n"
    "        if semantic_duplicate:\n"
    "            return False\n"
    "        self._notify_listeners(\n",
)
replace_once(
    path,
    "def _state_is_newer(candidate: BridgeState, current: BridgeState) -> bool:\n"
    "    candidate_time = _timestamp(candidate.updated_at)\n"
    "    current_time = _timestamp(current.updated_at)\n"
    "    if current_time is None:\n"
    "        return True\n"
    "    if candidate_time is None:\n"
    "        return False\n"
    "    return candidate_time > current_time\n\n\n",
    "def _state_is_newer(candidate: BridgeState, current: BridgeState) -> bool:\n"
    "    candidate_time = _timestamp(candidate.updated_at)\n"
    "    current_time = _timestamp(current.updated_at)\n"
    "    if current_time is None:\n"
    "        return True\n"
    "    if candidate_time is None:\n"
    "        return False\n"
    "    return candidate_time > current_time\n\n\n"
    "def _state_payload_equal(left: BridgeState, right: BridgeState) -> bool:\n"
    "    \"\"\"Return whether an update changes anything visible in Home Assistant.\"\"\"\n"
    "    return (\n"
    "        left.value == right.value\n"
    "        and left.unit == right.unit\n"
    "        and left.component_role == right.component_role\n"
    "        and left.capability_role == right.capability_role\n"
    "    )\n\n\n",
)

path = "custom_components/smartthings_web/tests/test_models.py"
insert_before = "    def test_repeated_button_events_with_the_same_timestamp_keep_each_sequence(self) -> None:\n"
python_tests = '''    def test_timestamp_only_scalar_update_advances_sequence_without_entity_write(self) -> None:\n        current = inventory(10, 20, "2026-08-24T21:10:00Z")\n        runtime = SmartThingsWebRuntime(FakeClient(), "loc_001", current)\n        state = next(iter(current.devices["dev_001"].states.values()))\n        calls: list[str] = []\n        runtime.subscribe(lambda: calls.append("global"))\n        runtime.subscribe_state("dev_001", state.key, lambda: calls.append("state"))\n        runtime.subscribe_device("dev_001", lambda: calls.append("device"))\n\n        changed = runtime.apply_state(\n            state_event(11, state.value, "2026-08-24T21:11:00Z")\n        )\n\n        self.assertFalse(changed)\n        self.assertEqual(runtime.inventory.sequence, 11)\n        self.assertEqual(\n            runtime.inventory.devices["dev_001"].states[state.key].updated_at,\n            "2026-08-24T21:11:00Z",\n        )\n        self.assertEqual(calls, [])\n\n    def test_signal_metrics_timestamp_update_remains_visible(self) -> None:\n        current = inventory(10, 20, "2026-08-24T21:10:00Z")\n        signal = BridgeState(\n            "main",\n            "signalMetrics",\n            "signalMetrics",\n            {"lqi": 100, "rssi": -55},\n            None,\n            "2026-08-24T21:10:00Z",\n        )\n        current.devices["dev_001"].states = {signal.key: signal}\n        runtime = SmartThingsWebRuntime(FakeClient(), "loc_001", current)\n        calls: list[int] = []\n        runtime.subscribe_state(\n            "dev_001",\n            signal.key,\n            lambda: calls.append(runtime.inventory.sequence),\n        )\n\n        changed = runtime.apply_state(\n            {\n                "type": "state",\n                "sequence": 11,\n                "deviceId": "dev_001",\n                "state": {\n                    "component": "main",\n                    "capability": "signalMetrics",\n                    "attribute": "signalMetrics",\n                    "value": {"lqi": 100, "rssi": -55},\n                    "updatedAt": "2026-08-24T21:11:00Z",\n                },\n            }\n        )\n\n        self.assertTrue(changed)\n        self.assertEqual(calls, [11])\n\n'''
replace_once(path, insert_before, python_tests + insert_before)

# Release/version contract updates.
replace_once(
    "protocol/version.json",
    '"bridge_version": "0.1.172"',
    '"bridge_version": "0.1.173"',
)
path = "tests/addon-config.test.ts"
replace_once(
    path,
    'test("packages Advanced command and entity-ID parity as version 0.1.172", () => {',
    'test("packages storage-write optimization as version 0.1.173", () => {',
)
replace_once(path, 'expect(config.version).toBe("0.1.172");', 'expect(config.version).toBe("0.1.173");')
replace_once(
    path,
    'expect(packageMetadata.version).toBe("0.1.172");',
    'expect(packageMetadata.version).toBe("0.1.173");',
)
replace_once(
    path,
    'expect(protocolMetadata.bridge_version).toBe("0.1.172");',
    'expect(protocolMetadata.bridge_version).toBe("0.1.173");',
)
replace_once(
    path,
    'expect(runtime).toContain(\'const bridgeVersion = "0.1.172";\');',
    'expect(runtime).toContain(\'const bridgeVersion = "0.1.173";\');',
)
replace_once(
    path,
    'expect(changelog).toContain("## 0.1.172");',
    'expect(changelog).toContain("## 0.1.173");\n    expect(changelog).toContain("## 0.1.172");',
)
replace_once(
    path,
    '    expect(prepareData).toContain("exec chown -R pwuser:pwuser /data");',
    '    expect(prepareData).not.toContain("chown -R pwuser:pwuser /data");\n'
    '    expect(prepareData).toContain("chown pwuser:pwuser /data");\n'
    '    expect(prepareData).toContain("Service Worker/CacheStorage");',
)
path = "tests/protocol-version-contract.test.ts"
replace_once(
    path,
    'test("keeps every Bridge and integration release surface on the packaged 0.1.172 candidate", () => {',
    'test("keeps every Bridge and integration release surface on the packaged 0.1.173 candidate", () => {',
)
replace_once(
    path,
    'const expectedBridgeVersion = "0.1.172";',
    'const expectedBridgeVersion = "0.1.173";',
)

# Existing capture persistence test now explicitly enables debug persistence.
path = "bridge/tests/runtime.test.ts"
replace_in_section(
    path,
    '  test("updates safe protocol counters when duplicate sanitized DEVICE_EVENT frames arrive", async () => {',
    '  test("does not let outbound websocket traffic extend received push freshness", async () => {',
    "      createDeps(root, {\n"
    "        chromium: { launchPersistentContext: vi.fn(async () => context) }\n"
    "      })",
    "      createDeps(root, {\n"
    "        config: {\n"
    "          dataDir: root,\n"
    '          host: "127.0.0.1",\n'
    "          port: 0,\n"
    "          heartbeatIntervalMs: 10_000,\n"
    "          browserMaxRestarts: 2,\n"
    "          browserRetryDelayMs: 0,\n"
    "          debugProtocolLogging: true\n"
    "        },\n"
    "        chromium: { launchPersistentContext: vi.fn(async () => context) }\n"
    "      })",
)

# Replace the intermediate prepare-data implementation with a no-recursive-write
# version. Existing installations already migrated ownership in older releases;
# fresh files are created by pwuser.
write(
    "addon/smartthings_web_bridge/rootfs/etc/s6-overlay/scripts/prepare-data",
    r'''#!/command/with-contenv sh
set -eu

test -d /data
chown pwuser:pwuser /data

for directory in /data/chromium-profile /data/downloads /data/camera-images; do
  mkdir -p "$directory"
  chown pwuser:pwuser "$directory"
  chmod 0700 "$directory"
done

for cache_path in \
  "/data/chromium-profile/Default/Cache" \
  "/data/chromium-profile/Default/Code Cache" \
  "/data/chromium-profile/Default/GPUCache" \
  "/data/chromium-profile/Default/Service Worker/CacheStorage" \
  "/data/chromium-profile/Default/Service Worker/ScriptCache" \
  "/data/chromium-profile/GrShaderCache" \
  "/data/chromium-profile/ShaderCache" \
  "/data/chromium-profile/GraphiteDawnCache" \
  "/data/chromium-profile/DawnGraphiteCache" \
  "/data/chromium-profile/DawnWebGPUCache" \
  "/data/chromium-profile/Crashpad"; do
  rm -rf -- "$cache_path" 2>/dev/null || true
done

find /data/downloads -mindepth 1 -type f -mtime +7 -delete 2>/dev/null || true
''',
)

write(
    "tests/storage-hygiene.test.ts",
    r'''import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("HAOS storage hygiene", () => {
  test("keeps normal protocol capture persistence opt-in", () => {
    const runtime = readFileSync("bridge/src/runtime.ts", "utf8");
    expect(runtime).toContain("deps.config.debugProtocolLogging === true");
    expect(runtime).toContain(
      'persistCapture(record, analysis?.kind === "protocol_changed")'
    );
  });

  test("avoids recursive ownership rewrites and preserves Samsung login stores", () => {
    const script = readFileSync(
      "addon/smartthings_web_bridge/rootfs/etc/s6-overlay/scripts/prepare-data",
      "utf8"
    );
    expect(script).not.toContain("chown -R");
    expect(script).toContain("chown pwuser:pwuser /data");
    expect(script).toContain("/data/chromium-profile/Default/Cache");
    expect(script).toContain("/data/chromium-profile/Default/Service Worker/CacheStorage");
    expect(script).not.toContain("/data/chromium-profile/Default/Cookies");
    expect(script).not.toContain("/data/chromium-profile/Default/Local Storage");
    expect(script).not.toContain("/data/chromium-profile/Default/IndexedDB");
  });
});
''',
)

# Ensure the temporary patching files never ship in the release.
(ROOT / ".github/workflows/apply-storage-write-optimization-0.1.173.yml").unlink(missing_ok=True)
(ROOT / "tools/apply-storage-write-optimization-0.1.173.py").unlink(missing_ok=True)
Path(__file__).unlink(missing_ok=True)
