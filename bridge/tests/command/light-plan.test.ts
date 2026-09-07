import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DeviceStore } from "../../src/state/device-store.js";
import { RuntimeStatusStore } from "../../src/state/runtime-state.js";
import { SafeCommandService } from "../../src/command/command-service.js";
import { AdvancedCommandCatalog } from "../../src/advanced/command-catalog.js";
import { CapabilityDefinitionCache, parseCapabilityDefinition } from "../../src/advanced/capability-cache.js";
import { AdvancedCommandAdapter } from "../../src/advanced/command-adapter.js";
import { AdvancedFirstCommandExecutor } from "../../src/command/advanced-first-executor.js";
import { lightPlanMatches, lightValueMatches } from "../../src/command/light-plan.js";
import { verifiedAdvancedControl } from "../../src/command/verified-control-route.js";
import type { AdvancedParser, AdvancedRequest } from "../../src/advanced/authenticated-session.js";
import type { DeviceActionExecutionInput } from "../../src/command/command-service.js";

const shared = JSON.parse(readFileSync("custom_components/smartthings_web/tests/fixtures/light-plan.json", "utf8"));
const stores: DeviceStore[] = [];
afterEach(() => { stores.splice(0).forEach((store) => store.close()); vi.useRealTimers(); });
async function fixture() {
  const store = new DeviceStore(); stores.push(store);
  const row = (values: Record<string, unknown>, timestamp = "2026-09-07T00:00:00Z") => ({
    deviceId: "dev_001", locationId: "loc_001", label: "Fixture lamp", type: "light",
    status: { components: { identifier_main: Object.fromEntries(Object.entries(shared.capabilities).map(([capability, attributes]) =>
      [capability, Object.fromEntries((attributes as string[]).filter((attribute) => attribute in values).map((attribute) =>
        [attribute, { value: values[attribute], timestamp }]))])) } }
  });
  store.observeAdvancedDeviceSnapshot({ items: [row(shared.initial)] });
  const definitions = shared.definitions.map(parseCapabilityDefinition);
  const loader = async (id: string) => { const value = definitions.find((item: any) => item.id === id); if (!value) throw Error("missing definition"); return value; };
  const catalog = await new AdvancedCommandCatalog(loader).build(shared.bindings);
  store.observeAdvancedCommandCatalog("dev_001", catalog.commandsByDevice.get("dev_001")!, catalog.omissions);
  const requests: AdvancedRequest[] = [];
  let desired = { ...shared.initial };
  const send = vi.fn(async <T>(request: AdvancedRequest, parser: AdvancedParser<T>): Promise<T> => {
    requests.push(request);
    const commands = (request.body as { commands: any[] }).commands;
    // Simulate a controller accepting setColor, not setHue/setSaturation handlers.
    for (const command of commands) {
      if (command.command === "on" || command.command === "off") desired.switch = command.command;
      if (command.command === "setLevel") desired.level = command.arguments[0];
      if (command.command === "setColorTemperature") desired.colorTemperature = command.arguments[0];
      if (command.command === "setColor") Object.assign(desired, command.arguments[0]);
    }
    return parser({ results: commands.map(() => ({ status: "ACCEPTED" })) });
  });
  const adapter = new AdvancedCommandAdapter({ session: { request: async <T>(request: AdvancedRequest, parser: AdvancedParser<T>): Promise<T> => await send(request, parser) as T }, capabilityCache: new CapabilityDefinitionCache(loader),
    resolveRawDeviceId: (id) => id === "dev_001" ? "fixture-device" : undefined,
    resolveRawIdentifier: (id) => shared.rawIdentifiers[id] });
  const legacy = { executeDeviceAction: vi.fn(async () => "location_native" as const) };
  const executor = new AdvancedFirstCommandExecutor(adapter, legacy, {
    canUseAdvanced: (input) => verifiedAdvancedControl(store.snapshot().devices.find((d) => d.id === input.deviceId), input)
  });
  const resync = vi.fn(async () => {
    const startedAtMs = Date.now();
    const observedStates = store.observeCommandDeviceStatus({ items: [row(desired, new Date().toISOString())] }, "dev_001", "loc_001");
    return { source: "advanced_device_status" as const, authoritativeSnapshot: false,
      deviceId: "dev_001", locationId: "loc_001", observedStates, startedAtMs };
  });
  const now = Date.now();
  const status = new RuntimeStatusStore({ initial: { state: "CONNECTED", chromiumRunning: true, keeperPresent: true,
    authenticated: true, pushConnected: true, parserHealthy: true, initialSnapshotComplete: true, dbAvailable: true,
    heartbeatAtMs: now, initialSnapshotCompletedAtMs: now, lastSnapshotAtMs: now, lastParserSuccessAtMs: now, lastPushAtMs: now } });
  const diagnostics = vi.fn();
  const service = new SafeCommandService({ devices: store, status, executor, timeoutMs: 60, resyncAfterMs: 1,
    resync, onDeviceDiagnostic: diagnostics });
  const request = structuredClone(shared.request);
  return { store, catalog, request, service, send, resync, legacy, requests, row, diagnostics,
    setDesired: (value: Record<string, unknown>) => { desired = value; } };
}

