import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "../../src/state/device-store.js";

const device = {
  deviceId: "dev_001", locationId: "loc_001", roomId: "identifier_room", ownerId: "identifier_owner",
  label: "Counter", deviceType: "motion_sensor_1",
  components: [{ id: "identifier_main", categories: [{ name: "PresenceSensor" }], capabilities: [] }]
};

describe("Advanced functional categories", () => {
  test("retains the explicit category rather than reinterpreting the motion icon", () => {
    const store = new DeviceStore();
    store.observeAdvancedDeviceSnapshot({ items: [device] });
    expect(store.snapshot().devices[0]).toMatchObject({
      type: "motion_sensor_1", advanced: { sensorCategories: { identifier_main: ["PresenceSensor"] } }, states: []
    });
  });

  test("retains mobile presence separately and drops unrecognized free text", () => {
    const store = new DeviceStore();
    store.observeAdvancedDeviceSnapshot({ items: [{ ...device, components: [{ id: "identifier_main", categories: [
      { name: "MobilePresence" }, { name: "PresenceSensor" }, { name: "PresenceSensor" },
      { name: "private category text" }, { name: "MotionSensor", privateField: "not copied" }
    ] }] }] });
    expect(store.snapshot().devices[0]?.advanced?.sensorCategories).toEqual({
      identifier_main: ["MobilePresence", "MotionSensor", "PresenceSensor"]
    });
    expect(JSON.stringify(store.snapshot())).not.toContain("private");
  });

  test("does not add an empty category field to existing devices", () => {
    const store = new DeviceStore();
    store.observeAdvancedDeviceSnapshot({ items: [{ ...device, components: [] }] });
    expect(store.snapshot().devices[0]?.advanced).toEqual({ ownerId: "identifier_owner" });
  });

  test("returns independent category arrays and survives partial status updates", () => {
    const store = new DeviceStore();
    store.observeAdvancedDeviceSnapshot({ items: [device] });
    store.snapshot().devices[0]!.advanced!.sensorCategories!.identifier_main!.push("MotionSensor");
    store.observeAdvancedDeviceSnapshot({ items: [{ deviceId: "dev_001", locationId: "loc_001" }] });
    expect(store.snapshot().devices[0]?.advanced?.sensorCategories).toEqual({ identifier_main: ["PresenceSensor"] });
  });

  test("explicit component replacement clears previous categories without changing identity or room", () => {
    const store = new DeviceStore();
    store.observeAdvancedDeviceSnapshot({ items: [device] });
    store.observeAdvancedDeviceSnapshot({ items: [{ deviceId: "dev_001", locationId: "loc_001", components: [] }] });
    expect(store.snapshot().devices[0]).toMatchObject({ id: "dev_001", roomId: "identifier_room", advanced: { ownerId: "identifier_owner" } });
    expect(store.snapshot().devices[0]?.advanced?.sensorCategories).toBeUndefined();
  });

  test("duplicate components are ambiguous rather than last-match-wins", () => {
    const store = new DeviceStore();
    store.observeAdvancedDeviceSnapshot({ items: [{ ...device, components: [device.components[0],
      { id: "identifier_main", categories: [{ name: "MotionSensor" }] }] }] });
    expect(store.snapshot().devices[0]?.advanced?.sensorCategories).toBeUndefined();
  });

  test("normalizes component identifiers through the existing alias function", () => {
    const store = new DeviceStore({ normalizeAdvancedAlias: (_kind, value) => value === "main" ? "identifier_main" : value });
    store.observeAdvancedDeviceSnapshot({ items: [{ ...device, components: [{ ...device.components[0], id: "main" }] }] });
    expect(store.snapshot().devices[0]?.advanced?.sensorCategories).toEqual({ identifier_main: ["PresenceSensor"] });
  });

  test("persists only validated categories and never restores room proof from cache", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-categories-"));
    let first: DeviceStore | undefined;
    let second: DeviceStore | undefined;
    try {
      const sqlitePath = join(root, "inventory.sqlite");
      first = new DeviceStore({ sqlitePath });
      first.observeAdvancedInventorySnapshot({ locations: [{ locationId: "loc_001", name: "Home" }],
        rooms: [{ roomId: "identifier_room", locationId: "loc_001", name: "Room" }], devices: [device] });
      expect(first.snapshot().devices[0]?.roomSource).toBe("advanced");
      first.close(); first = undefined;
      second = new DeviceStore({ sqlitePath });
      expect(second.snapshot().devices[0]?.advanced?.sensorCategories).toEqual({ identifier_main: ["PresenceSensor"] });
      expect(second.snapshot().devices[0]?.roomSource).toBeUndefined();
    } finally {
      first?.close(); second?.close(); rmSync(root, { recursive: true, force: true });
    }
  });
});
