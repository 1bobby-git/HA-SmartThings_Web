import { strict as assert } from "node:assert";
import { test } from "vitest";
import { deviceCommandTrace } from "../../src/command/device-command-diagnostics.js";
import { AdvancedFirstCommandExecutor } from "../../src/command/advanced-first-executor.js";
import { CommandTransportError } from "../../src/command/command-router.js";
import { SafeCommandService } from "../../src/command/command-service.js";
import { DeviceStore } from "../../src/state/device-store.js";
import { RuntimeStatusStore } from "../../src/state/runtime-state.js";

const target = { targetId: "dev_001", component: "identifier_111111111111",
  capability: "identifier_222222222222", command: "setLevel", attribute: "level",
  clientRequestId: "request_diagnostic_test_001" };
const action = { action: "setLevel", deviceId: target.targetId, deviceName: "Private device name",
  locationId: "loc_001", locationNames: {}, component: target.component, capability: target.capability,
  command: target.command, attribute: target.attribute, arguments: [50], requireAdvanced: true };
const receipt = () => ({state: "ACCEPTED" as const, transport: "advanced" as const, acceptedAtMs: Date.now()});

test("diagnostics retain alias scope and stable request correlation, without raw arguments", () => {
  const text = deviceCommandTrace(target, "status_read", {read: 2, observed: 5, target_matches: 0});
  assert.match(text, /device_dev_001/); assert.match(text, /component_identifier_111111111111/);
  assert.match(text, /status_read:read_2:observed_5:target_matches_0/);
  assert.ok(!text.includes(target.clientRequestId));
  assert.equal(text.split(":")[0], deviceCommandTrace(target, "confirmed").split(":")[0]);
});
test("diagnostics do not echo raw IDs, arbitrary commands, or unsafe metric keys", () => {
  const text = deviceCommandTrace({...target, targetId: "private-device", component: "private-component",
    capability: "private-capability", command: "private-command", attribute: "private-attribute"}, "failed",
    {"private metric": 1, invalid: NaN, negative: -1, read: 1});
  assert.ok(!text.includes("private")); assert.ok(!text.includes("NaN"));
  assert.ok(!text.includes("negative")); assert.match(text, /read_1/);
});
test("Advanced dispatch and receipt are observable without using the Web fallback", async () => {
  const logs: unknown[] = []; let sent = 0, fallback = 0;
  const executor = new AdvancedFirstCommandExecutor({name: "advanced", execute: async () => {sent++; return receipt();}},
    {executeDeviceAction: async () => {fallback++;}}, {onDiagnostic: (event) => logs.push(event)});
  await executor.executeDeviceAction(action);
  assert.equal(sent, 1); assert.equal(fallback, 0);
  assert.deepEqual(logs, [{transport:"advanced",stage:"dispatch",outcome:"attempt"},
    {transport:"advanced",stage:"receipt",outcome:"accepted"}]);
});
test("failed Advanced dispatch remains failed and does not retry through the Web", async () => {
  const logs: unknown[] = []; let sent = 0, fallback = 0;
  const executor = new AdvancedFirstCommandExecutor({name: "advanced", execute: async () => {
    sent++; throw new CommandTransportError("authentication", "advanced");
  }}, {executeDeviceAction: async () => {fallback++;}}, {onDiagnostic: (event) => logs.push(event)});
  await assert.rejects(executor.executeDeviceAction(action), /command_login_required/);
  assert.equal(sent, 1); assert.equal(fallback, 0);
  assert.equal((logs.at(-1) as {outcome: string}).outcome, "failed");
});
test("a broken diagnostic sink cannot change accepted Advanced execution", async () => {
  const executor = new AdvancedFirstCommandExecutor({name: "advanced", execute: async () => receipt()},
    {executeDeviceAction: async () => {throw new Error("unexpected fallback");}},
    {onDiagnostic: () => {throw new Error("diagnostic sink broken");}});
  assert.equal((await executor.executeDeviceAction(action)).state, "ACCEPTED");
});
function fixture() {
  const store = new DeviceStore();
  const row = (value: string) => ({items: [{deviceId: "dev_001", locationId: "loc_001",
    status: {components: {main: {identifier_222222222222: {switch: {value}}}}}}]});
  store.observeAdvancedDeviceSnapshot(row("off"));
  store.observeAdvancedCommandCatalog("dev_001", ["on", "off"].map(command => ({
    component: "main", capability: target.capability, capabilityVersion: 1, command,
    arguments: [], transport: "advanced", confirmation: "state", label: command, labelSource: "capability"
  })), []);
  const now = Date.now();
  const status = new RuntimeStatusStore({initial: {state: "CONNECTED", chromiumRunning: true,
    keeperPresent: true, authenticated: true, pushConnected: true, parserHealthy: true,
    initialSnapshotComplete: true, dbAvailable: true, heartbeatAtMs: now,
    initialSnapshotCompletedAtMs: now, lastSnapshotAtMs: now, lastParserSuccessAtMs: now, lastPushAtMs: now}});
  const request = {...target, component: "main", attribute: "switch", command: "on", targetType: "device",
    arguments: [], requireAdvanced: true, confirm: true};
  return {store, row, status, request};
}
test("command-scoped diagnostics distinguish actual status confirmation from acceptance", async () => {
  const {store, row, status, request} = fixture(); const logs: string[] = [];
  const service = new SafeCommandService({devices: store, status, timeoutMs: 150, resyncAfterMs: 5,
    executor: {executeDeviceAction: async () => receipt()}, onDeviceDiagnostic: text => logs.push(text),
    resync: async () => ({source: "advanced_device_status", deviceId: "dev_001", locationId: "loc_001",
      authoritativeSnapshot: false, startedAtMs: Date.now(),
      observedStates: store.observeCommandDeviceStatus(row("on"), "dev_001", "loc_001")})});
  try {
    assert.equal((await service.execute(request)).status, "confirmed");
    assert.ok(logs.some(text => text.includes(":accepted:")));
    assert.ok(logs.some(text => text.includes(":status_read:") && text.includes(":target_matches_1")));
    assert.ok(logs.some(text => text.includes(":confirmed:")));
  } finally {store.close();}
});
test("empty status is diagnosed, not substituted with receipt-only success", async () => {
  const {store, status, request} = fixture(); const logs: string[] = [];
  const service = new SafeCommandService({devices: store, status, timeoutMs: 120, resyncAfterMs: 5,
    executor: {executeDeviceAction: async () => receipt()}, onDeviceDiagnostic: text => logs.push(text),
    resync: async () => ({source: "advanced_device_status", deviceId: "dev_001", locationId: "loc_001",
      authoritativeSnapshot: false, startedAtMs: Date.now(), observedStates: []})});
  try {
    await assert.rejects(service.execute(request), {code: "command_confirmation_timeout"});
    assert.ok(logs.some(text => text.includes(":observed_0:target_0:target_matches_0")));
    assert.ok(logs.some(text => text.includes(":failed:")));
    assert.ok(!logs.some(text => text.includes(":confirmed:")));
  } finally {store.close();}
});
test("diagnostic errors do not mask command confirmation failure", async () => {
  const {store, status, request} = fixture();
  const service = new SafeCommandService({devices: store, status, timeoutMs: 60, resyncAfterMs: 5,
    executor: {executeDeviceAction: async () => receipt()},
    onDeviceDiagnostic: () => {throw new Error("sink error must not leak");},
    resync: async () => {throw new Error("reader failure");}});
  try {await assert.rejects(service.execute(request), {code: "command_confirmation_timeout"});}
  finally {store.close();}
});

