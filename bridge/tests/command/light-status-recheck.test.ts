import { afterEach, expect, test, vi } from "vitest";
import { DeviceStore } from "../../src/state/device-store.js";
import { readLightCommandStatus } from "../../src/command/light-status-recheck.js";
const stores: DeviceStore[] = [];
afterEach(() => { stores.splice(0).forEach((store) => store.close()); });
const t = "2026-09-08T00:00:00Z";
const row = (value: unknown, timestamp: string | null = t, attribute = "level", component = "main", deviceId = "dev_001", locationId = "loc_001") =>
  ({ items: [{ deviceId, locationId, label: "Test lamp", type: "light",
    status: { components: { [component]: { switchLevel: { [attribute]: { value, timestamp } } } } } }] });
function setup() {
  const store = new DeviceStore(); stores.push(store);
  store.observeAdvancedDeviceSnapshot(row(10));
  const current = () => store.commandState("dev_001", "loc_001", "main", "switchLevel", "level")!;
  return { store, current };
}

test.each([null, t])("two agreeing exact reads repair %s timestamp without inventing an event date", async (timestamp) => {
  const { store, current } = setup(); const sequence = store.currentSequence();
  const read = vi.fn(async () => row(60, timestamp));
  const observed = await readLightCommandStatus(store, "dev_001", "loc_001", read, "main");
  expect(read).toHaveBeenCalledTimes(2);
  expect(observed[0]!.updatedAt).toBe(timestamp);
  expect(current()).toMatchObject({ value: 60, updatedAt: t, commandReadVerified: true, source: "COMMAND_STATUS_RECHECK" });
  expect(store.currentSequence()).toBeGreaterThan(sequence);
  // Ordinary replay must still be rejected using the retained upstream watermark.
  store.observeAdvancedDeviceSnapshot(row(10, t));
  expect(current().value).toBe(60);
});

test("generic status reads retain strict timestamp semantics", async () => {
  const { store, current } = setup(); const read = vi.fn(async () => row(60, null));
  await readLightCommandStatus(store, "dev_001", "loc_001", read);
  expect(read).toHaveBeenCalledOnce(); expect(current().value).toBe(10);
});

test.each(["disagree", "second_fails", "new_command", "new_push", "wrong_device", "wrong_location", "other_component", "older_date", "security_attribute"])
  ("%s cannot authorize a stale or out-of-scope repair", async (failure) => {
    const { store, current } = setup();
    if (failure === "security_attribute") store.observeAdvancedDeviceSnapshot(row("DISARMED", t, "armState"));
    let calls = 0;
    const read = vi.fn(async () => {
      calls++;
      if (calls === 2) {
        if (failure === "second_fails") throw Error("network failure");
        if (failure === "new_command") store.beginLightCommand("dev_001");
        if (failure === "new_push") store.observeAdvancedDeviceSnapshot(row(70, "2026-09-08T00:00:01Z"));
      }
      return row(failure === "security_attribute" ? "ARMED_AWAY" : failure === "disagree" && calls === 2 ? 40 : 60,
        failure === "older_date" ? "2026-09-07T00:00:00Z" : null,
        failure === "security_attribute" ? "armState" : "level",
        failure === "other_component" ? "other" : "main",
        failure === "wrong_device" ? "dev_002" : "dev_001",
        failure === "wrong_location" ? "loc_002" : "loc_001");
    });
    await readLightCommandStatus(store, "dev_001", "loc_001", read, "main");
    expect(current().value).toBe(failure === "new_push" ? 70 : 10);
    if (failure === "security_attribute") expect(store.commandState("dev_001", "loc_001", "main", "switchLevel", "armState")!.value).toBe("DISARMED");
  });

test("normal newer timestamp uses one GET and no exceptional proof marker", async () => {
  const { store, current } = setup(); const read = vi.fn(async () => row(60, "2026-09-08T00:00:01Z"));
  await readLightCommandStatus(store, "dev_001", "loc_001", read, "main");
  expect(read).toHaveBeenCalledOnce(); expect(current().value).toBe(60);
  expect(current().commandReadVerified).toBeUndefined();
});

