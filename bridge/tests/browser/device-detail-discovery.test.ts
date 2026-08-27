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

  test("does not consume a discovery attempt when foreground control preempts it", async () => {
    const inspectDeviceDetails = vi.fn(async () => {
      throw new Error("detail_discovery_preempted");
    });
    const discovery = new DeviceDetailDiscovery({
      inventory: () => inventory(),
      inspector: { inspectDeviceDetails },
      canInspect: () => true,
      maxAttempts: 1
    });

    expect(await discovery.runOne()).toBe("blocked");
    expect(await discovery.runOne()).toBe("blocked");
    expect(inspectDeviceDetails).toHaveBeenCalledTimes(2);
  });

  test("requests a longer detail settle window for camera image devices", async () => {
    const inspectDeviceDetails = vi.fn(async () => undefined);
    const discovery = new DeviceDetailDiscovery({
      inventory: () => cameraInventory(),
      inspector: { inspectDeviceDetails },
      canInspect: () => true
    });

    expect(await discovery.runOne()).toBe("inspected");
    expect(inspectDeviceDetails).toHaveBeenCalledWith({
      deviceName: "Home camera",
      locationId: "loc_001",
      locationNames: { loc_001: "Home" },
      detailSettleMs: 5_000
    });
  });

  test("does not treat stray image attributes on a window sensor as a camera", async () => {
    const inspectDeviceDetails = vi.fn(async () => undefined);
    const discovery = new DeviceDetailDiscovery({
      inventory: () => windowSensorInventory(),
      inspector: { inspectDeviceDetails },
      canInspect: () => true
    });

    expect(await discovery.runOne()).toBe("inspected");
    expect(inspectDeviceDetails).toHaveBeenCalledWith({
      deviceName: "거실창문센서",
      locationId: "loc_001",
      locationNames: { loc_001: "Home" }
    });
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

function cameraInventory(): BridgeInventory {
  return {
    schemaVersion: 1,
    sequence: 1,
    locations: [{ id: "loc_001", name: "Home" }],
    rooms: [],
    devices: [
      {
        id: "dev_camera",
        locationId: "loc_001",
        roomId: null,
        name: "Home camera",
        type: null,
        online: true,
        states: [
          {
            component: "main",
            capability: "videoCapture",
            attribute: "image",
            value: null,
            unit: null,
            updatedAt: null
          }
        ],
        controls: [
          {
            id: "sound",
            kind: "toggle",
            label: "Sound",
            component: "main",
            capability: "soundDetection",
            attribute: "sound"
          }
        ]
      }
    ],
    scenes: []
  };
}

function windowSensorInventory(): BridgeInventory {
  return {
    schemaVersion: 1,
    sequence: 1,
    locations: [{ id: "loc_001", name: "Home" }],
    rooms: [],
    devices: [
      {
        id: "dev_window",
        locationId: "loc_001",
        roomId: null,
        name: "거실창문센서",
        type: "custom_window_h",
        online: true,
        presentation: { assetType: "custom_window_h" },
        states: [
          {
            component: "main",
            capability: "contactSensor",
            attribute: "contact",
            value: "closed",
            unit: null,
            updatedAt: "2026-08-25T02:11:34Z"
          },
          {
            component: "main",
            capability: "imageCapture",
            attribute: "imageTransferProgress",
            value: 100,
            unit: "%",
            updatedAt: "2026-04-01T11:28:55Z"
          }
        ]
      }
    ],
    scenes: []
  };
}