test("commandState matches the public state but returns an independent value", () => {
  const {store} = fixture();
  try {
    const state = store.commandState("dev_001", "loc_001", "main", target.capability, "switch")!;
    assert.deepEqual(state, store.snapshot().devices[0]!.states.find(entry => entry.attribute === "switch"));
    state.value = "on";
    assert.equal(store.commandState("dev_001", "loc_001", "main", target.capability, "switch")!.value, "off");
  } finally {store.close();}
});
test("commandState rejects another location, component, capability, and missing target", () => {
  const {store} = fixture();
  try {
    assert.equal(store.commandState("dev_001", "loc_002", "main", target.capability, "switch"), undefined);
    assert.equal(store.commandState("dev_001", "loc_001", "sibling", target.capability, "switch"), undefined);
    assert.equal(store.commandState("dev_001", "loc_001", "main", "identifier_333333333333", "switch"), undefined);
    assert.equal(store.commandState("dev_002", "loc_001", "main", target.capability, "switch"), undefined);
  } finally {store.close();}
});
test("confirmation rechecks do not repeatedly clone unrelated device inventories", async () => {
  const {store, row, status, request} = fixture();
  let snapshots = 0;
  const snapshot = store.snapshot.bind(store);
  store.snapshot = () => {snapshots++; return snapshot();};
  const service = new SafeCommandService({devices: store, status, timeoutMs: 150, resyncAfterMs: 5,
    executor: {executeDeviceAction: async () => receipt()}, onDeviceDiagnostic: () => undefined,
    resync: async () => ({source: "advanced_device_status", deviceId: "dev_001", locationId: "loc_001",
      authoritativeSnapshot: false, startedAtMs: Date.now(),
      observedStates: store.observeCommandDeviceStatus(row("on"), "dev_001", "loc_001")})});
  try {
    assert.equal((await service.execute(request)).status, "confirmed");
    assert.ok(snapshots <= 2, `unexpected full-inventory clones: ${snapshots}`);
  } finally {store.close();}
});
