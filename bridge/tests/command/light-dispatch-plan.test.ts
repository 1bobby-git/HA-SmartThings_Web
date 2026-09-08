import { afterEach, describe, expect, test, vi } from "vitest";
import { DeviceStore } from "../../src/state/device-store.js";
import { prepareLightDispatch } from "../../src/command/light-dispatch-plan.js";
import type { VerifiedLightPlan } from "../../src/command/light-plan.js";
import type { CommandResyncEvidence } from "../../src/command/command-service.js";

const stores: DeviceStore[] = [];
afterEach(() => { stores.splice(0).forEach((s) => s.close()); vi.useRealTimers(); });
function fixture() {
  const store = new DeviceStore(); stores.push(store);
  const row = { deviceId: "dev_001", locationId: "loc_001", type: "light", status: { components: { identifier_main: {
    identifier_power: { switch: { value: "on", timestamp: "2026-09-08T00:00:00Z" } },
    identifier_level: { level: { value: 50, timestamp: "2026-09-08T00:00:00Z" } }
  } } } };
  store.observeAdvancedDeviceSnapshot({ items: [row] });
  const device = store.snapshot().devices[0]!;
  const plan: VerifiedLightPlan = { actions: [
    { deviceId: device.id, component: "identifier_main", capability: "identifier_power", capabilityVersion: 1, command: "on", arguments: [] },
    { deviceId: device.id, component: "identifier_main", capability: "identifier_level", capabilityVersion: 1, command: "setLevel", arguments: [50] },
    { deviceId: device.id, component: "identifier_main", capability: "identifier_color", capabilityVersion: 1, command: "setColor", arguments: [{ hue: 34, saturation: 96 }] }
  ], expected: [] };
  const proof = (): CommandResyncEvidence => ({ source: "advanced_device_status", authoritativeSnapshot: false,
    deviceId: device.id, locationId: device.locationId, startedAtMs: Date.now(),
    observedStates: store.commandStatusStates({ items: [row] }, device.id, device.locationId) });
  return { store, device, plan, proof };
}

describe("Read-proven redundant power and brightness pruning", () => {
  test("only skips observed exact on and level; never mutates the input plan/store", async () => {
    const f = fixture(), before = f.store.snapshot(), planBefore = structuredClone(f.plan);
    const result = await prepareLightDispatch(f.store, f.device, f.plan, async () => f.proof());
    expect(result.actions.map((a) => a.command)).toEqual(["setColor"]);
    expect(result.skippedCommands).toEqual(["on", "setLevel"]);
    expect(f.store.snapshot()).toEqual(before); expect(f.plan).toEqual(planBefore);
  });
  test.each(["wrong_device", "wrong_location", "inventory", "old_get", "future_get", "duplicate_switch", "missing_switch", "wrong_component", "old_timestamp", "invalid_timestamp", "wrong_source", "off", "new_revision"])(
    "keeps original plan on %s", async (kind) => {
      const f = fixture();
      const result = await prepareLightDispatch(f.store, f.device, f.plan, async () => {
        const p = f.proof(); const states = p.observedStates!;
        const power = states.find((s) => s.attribute === "switch")!;
        if (kind === "wrong_device") p.deviceId = "dev_999";
        if (kind === "wrong_location") p.locationId = "loc_999";
        if (kind === "inventory") p.authoritativeSnapshot = true;
        if (kind === "old_get") p.startedAtMs -= 1000;
        if (kind === "future_get") p.startedAtMs += 1000;
        if (kind === "duplicate_switch") p.observedStates = [...states, { ...power }];
        if (kind === "missing_switch") p.observedStates = states.filter((s) => s !== power);
        if (kind === "wrong_component") power.component = "identifier_other";
        if (kind === "old_timestamp") power.updatedAt = "2026-09-07T00:00:00Z";
        if (kind === "invalid_timestamp") power.updatedAt = "invalid";
        if (kind === "wrong_source") power.source = "ADVANCED_SNAPSHOT";
        if (kind === "off") power.value = "off";
        if (kind === "new_revision") f.store.beginLightCommand(f.device.id);
        return p;
      });
      expect(result.actions).toEqual(f.plan.actions); expect(result.skippedCommands).toEqual([]);
    });
  test("changed brightness is sent and is not rounded away as a redundant command", async () => {
    const f = fixture(); f.plan.actions[1]!.arguments = [50.1];
    const result = await prepareLightDispatch(f.store, f.device, f.plan, async () => f.proof());
    expect(result.actions.map((a) => a.command)).toEqual(["setLevel", "setColor"]);
  });
  test("brightness-only plan retains setLevel even when matching", async () => {
    const f = fixture(); f.plan.actions.pop();
    expect((await prepareLightDispatch(f.store, f.device, f.plan, async () => f.proof())).actions.map((a) => a.command)).toEqual(["setLevel"]);
  });
  test.each(["setColor", "setColorTemperature", "setHue", "setSaturation"])("always retains mode setter %s", async (command) => {
    const f = fixture(); f.plan.actions[2]!.command = command;
    expect((await prepareLightDispatch(f.store, f.device, f.plan, async () => f.proof())).actions.map((a) => a.command)).toEqual([command]);
  });
  test("null device timestamp corroborates the same value only", async () => {
    const f = fixture();
    const result = await prepareLightDispatch(f.store, f.device, f.plan, async () => {
      const p = f.proof(); p.observedStates!.forEach((s) => { s.updatedAt = null; }); return p;
    });
    expect(result.actions.map((a) => a.command)).toEqual(["setColor"]);
  });
  test("hung reader is bounded at 400ms and its late result cannot prune", async () => {
    vi.useFakeTimers(); const f = fixture();
    let resolve!: (p: CommandResyncEvidence) => void;
    const work = prepareLightDispatch(f.store, f.device, f.plan, () => new Promise((r) => { resolve = r; }));
    await vi.advanceTimersByTimeAsync(400);
    const result = await work;
    expect(result.actions).toEqual(f.plan.actions); expect(result.preflightMs).toBe(400);
    resolve(f.proof()); await vi.advanceTimersByTimeAsync(1);
    expect(result.skippedCommands).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });
  test("cancellation returns immediately and cleans up the preview timer", async () => {
    vi.useFakeTimers(); const f = fixture(), c = new AbortController();
    const work = prepareLightDispatch(f.store, f.device, f.plan, () => new Promise(() => {}), c.signal);
    c.abort(); await work; expect(vi.getTimerCount()).toBe(0);
  });
});
