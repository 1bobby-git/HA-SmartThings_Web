import { describe, expect, test, vi } from "vitest";

import { DeviceDetailDiscovery } from "../../src/browser/device-detail-discovery.js";
import type { BridgeInventory } from "../../src/state/device-store.js";

describe("DeviceDetailDiscovery", () => {
  test("inspects only devices whose detail controls have not been observed", async () => {
    const inspectDeviceDetails = vi.fn(async () => undefined);
    const discovery = new DeviceDetailDiscovery({
      inventory: () => inventory(),
      inspector: { inspectDeviceDetails },
      canInspect: () => true
    });

    expect(await discovery.runOne()).toBe("inspected");
    expect(inspectDeviceDetails).toHaveBeenCalledWith({
      deviceName: "Sensor",
      locationId: "loc_001",
      locationNames: { loc_001: "Home" },
      roomName: "Living room"
    });
  });

  test("pauses while runtime or the physical-action probe forbids extra pages", async () => {
    const inspectDeviceDetails = vi.fn(async () => undefined);
    const discovery = new DeviceDetailDiscovery({
      inventory: () => inventory(),
      inspector: { inspectDeviceDetails },
      canInspect: () => false
    });

    expect(await discovery.runOne()).toBe("blocked");
    expect(inspectDeviceDetails).not.toHaveBeenCalled();
  });

  test("bounds failed discovery attempts until the browser context is reset", async () => {
    const inspectDeviceDetails = vi.fn(async () => {
      throw new Error("not_found");
    });
    const discovery = new DeviceDetailDiscovery({
      inventory: () => inventory(),
      inspector: { inspectDeviceDetails },
      canInspect: () => true,
      maxAttempts: 2
    });

    expect(await discovery.runOne()).toBe("failed");
    expect(await discovery.runOne()).toBe("failed");
    expect(await discovery.runOne()).toBe("idle");
    discovery.reset();
    expect(await discovery.runOne()).toBe("failed");
  });
});

function inventory(): BridgeInventory {
  return {
    schemaVersion: 1,
    sequence: 1,
    locations: [{ id: "loc_001", name: "Home" }],
    rooms: [{ id: "identifier_room", locationId: "loc_001", name: "Living room" }],
    devices: [
      {
        id: "dev_001",
        locationId: "loc_001",
        roomId: "identifier_room",
        name: "Sensor",
        type: null,
        online: true,
        states: []
      },
      {
        id: "dev_002",
        locationId: "loc_001",
        roomId: null,
        name: "Known control",
        type: null,
        online: true,
        states: [],
        controls: [
          {
            id: "control",
            kind: "button",
            label: "Refresh",
            component: "main",
            capability: "refresh",
            attribute: "refresh"
          }
        ]
      }
    ],
    scenes: []
  };
}
