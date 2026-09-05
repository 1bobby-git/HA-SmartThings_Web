import { describe, expect, test, vi } from "vitest";
import { DeviceStore } from "../../src/state/device-store.js";
import { normalizeLocationArmState } from "../../src/state/location-arm-state.js";

function frame(store: DeviceStore, direction: "sent" | "received", text: string) {
  store.observe({ __sanitized: true, source: "playwright-websocket-frame", receivedAt: new Date().toISOString(),
    payload: { direction, frame: { payload: text, truncated: false } }, payloadHash: `${direction}:${text}` });
}
function snapshot(store: DeviceStore, value: object) {
  frame(store, "sent", '4225["find","api/location",{}]');
  frame(store, "received", `4325${JSON.stringify([null, [value]])}`);
}
function initial() {
  const store = new DeviceStore();
  snapshot(store, { locationId: "loc_001", name: "Office", armState: "AWAY", updatedAt: "2026-09-01T00:00:03Z" });
  return store;
}

describe("Home Monitor authoritative state retention", () => {
  test("metadata-only Advanced resync does not erase security status or repeatedly publish inventory", () => {
    const store = initial();
    const events = vi.fn(); store.subscribe(events);
    const before = store.currentSequence();
    for (let i = 0; i < 100; i++) {
      store.observeAdvancedInventorySnapshot({ locations: [{ locationId: "loc_001", name: "Office" }], rooms: [], devices: [] });
    }
    expect(store.location("loc_001")).toEqual({ id: "loc_001", name: "Office", armState: "AWAY", updatedAt: "2026-09-01T00:00:03Z" });
    expect(store.currentSequence()).toBe(before);
    expect(events).not.toHaveBeenCalled();
  });
  test("metadata-only Web snapshots can rename a location without losing security evidence", () => {
    const store = initial();
    snapshot(store, { locationId: "loc_001", name: "Renamed office" });
    expect(store.location("loc_001")).toMatchObject({ name: "Renamed office", armState: "AWAY", updatedAt: "2026-09-01T00:00:03Z" });
  });
  test.each([undefined, "2026-09-01T00:00:01Z", "2026-09-01T00:00:03Z"])("rejects undated/stale contradictory snapshots (%s)", (updatedAt) => {
    const store = initial();
    snapshot(store, { locationId: "loc_001", name: "Office", armState: "DISARMED", updatedAt });
    expect(store.location("loc_001")?.armState).toBe("AWAY");
  });
  test("accepts a newer Web security snapshot", () => {
    const store = initial();
    snapshot(store, { locationId: "loc_001", name: "Office", armState: "STAY", updatedAt: "2026-09-01T00:00:04Z" });
    expect(store.location("loc_001")?.armState).toBe("STAY");
  });
  test("returns defensive small location copies", () => {
    const store = initial(); const value = store.location("loc_001")!; value.armState = "OFF";
    expect(store.location("loc_001")?.armState).toBe("AWAY");
    expect(store.location("loc_missing")).toBeUndefined();
  });
  test("targeted reads reject wrong locations, unsupported modes and older contradictory status", () => {
    const store = initial();
    for (const row of [
      { locationId: "loc_002", armState: "STAY" },
      { locationId: "loc_001", armState: "ARMING" },
      { locationId: "loc_001", armState: "OFF", updatedAt: "2026-09-01T00:00:02Z" },
      { locationId: "loc_001", armState: "OFF" }
    ]) expect(store.observeLocationStatusSnapshot(row, "loc_001")).toBe(false);
    expect(store.location("loc_001")?.armState).toBe("AWAY");
  });
  test("fresh targeted status updates only the named existing location", () => {
    const store = initial();
    expect(store.observeLocationStatusSnapshot({ id: "loc_001", arm_state: "OFF", updatedAt: "2026-09-01T00:00:04Z" }, "loc_001")).toBe(true);
    expect(store.location("loc_001")?.armState).toBe("OFF");
    expect(store.location("loc_001")?.name).toBe("Office");
  });
  test.each([
    ["AWAY", "ARMED_AWAY"], ["armedaway", "ARMED_AWAY"], ["armed_away", "ARMED_AWAY"],
    ["STAY", "ARMED_STAY"], ["armed_home", "ARMED_STAY"], ["armed_stay", "ARMED_STAY"],
    ["armedstay", "ARMED_STAY"], ["OFF", "DISARMED"], ["disarmed", "DISARMED"]
  ])("normalizes HA-supported %s only for comparison", (raw, expected) => {
    expect(normalizeLocationArmState(raw)).toBe(expected);
  });
  test.each(["ARMING", "PENDING", "HOME", "ON", "", undefined, true, 1])("never invents completed security state from %s", (raw) => {
    expect(normalizeLocationArmState(raw)).toBeUndefined();
  });
});
