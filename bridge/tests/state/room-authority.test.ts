import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "../../src/state/device-store.js";
import type { SanitizedCaptureRecord } from "../../src/state/capture-store.js";

const room = { roomId: "identifier_room", locationId: "loc_001", name: "Room Two" };
const device = { deviceId: "dev_001", locationId: "loc_001", label: "Counter", roomId: room.roomId };
function advanced(store: DeviceStore, overrides: Record<string, unknown> = {}): void {
  store.observeAdvancedInventorySnapshot({ locations: [], rooms: [room], devices: [{ ...device, ...overrides }] });
}
function web(store: DeviceStore, query: string, rows: unknown[]): void {
  const frame = (direction: "sent" | "received", text: string): SanitizedCaptureRecord => ({
    __sanitized: true, source: "playwright-websocket-frame", receivedAt: "2026-09-07T00:00:00.000Z",
    payload: { direction, frame: { payload: text, truncated: false } }, payloadHash: "fixture"
  });
  store.observe(frame("sent", `424${JSON.stringify(["find", query, {}])}`));
  store.observe(frame("received", `434${JSON.stringify([null, rows])}`));
}
function webDevice(store: DeviceStore, overrides: Record<string, unknown> = {}): void {
  web(store, "api/device", [{ basic: { ...device, deviceName: device.label, ...overrides } }]);
}

describe("room topology provenance", () => {
  test("Advanced wins regardless of consumer/Advanced response order", () => {
    for (const webFirst of [true, false]) {
      const store = new DeviceStore();
      if (webFirst) webDevice(store, { roomId: "identifier_old" });
      advanced(store);
      if (!webFirst) webDevice(store, { roomId: "identifier_old" });
      expect(store.snapshot().devices[0]).toMatchObject({ roomId: room.roomId, roomSource: "advanced" });
      store.close();
    }
  });

  test("consumer room names cannot overwrite observed Advanced room names", () => {
    const store = new DeviceStore(); advanced(store);
    web(store, "api/room", [{ ...room, name: "Stale Room" }]);
    expect(store.snapshot().rooms[0]?.name).toBe("Room Two"); store.close();
  });

  test.each([undefined, "", 42, "not a valid id"])("malformed Advanced room %s is not a removal", (roomId) => {
    const store = new DeviceStore(); advanced(store);
    store.observeAdvancedDeviceSnapshot([{ ...device, roomId }]);
    expect(store.snapshot().devices[0]).toMatchObject({ roomId: room.roomId, roomSource: "advanced" }); store.close();
  });

  test("an omitted Advanced room field preserves the binding", () => {
    const store = new DeviceStore(); advanced(store);
    store.observeAdvancedDeviceSnapshot([{ deviceId: device.deviceId, locationId: device.locationId }]);
    expect(store.snapshot().devices[0]).toMatchObject({ roomId: room.roomId, roomSource: "advanced" }); store.close();
  });

  test("explicit null wins over snake-case fallback and stale consumer binding", () => {
    const store = new DeviceStore(); advanced(store);
    store.observeAdvancedDeviceSnapshot([{ ...device, roomId: null, room_id: room.roomId }]);
    webDevice(store);
    expect(store.snapshot().devices[0]).toMatchObject({ roomId: null, roomSource: "advanced" }); store.close();
  });

  test("snake-case room ids are normalized normally", () => {
    const store = new DeviceStore();
    store.observeAdvancedInventorySnapshot({ locations: [], rooms: [room], devices: [
      { deviceId: device.deviceId, locationId: device.locationId, room_id: room.roomId }
    ] });
    expect(store.snapshot().devices[0]).toMatchObject({ roomId: room.roomId, roomSource: "advanced" }); store.close();
  });

  test("room list and device binding both need fresh evidence", () => {
    const store = new DeviceStore();
    web(store, "api/room", [room]);
    store.observeAdvancedDeviceSnapshot([device]);
    expect(store.snapshot().devices[0]).not.toHaveProperty("roomSource");
    const before = store.currentSequence();
    store.observeAdvancedInventorySnapshot({ locations: [], rooms: [room], devices: [] });
    expect(store.currentSequence()).toBeGreaterThan(before);
    expect(store.snapshot().devices[0]?.roomSource).toBe("advanced"); store.close();
  });

  test("room ownership mismatch is not confirmed", () => {
    const store = new DeviceStore();
    store.observeAdvancedInventorySnapshot({ locations: [], rooms: [{ ...room, locationId: "loc_002" }], devices: [device] });
    expect(store.snapshot().devices[0]).not.toHaveProperty("roomSource"); store.close();
  });

  test("consumer cards cannot move an Advanced-bound device to another location", () => {
    const store = new DeviceStore(); advanced(store);
    webDevice(store, { locationId: "loc_002", roomId: "identifier_other" });
    expect(store.snapshot().devices[0]).toMatchObject({ locationId: "loc_001", roomId: room.roomId }); store.close();
  });

  test("an Advanced location move cannot inherit an old room", () => {
    const store = new DeviceStore(); advanced(store);
    store.observeAdvancedDeviceSnapshot([{ deviceId: device.deviceId, locationId: "loc_002" }]);
    expect(store.snapshot().devices[0]).toMatchObject({ locationId: "loc_002", roomId: null });
    expect(store.snapshot().devices[0]).not.toHaveProperty("roomSource"); store.close();
  });

  test("reset invalidates topology evidence and allows fresh consumer fallback", () => {
    const store = new DeviceStore(); advanced(store);
    const before = store.currentSequence(); store.resetSnapshotSession();
    expect(store.currentSequence()).toBeGreaterThan(before);
    expect(store.snapshot().devices[0]).not.toHaveProperty("roomSource");
    webDevice(store, { roomId: "identifier_other" });
    expect(store.snapshot().devices[0]?.roomId).toBe("identifier_other"); store.close();
  });

  test("persisted topology must be re-observed after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "room-proof-"));
    try {
      const options = { sqlitePath: join(directory, "inventory.sqlite") };
      let store = new DeviceStore(options); advanced(store); store.close();
      store = new DeviceStore(options);
      expect(store.snapshot().devices[0]).not.toHaveProperty("roomSource");
      store.observeAdvancedDeviceSnapshot([device]);
      expect(store.snapshot().devices[0]).not.toHaveProperty("roomSource");
      advanced(store);
      expect(store.snapshot().devices[0]?.roomSource).toBe("advanced"); store.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