describe("Verified same-component light plans through real catalog/store/adapter", () => {
  test("retains bounded setColor and sends power/level/color once before waiting", async () => {
    const f = await fixture();
    expect(f.catalog.omissions).toEqual([]);
    expect(f.catalog.commandsByDevice.get("dev_001")).toEqual(shared.expectedCatalog.commands);
    expect(f.store.snapshot().devices[0]!.advancedCommands?.some((item) => item.command === "setColor")).toBe(true);
    const result = await f.service.execute(f.request);
    expect(result).toMatchObject({ status: "confirmed", transport: "advanced" });
    expect(f.send).toHaveBeenCalledOnce(); expect(f.legacy.executeDeviceAction).not.toHaveBeenCalled();
    expect((f.requests[0]!.body as any).commands).toEqual(shared.expectedCommands);
    expect(f.resync).toHaveBeenCalledOnce();
    expect(f.store.snapshot().devices[0]!.states.find((item) => item.attribute === "level")!.value).toBe(50);
    expect(f.diagnostics.mock.calls.some(([entry]) => entry.stage === "read" && entry.matches)).toBe(true);
  });

  test("unchanged power cannot block numeric members, even without a new on event", async () => {
    const f = await fixture();
    f.store.observeAdvancedDeviceSnapshot({ items: [f.row({ ...shared.initial, switch: "on" }, "2026-09-07T00:00:01Z")] });
    expect((await f.service.execute(f.request)).status).toBe("confirmed");
    expect((f.requests[0]!.body as any).commands).toHaveLength(3);
  });

  test.each(["receipt_only", "wrong_device", "wrong_location", "missing_hue", "stale_read", "wrong_color"])("%s never completes a plan", async (failure) => {
    const f = await fixture();
    const original = f.resync.getMockImplementation()!;
    f.resync.mockImplementation(async () => {
      if (failure === "wrong_color") f.setDesired({ ...shared.initial, switch: "on", level: 50 });
      const evidence = await original();
      if (failure === "receipt_only") evidence.observedStates = [];
      if (failure === "wrong_device") evidence.deviceId = "dev_002";
      if (failure === "wrong_location") evidence.locationId = "loc_002";
      if (failure === "missing_hue") evidence.observedStates = evidence.observedStates.filter((item) => item.attribute !== "hue");
      if (failure === "stale_read") evidence.startedAtMs = 0;
      return evidence;
    });
    // Keep timestamps/values unchanged for inventory-only matching; fresh proof must win.
    f.store.observeAdvancedDeviceSnapshot({ items: [f.row({ switch: "on", level: 50, hue: 0, saturation: 100, colorTemperature: 3000 }, "2099-01-01T00:00:00Z")] });
    if (failure === "wrong_color") f.store.observeAdvancedDeviceSnapshot({ items: [f.row(shared.initial, "2099-02-01T00:00:00Z")] });
    await expect(f.service.execute(f.request)).rejects.toMatchObject({ code: "command_confirmation_timeout" });
    expect(f.send).toHaveBeenCalledOnce();
  });

  test.each(["range", "mixed_component", "extra_key", "missing_color_member", "mixed_modes", "unknown_setter", "unconfirmed", "too_many"])("rejects %s before any POST", async (kind) => {
    const f = await fixture();
    const request = structuredClone(f.request);
    if (kind === "range") request.arguments[1].arguments = [101];
    if (kind === "mixed_component") request.arguments[1].component = "identifier_other";
    if (kind === "extra_key") request.arguments[2].arguments[0].token = "never_send";
    if (kind === "missing_color_member") delete request.arguments[2].arguments[0].saturation;
    if (kind === "mixed_modes") request.arguments.push({ attribute: "colorTemperature", capability: "identifier_temperature", command: "setColorTemperature", arguments: [3000] });
    if (kind === "unknown_setter") request.arguments[1].command = "unlock";
    if (kind === "unconfirmed") request.confirm = false;
    if (kind === "too_many") request.arguments.push(...request.arguments);
    await expect(f.service.execute(request)).rejects.toBeInstanceOf(Error);
    expect(f.send).not.toHaveBeenCalled();
  });

  test("invalidated catalog is revalidated at execution", async () => {
    const f = await fixture();
    f.store.observeAdvancedCommandCatalog("dev_001", [], []);
    await expect(f.service.execute(f.request)).rejects.toMatchObject({ code: "unsupported_command" });
    expect(f.send).not.toHaveBeenCalled();
  });

  test("rejected batch never falls back to native or repeats partially accepted commands", async () => {
    const f = await fixture();
    f.send.mockImplementation(async (request, parser) => parser({ results: [{status:"ACCEPTED"}, {status:"ERROR"}, {status:"ACCEPTED"}] }));
    await expect(f.service.execute(f.request)).rejects.toMatchObject({ code: "command_execution_failed" });
    expect(f.send).toHaveBeenCalledOnce(); expect(f.legacy.executeDeviceAction).not.toHaveBeenCalled();
  });

  test("nested public catalog copies cannot mutate the cached schema", async () => {
    const f = await fixture();
    const color = f.store.snapshot().devices[0]!.advancedCommands!.find((item) => item.command === "setColor")!;
    (color.arguments[0]!.schema.properties as any).hue.maximum = 500;
    expect((f.store.snapshot().devices[0]!.advancedCommands!.find((item) => item.command === "setColor")!.arguments[0]!.schema.properties as any).hue.maximum).toBe(100);
  });

  test("late convergence and quantized report preserve actual values, not the input", async () => {
    const f = await fixture();
    const original = f.resync.getMockImplementation()!;
    f.resync.mockImplementation(async () => { f.setDesired({ switch: "on", level: 49.8, hue: 99.9, saturation: 99.8, colorTemperature: 3000 }); return original(); });
    expect((await f.service.execute(f.request)).status).toBe("confirmed");
    expect(f.store.snapshot().devices[0]!.states.find((item) => item.attribute === "level")!.value).toBe(49.8);
  });
});