const exact = (value: unknown, timestamp: string | null = t) => {
  const payload = row(value, timestamp);
  const { label: _label, type: _type, ...device } = payload.items[0]!;
  return { items: [device] };
};

test.each([null, t, "2026-09-08T00:00:01Z"])("exact light status %s emits a delta instead of requesting the entire inventory", async (timestamp) => {
  const { store, current } = setup(); const events: any[] = [];
  const sequence = store.currentSequence(); store.subscribe((event) => events.push(event));
  const read = vi.fn(async () => exact(60, timestamp));
  await readLightCommandStatus(store, "dev_001", "loc_001", read, "main");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "state", deviceId: "dev_001", sequence: sequence + 1,
    state: { attribute: "level", value: 60, source: "COMMAND_STATUS_RECHECK" } });
  expect(events[0].eventTime).toBeUndefined(); expect(events[0].commandId).toBeUndefined();
  expect(current().value).toBe(60);
  expect(read).toHaveBeenCalledTimes(timestamp === "2026-09-08T00:00:01Z" ? 1 : 2);
});

test("unchanged command reads are silent and generic reads retain inventory delivery", async () => {
  const { store } = setup(); const events: any[] = []; store.subscribe((event) => events.push(event));
  await readLightCommandStatus(store, "dev_001", "loc_001", async () => exact(10, "2026-09-08T00:00:01Z"), "main");
  expect(events).toEqual([]);
  await readLightCommandStatus(store, "dev_001", "loc_001", async () => exact(70, "2026-09-08T00:00:02Z"));
  expect(events.map((event) => event.type)).toEqual(["inventory"]);
});

test("metadata-bearing reads keep the existing full inventory path", async () => {
  const { store } = setup(); const events: any[] = []; store.subscribe((event) => events.push(event));
  await readLightCommandStatus(store, "dev_001", "loc_001", async () => row(60, "2026-09-08T00:00:01Z"), "main");
  expect(events.map((event) => event.type)).toEqual(["inventory"]);
});

test("new state keys retain inventory discovery instead of assuming HA knows the topology", async () => {
  const { store } = setup(); const events: any[] = []; store.subscribe((event) => events.push(event));
  const payload = exact(60, "2026-09-08T00:00:01Z");
  (payload.items[0]!.status.components.main!.switchLevel as any).new_attribute = { value: 1, timestamp: t };
  await readLightCommandStatus(store, "dev_001", "loc_001", async () => payload, "main");
  expect(events.map((event) => event.type)).toEqual(["inventory"]);
});

test("two channel repairs have contiguous sequences and never deliver an uncorroborated value", async () => {
  const { store } = setup();
  const initial = exact(10); (initial.items[0]!.status.components.main!.switchLevel as any).hue = { value: 0, timestamp: t };
  store.observeAdvancedDeviceSnapshot(initial);
  const events: any[] = []; store.subscribe((event) => events.push(event)); const seq = store.currentSequence();
  const payload = exact(60, null); (payload.items[0]!.status.components.main!.switchLevel as any).hue = { value: 34, timestamp: null };
  await readLightCommandStatus(store, "dev_001", "loc_001", async () => payload, "main");
  expect(events.map((event) => event.sequence)).toEqual([seq + 1, seq + 2]);
  expect(events.every((event) => event.type === "state" && event.state.commandReadVerified)).toBe(true);
  expect(events.map((event) => event.state.attribute).sort()).toEqual(["hue", "level"]);
});

test("a new command between corroborating reads cannot leak a stale delta", async () => {
  const { store, current } = setup(); const events: any[] = []; store.subscribe((event) => events.push(event));
  let count = 0;
  await readLightCommandStatus(store, "dev_001", "loc_001", async () => {
    if (++count === 2) store.beginLightCommand("dev_001");
    return exact(60, null);
  }, "main");
  expect(events).toEqual([]); expect(current().value).toBe(10);
});
