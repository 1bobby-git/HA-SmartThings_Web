import { afterEach, describe, expect, test, vi } from "vitest";
import { DeviceStore } from "../../src/state/device-store.js";

const stores: DeviceStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); });
const row = (deviceId = "dev_001", locationId = "loc_001") => ({ deviceId, locationId, label: "Fixture light",
  status: { components: { identifier_main: { identifier_level: {
    level: { value: 50, timestamp: "2026-09-07T00:00:00Z" },
    levelRange: { value: { minimum: 0, maximum: 100 }, timestamp: "2026-09-07T00:00:00Z" },
    image: { value: "fixture_image", timestamp: "2026-09-07T00:00:00Z" }
  } } } } });
function fixture() { const store = new DeviceStore(); stores.push(store); store.observeAdvancedDeviceSnapshot({ items: [row()] }); return store; }
const exact = (store: DeviceStore, attribute = "level") => store.commandState("dev_001", "loc_001", "identifier_main", "identifier_level", attribute);

describe("Command-scoped state reads", () => {
  test("matches filtered inventory states without exposing hidden image metadata", () => {
    const store = fixture();
    expect(store.commandStates("dev_001", "loc_001")).toEqual(store.snapshot().devices[0]!.states);
    expect(exact(store, "image")).toBeUndefined();
  });
  test("reads are detached including nested values and do not advance sequence", () => {
    const store = fixture(), before = store.snapshot();
    const state = exact(store, "levelRange")!;
    (state.value as Record<string, unknown>).maximum = 1;
    const states = store.commandStates("dev_001", "loc_001");
    states[0]!.value = null;
    expect(store.snapshot()).toEqual(before);
  });
  test.each(["dev_002", "dev_999"])("rejects missing target %s", deviceId => {
    const store = fixture();
    expect(store.commandStates(deviceId, "loc_001")).toEqual([]);
    expect(store.commandState(deviceId, "loc_001", "identifier_main", "identifier_level", "level")).toBeUndefined();
  });
  test("rejects different locations and exact-key mismatches", () => {
    const store = fixture();
    expect(store.commandStates("dev_001", "loc_002")).toEqual([]);
    expect(store.commandState("dev_001", "loc_002", "identifier_main", "identifier_level", "level")).toBeUndefined();
    expect(store.commandState("dev_001", "loc_001", "identifier_other", "identifier_level", "level")).toBeUndefined();
    expect(store.commandState("dev_001", "loc_001", "identifier_main", "identifier_other", "level")).toBeUndefined();
  });
  test("an offline or moved device is not a confirmation source", () => {
    const store = fixture();
    store.observeAdvancedDeviceSnapshot({ items: [{ ...row(), health: { state: "OFFLINE", updatedAt: "2026-09-07T01:00:00Z" } }] });
    expect(exact(store)).toBeUndefined();
    expect(store.commandStates("dev_001", "loc_001")).toEqual([]);
    store.observeAdvancedDeviceSnapshot({ items: [{ ...row("dev_001", "loc_002"), health: { state: "ONLINE", updatedAt: "2026-09-07T02:00:00Z" } }] });
    expect(exact(store)).toBeUndefined();
    expect(store.commandStates("dev_001", "loc_002")).not.toEqual([]);
  });
  test("many unrelated devices do not require building a whole-inventory snapshot", () => {
    const store = fixture();
    store.observeAdvancedDeviceSnapshot({ items: Array.from({ length: 228 }, (_, index) => row(`dev_${index + 100}`)) });
    const snapshot = vi.spyOn(store, "snapshot");
    for (let index = 0; index < 100; index += 1) {
      expect(exact(store)?.value).toBe(50);
      expect(store.commandStates("dev_001", "loc_001").length).toBe(2);
    }
    expect(snapshot).not.toHaveBeenCalled();
  });
});