describe("Bounded light-only resolution", () => {
  test.each([["hue",99.9,0,true], ["hue",98,0,false], ["level",49.8,50,true], ["level",49,50,false],
    ["colorTemperature",2994,3000,true], ["colorTemperature",2700,3000,false], ["switch","off","on",false],
    ["hue",null,0,false], ["saturation",NaN,50,false], ["level",true,1,false]])("%s %s vs %s", (attr,actual,desired,expected) => {
    expect(lightValueMatches(attr as string, actual, desired as number|string)).toBe(expected);
  });
});

describe("Verified power transport and stale-cache protection", () => {
  const powerRequest = (f: Awaited<ReturnType<typeof fixture>>, command: string) => ({ ...f.request, command, arguments: [] });
  test("standalone power uses the verified Advanced route, not native acceptance", async () => {
    const f = await fixture();
    expect((await f.service.execute(powerRequest(f,"on"))).status).toBe("confirmed");
    expect(f.send).toHaveBeenCalledOnce(); expect(f.legacy.executeDeviceAction).not.toHaveBeenCalled();
    expect((f.requests[0]!.body as any).commands).toEqual([{component:"main",capability:"switch",command:"on",arguments:[]}]);
  });
  test("an OFF cache cannot swallow a real OFF request when a fresh GET says ON", async () => {
    // Wall-clock scheduling can enter the final recheck window before this
    // assertion. Drive the same production timers explicitly; keep exact counts.
    vi.useFakeTimers();
    const f = await fixture(); f.setDesired({...shared.initial,switch:"on"});
    const confirmed = expect(f.service.execute(powerRequest(f,"off")))
      .resolves.toMatchObject({ status: "confirmed" });
    await vi.advanceTimersByTimeAsync(5);
    await confirmed;
    expect(f.resync).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenCalledOnce();
    expect((f.requests[0]!.body as any).commands[0].command).toBe("off");
    await vi.advanceTimersByTimeAsync(100);
    expect(f.resync).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenCalledOnce();
  });
  test("already-confirmed power needs a fresh exact state and avoids unnecessary POST", async () => {
    const f = await fixture();
    expect((await f.service.execute(powerRequest(f,"off"))).status).toBe("already_confirmed");
    expect(f.resync).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
  });
  test("a read failure cannot report a stale cache as already confirmed", async () => {
    const f = await fixture();
    f.resync.mockRejectedValue(new Error("read unavailable"));
    await expect(f.service.execute(powerRequest(f,"off"))).rejects.toMatchObject({code:"command_confirmation_timeout"});
    expect(f.send).toHaveBeenCalledOnce();
  });
  test.each(["missing_catalog","version","location","offline","omitted","duplicate","other_command"])("does not enable Advanced preference for %s", async (kind) => {
    const f = await fixture(), device = f.store.snapshot().devices[0]!;
    const input: DeviceActionExecutionInput = {action:"on",command:"on",arguments:[],attribute:"switch",component:"identifier_main",
      capability:"identifier_power",capabilityVersion:1,deviceId:"dev_001",deviceName:"Fixture",locationId:"loc_001",locationNames:{}};
    expect(verifiedAdvancedControl(device,input)).toBe(true);
    if (kind === "missing_catalog") device.advancedCommands = [];
    if (kind === "version") input.capabilityVersion = 2;
    if (kind === "location") input.locationId = "loc_002";
    if (kind === "offline") device.online = false;
    if (kind === "omitted") device.commandOmissions = [{component:input.component,capability:input.capability,command:"on",reason:"schema_invalid"}];
    if (kind === "duplicate") device.advancedCommands!.push(device.advancedCommands!.find(item=>item.command==="on")!);
    if (kind === "other_command") input.command = "unlock";
    expect(verifiedAdvancedControl(device,input)).toBe(false);
  });
});


