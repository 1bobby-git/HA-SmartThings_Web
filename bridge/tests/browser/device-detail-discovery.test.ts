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

  test("inspects devices that only have observed value controls", async () => {
    const inspectDeviceDetails = vi.fn(async () => undefined);
    const discovery = new DeviceDetailDiscovery({
      inventory: () => valueOnlyControlInventory(),
      inspector: { inspectDeviceDetails },
      canInspect: () => true
    });

    expect(await discovery.runOne()).toBe("inspected");
    expect(inspectDeviceDetails).toHaveBeenCalledWith({
      deviceName: "거실창문센서",
      locationId: "loc_001",
      locationNames: { loc_001: "Home" },
      roomName: "거실"
    });
  });

  test("inspects devices that already have actionable detail controls once per session", async () => {
    const inspectDeviceDetails = vi.fn(async () => undefined);
    const discovery = new DeviceDetailDiscovery({
      inventory: () => actionableControlInventory(),
      inspector: { inspectDeviceDetails },
      canInspect: () => true
    });

    expect(await discovery.runOne()).toBe("inspected");
    expect(await discovery.runOne()).toBe("idle");
    expect(inspectDeviceDetails).toHaveBeenCalledTimes(1);
    expect(inspectDeviceDetails).toHaveBeenCalledWith({
      deviceName: "거실창문센서",
      locationId: "loc_001",
      locationNames: { loc_001: "Home" },
      roomName: "거실"
    });
  });

  test("does not treat a refresh-only control as completed discovery", async () => {
    const inspectDeviceDetails = vi.fn(async () => undefined);
    const discovery = new DeviceDetailDiscovery({
      inventory: () => refreshOnlyControlInventory(),
      inspector: { inspectDeviceDetails },
      canInspect: () => true
    });

    expect(await discovery.runOne()).toBe("inspected");
    expect(await discovery.runOne()).toBe("inspected");
    expect(await discovery.runOne()).toBe("idle");
    expect(inspectDeviceDetails).toHaveBeenCalledTimes(2);
    expect(inspectDeviceDetails).toHaveBeenNthCalledWith(1, {
      deviceName: "Galaxy Home Mini",
      locationId: "loc_001",
      locationNames: { loc_001: "Home" }
    });
  });

  test("prioritizes refresh-worthy value-only devices over generic undiscovered devices", async () => {
    const inspectDeviceDetails = vi.fn(async () => undefined);
    const discovery = new DeviceDetailDiscovery({
      inventory: () => mixedDiscoveryPriorityInventory(),
      inspector: { inspectDeviceDetails },
      canInspect: () => true
    });

    expect(await discovery.runOne()).toBe("inspected");
    expect(inspectDeviceDetails).toHaveBeenCalledWith({
      deviceName: "거실창문센서",
      locationId: "loc_001",
      locationNames: { loc_001: "Home" },
      roomName: "거실"
    });
  });

  test("prioritizes complete contact battery signal metrics devices first", async () => {
    const inspectDeviceDetails = vi.fn(async () => undefined);
    const discovery = new DeviceDetailDiscovery({
      inventory: () => tieredRefreshPriorityInventory(),
      inspector: { inspectDeviceDetails },
      canInspect: () => true
    });

    expect(await discovery.runOne()).toBe("inspected");
    expect(inspectDeviceDetails).toHaveBeenCalledWith({
      deviceName: "거실창문센서",
      locationId: "loc_001",
      locationNames: { loc_001: "Home" },
      roomName: "거실"
    });
  });

  test("prioritizes camera image devices before the general detail sweep", async () => {
    const inspected: string[] = [];
    const inspectDeviceDetails = vi.fn(async ({ deviceName }: { deviceName: string }) => {
      inspected.push(deviceName);
    });
    const discovery = new DeviceDetailDiscovery({
      inventory: () => valueThenCameraInventory(),
      inspector: { inspectDeviceDetails },
      canInspect: () => true,
      maxAttempts: 1
    });

    expect(await discovery.runOne()).toBe("inspected");
    expect(await discovery.runOne()).toBe("inspected");
    expect(inspected).toEqual(["Home camera", "거실창문센서"]);
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
      inventory: () => undiscoveredOnlyInventory(),
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

  test("enforces max attempts for the per-session detail sweep", async () => {
    const inspectDeviceDetails = vi.fn(async () => undefined);
    const discovery = new DeviceDetailDiscovery({
      inventory: () => actionableControlInventory(),
      inspector: { inspectDeviceDetails },
      canInspect: () => true,
      maxAttempts: 1
    });

    expect(await discovery.runOne()).toBe("inspected");
    expect(await discovery.runOne()).toBe("idle");
    expect(inspectDeviceDetails).toHaveBeenCalledTimes(1);
  });

  test("exposes sanitized failure diagnostics for runtime logs", async () => {
    const discovery = new DeviceDetailDiscovery({
      inventory: () => inventory(),
      inspector: {
        inspectDeviceDetails: vi.fn(async () => {
          throw new Error("not_found");
        })
      },
      canInspect: () => true,
      maxAttempts: 1
    });

    expect(await discovery.runOne()).toBe("failed");

    expect(discovery.lastFailure()).toEqual({
      deviceId: "dev_001",
      reason: "not_found"
    });
  });

  test("redacts unsafe detail discovery failure messages", async () => {
    const discovery = new DeviceDetailDiscovery({
      inventory: () => inventory(),
      inspector: {
        inspectDeviceDetails: vi.fn(async () => {
          throw new Error("token=raw-secret");
        })
      },
      canInspect: () => true,
      maxAttempts: 1
    });

    expect(await discovery.runOne()).toBe("failed");

    expect(discovery.lastFailure()).toEqual({
      deviceId: "dev_001",
      reason: "detail_discovery_error"
    });
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
    const rawImageUrl =
      "https://mediaserv.media1203.ec2.st-av.net/image?source_id=raw-camera&image_id=raw-still";
    const discovery = new DeviceDetailDiscovery({
      inventory: () => cameraInventory(),
      inspector: { inspectDeviceDetails },
      canInspect: () => true,
      resolveCameraImageUrl: (deviceId) =>
        deviceId === "dev_camera" ? rawImageUrl : undefined
    });

    expect(await discovery.runOne()).toBe("inspected");
    expect(inspectDeviceDetails).toHaveBeenCalledWith({
      deviceName: "Home camera",
      locationId: "loc_001",
      locationNames: { loc_001: "Home" },
      detailSettleMs: 5_000,
      cameraImageUrl: rawImageUrl
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
            value:
              "https://mediaserv.media1203.ec2.st-av.net/image?source_id=camera&image_id=still",
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

function valueOnlyControlInventory(): BridgeInventory {
  return {
    schemaVersion: 1,
    sequence: 1,
    locations: [{ id: "loc_001", name: "Home" }],
    rooms: [{ id: "identifier_living", locationId: "loc_001", name: "거실" }],
    devices: [
      {
        id: "dev_window",
        locationId: "loc_001",
        roomId: "identifier_living",
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
            capability: "battery",
            attribute: "battery",
            value: 91,
            unit: "%",
            updatedAt: "2026-04-01T17:21:43Z"
          },
          {
            component: "legendabsolute60149",
            capability: "legendabsolute60149.signalMetrics",
            attribute: "signalMetrics",
            value: "KST-9: 2026/04/01 11:28 LQI: 184  RSSI: -95dbm",
            unit: null,
            updatedAt: "2026-04-01T11:28:55Z"
          }
        ],
        controls: [
          {
            id: "contact",
            kind: "value",
            label: "Contact sensor",
            component: "main",
            capability: "contactSensor",
            attribute: "contact"
          },
          {
            id: "battery",
            kind: "value",
            label: "Battery",
            component: "main",
            capability: "battery",
            attribute: "battery"
          },
          {
            id: "signalMetrics",
            kind: "value",
            label: "Received Signal Metrics",
            component: "legendabsolute60149",
            capability: "legendabsolute60149.signalMetrics",
            attribute: "signalMetrics"
          }
        ]
      }
    ],
    scenes: []
  };
}

function actionableControlInventory(): BridgeInventory {
  const inventory = valueOnlyControlInventory();
  return {
    ...inventory,
    devices: inventory.devices.map((device) => ({
      ...device,
      controls: [
        ...(device.controls ?? []),
        {
          id: "switch",
          kind: "toggle" as const,
          label: "Power",
          component: "main",
          capability: "switch",
          attribute: "switch",
          command: "on"
        }
      ]
    }))
  };
}

function undiscoveredOnlyInventory(): BridgeInventory {
  return {
    ...inventory(),
    devices: [inventory().devices[0]!]
  };
}

function refreshOnlyControlInventory(): BridgeInventory {
  return {
    schemaVersion: 1,
    sequence: 1,
    locations: [{ id: "loc_001", name: "Home" }],
    rooms: [],
    devices: [
      {
        id: "dev_203",
        locationId: "loc_001",
        roomId: null,
        name: "Galaxy Home Mini",
        type: "speaker",
        online: true,
        states: Array.from({ length: 50 }, (_, index) => ({
          component: "main",
          capability: `capability_${index}`,
          attribute: `attribute_${index}`,
          value: index,
          unit: null,
          updatedAt: "2026-08-28T00:00:00Z"
        })),
        controls: [
          {
            id: "refresh",
            kind: "button",
            label: "Refresh",
            component: "main",
            capability: "refresh",
            attribute: "refresh",
            command: "refresh"
          }
        ]
      }
    ],
    scenes: []
  };
}

function mixedDiscoveryPriorityInventory(): BridgeInventory {
  const valueOnly = valueOnlyControlInventory();
  return {
    ...valueOnly,
    devices: [
      {
        id: "dev_generic",
        locationId: "loc_001",
        roomId: null,
        name: "Generic undiscovered",
        type: null,
        online: true,
        states: []
      },
      ...valueOnly.devices
    ]
  };
}

function tieredRefreshPriorityInventory(): BridgeInventory {
  const valueOnly = valueOnlyControlInventory();
  return {
    ...valueOnly,
    devices: [
      {
        id: "dev_contact_only",
        locationId: "loc_001",
        roomId: null,
        name: "Contact only",
        type: "contact_sensor",
        online: true,
        states: [
          {
            component: "main",
            capability: "contactSensor",
            attribute: "contact",
            value: "closed",
            unit: null,
            updatedAt: "2026-08-25T02:11:34Z"
          }
        ],
        controls: [
          {
            id: "contact",
            kind: "value",
            label: "Contact sensor",
            component: "main",
            capability: "contactSensor",
            attribute: "contact"
          }
        ]
      },
      {
        id: "dev_signal_only",
        locationId: "loc_001",
        roomId: null,
        name: "Signal only",
        type: "signal_sensor",
        online: true,
        states: [
          {
            component: "legendabsolute60149",
            capability: "legendabsolute60149.signalMetrics",
            attribute: "signalMetrics",
            value: "KST-9: 2026/04/01 11:28 LQI: 184  RSSI: -95dbm",
            unit: null,
            updatedAt: "2026-04-01T11:28:55Z"
          }
        ],
        controls: [
          {
            id: "signalMetrics",
            kind: "value",
            label: "Received Signal Metrics",
            component: "legendabsolute60149",
            capability: "legendabsolute60149.signalMetrics",
            attribute: "signalMetrics"
          }
        ]
      },
      ...valueOnly.devices
    ]
  };
}

function valueThenCameraInventory(): BridgeInventory {
  const valueOnly = valueOnlyControlInventory();
  const camera = cameraInventory();
  return {
    ...valueOnly,
    devices: [...camera.devices, ...valueOnly.devices]
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