describe("Fresh brightness retries", () => {
  const levelRequest = (f: Awaited<ReturnType<typeof fixture>>) => ({ ...f.request,
    command: "setLevel", attribute: "level", capability: "identifier_level", arguments: [shared.initial.level] });
  test("a cached brightness cannot suppress a command when the lamp changed without an event", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.setDesired({ ...shared.initial, level: 80 });
    const confirmed = expect(f.service.execute(levelRequest(f)))
      .resolves.toMatchObject({ status: "confirmed" });
    await vi.advanceTimersByTimeAsync(5);
    await confirmed;
    expect(f.resync).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenCalledOnce();
    expect((f.requests[0]!.body as any).commands).toEqual([
      { component: "main", capability: "switchLevel", command: "setLevel", arguments: [shared.initial.level] }
    ]);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.resync).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenCalledOnce();
  });
  test("a fresh exact brightness can avoid a redundant write", async () => {
    const f = await fixture();
    expect((await f.service.execute(levelRequest(f))).status).toBe("already_confirmed");
    expect(f.resync).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled();
  });
  test("a failed brightness read cannot confirm a stale cached value", async () => {
    const f = await fixture();
    f.resync.mockRejectedValue(new Error("read unavailable"));
    await expect(f.service.execute(levelRequest(f))).rejects.toMatchObject({ code: "command_confirmation_timeout" });
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.legacy.executeDeviceAction).not.toHaveBeenCalled();
  });
  test.each(["wrong_device", "wrong_location", "missing_level", "old_read"])("%s is not current brightness proof", async (failure) => {
    const f = await fixture();
    const read = f.resync.getMockImplementation()!;
    f.resync.mockImplementation(async () => {
      const proof = await read();
      if (failure === "wrong_device") proof.deviceId = "dev_002";
      if (failure === "wrong_location") proof.locationId = "loc_002";
      if (failure === "missing_level") proof.observedStates = proof.observedStates.filter(item => item.attribute !== "level");
      if (failure === "old_read") proof.startedAtMs = 0;
      return proof;
    });
    await f.service.execute(levelRequest(f)).catch(() => undefined);
    expect(f.send).toHaveBeenCalledOnce();
  });
});
