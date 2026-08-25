import { describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { SanitizedCaptureRecord } from "../../src/state/capture-store.js";
import { DeviceStore } from "../../src/state/device-store.js";

describe("DeviceStore", () => {
  test("applies a live event with an omitted component and epoch-millisecond timestamp", () => {
    const store = new DeviceStore();
    observeSnapshotState(store, {
      componentId: "identifier_component_main",
      capabilityId: "identifier_capability_humidity",
      attributeName: "humidity",
      value: 58.5,
      unit: "%",
      timestamp: "2026-08-24T21:16:13.000Z"
    });
    const listener = vi.fn();
    store.subscribe(listener);

    store.observe(
      receivedFrame(
        `42${JSON.stringify([
          "api/subscription DEVICE_EVENT",
          {
            data: {
              event_type: "DEVICE_EVENT",
              device_event: {
                device_id: "dev_001",
                location_id: "loc_001",
                component: null,
                capability: "identifier_capability_humidity",
                attribute: "humidity",
                value: 62.8,
                unit: "%",
                event_time: Date.parse("2026-08-24T21:34:27.656Z")
              }
            }
          }
        ])}`
      )
    );

    expect(store.snapshot()).toMatchObject({
      sequence: 2,
      devices: [
        {
          states: [
            {
              component: "identifier_component_main",
              capability: "identifier_capability_humidity",
              attribute: "humidity",
              value: 62.8,
              updatedAt: "2026-08-24T21:34:27.656Z"
            }
          ]
        }
      ]
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: "state", sequence: 2, deviceId: "dev_001" })
    );
  });

  test("uses capability and attribute to resolve an omitted component without touching siblings", () => {
    const aliases: Record<string, string> = {
      main: "identifier_component_main",
      switch: "identifier_capability_switch"
    };
    const store = new DeviceStore({ normalizeStateToken: (value) => aliases[value] ?? value });
    observeSnapshotState(store, {
      componentId: "identifier_component_main",
      capabilityId: "identifier_capability_switch",
      attributeName: "switch",
      value: "off",
      timestamp: "2026-08-24T21:00:00.000Z"
    });
    observeSnapshotState(store, {
      componentId: "identifier_component_secondary",
      capabilityId: "identifier_capability_switch",
      attributeName: "switch",
      value: "on",
      timestamp: "2026-08-24T21:00:00.000Z"
    });

    store.observe(
      liveStateEvent({
        capability: "switch",
        attribute: "switch",
        value: "on",
        event_time: Date.parse("2026-08-24T21:01:00.000Z")
      })
    );

    expect(store.snapshot().devices[0]?.states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          component: "identifier_component_secondary",
          capability: "identifier_capability_switch",
          value: "on"
        }),
        expect.objectContaining({
          component: "identifier_component_main",
          capability: "identifier_capability_switch",
          value: "on"
        })
      ])
    );
  });

  test("rejects an older event so it cannot overwrite a newer snapshot value", () => {
    const store = new DeviceStore();
    observeSnapshotState(store, {
      componentId: "identifier_component_main",
      capabilityId: "identifier_capability_power",
      attributeName: "power",
      value: 1527,
      unit: "W",
      timestamp: "2026-08-24T21:15:53.000Z"
    });
    const listener = vi.fn();
    store.subscribe(listener);

    store.observe(
      liveStateEvent({
        capability: "identifier_capability_power",
        attribute: "power",
        value: 0,
        unit: "W",
        event_time: Date.parse("2026-08-24T21:15:52.000Z")
      })
    );

    expect(store.snapshot()).toMatchObject({
      sequence: 1,
      devices: [{ states: [expect.objectContaining({ value: 1527 })] }]
    });
    expect(listener).not.toHaveBeenCalled();
  });

  test("rejects a live event without a valid updated timestamp", () => {
    const store = new DeviceStore();
    observeSnapshotState(store, {
      componentId: "identifier_component_main",
      capabilityId: "identifier_capability_power",
      attributeName: "power",
      value: 10,
      unit: "W",
      timestamp: "not-a-timestamp"
    });
    const listener = vi.fn();
    store.subscribe(listener);

    store.observe(
      liveStateEvent({
        capability: "identifier_capability_power",
        attribute: "power",
        value: 20,
        unit: "W",
        event_time: "not-a-timestamp"
      })
    );

    expect(store.snapshot()).toMatchObject({
      sequence: 1,
      devices: [{ states: [expect.objectContaining({ value: 10, updatedAt: null })] }]
    });
    expect(listener).not.toHaveBeenCalled();
  });

  test("restores the normalized inventory and sequence after a Bridge restart", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-device-store-"));
    try {
      const sqlitePath = join(root, "bridge.sqlite");
      const first = new DeviceStore({ sqlitePath });
      observeSnapshotState(first, {
        componentId: "identifier_component_main",
        capabilityId: "identifier_capability_contact",
        attributeName: "contact",
        value: "closed",
        timestamp: "2026-08-24T21:00:00.000Z"
      });
      const beforeRestart = first.snapshot();
      first.close();

      const restored = new DeviceStore({ sqlitePath });
      expect(restored.snapshot()).toEqual(beforeRestart);
      restored.reset();
      expect(restored.snapshot()).toEqual(beforeRestart);

      restored.observe(
        liveStateEvent({
          capability: "identifier_capability_contact",
          attribute: "contact",
          value: "open",
          event_time: Date.parse("2026-08-24T20:59:59.000Z")
        })
      );
      expect(restored.snapshot()).toEqual(beforeRestart);
      restored.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows may release node:sqlite file handles after the assertion completes.
      }
    }
  });

  test("captures scenes and location arm state from snapshots", () => {
    const store = new DeviceStore();
    const listener = vi.fn();
    store.subscribe(listener);

    observeLocationSnapshot(store, {
      locationId: "loc_001",
      name: "Home",
      armState: "STAY",
      updatedAt: "2026-08-24T21:00:00.000Z"
    });
    observeSceneSnapshot(store, {
      sceneId: "identifier_scenegoodnight",
      locationId: "loc_001",
      name: "Good night",
      updatedAt: "2026-08-24T21:01:00.000Z"
    });

    expect(store.snapshot()).toMatchObject({
      sequence: 2,
      locations: [
        {
          id: "loc_001",
          name: "Home",
          armState: "STAY",
          updatedAt: "2026-08-24T21:00:00.000Z"
        }
      ],
      scenes: [
        {
          id: "identifier_scenegoodnight",
          locationId: "loc_001",
          name: "Good night",
          updatedAt: "2026-08-24T21:01:00.000Z"
        }
      ]
    });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "inventory", sequence: 2 })
    );
  });

  test("captures api/location get rows that expose id instead of locationId", () => {
    const store = new DeviceStore();

    observeLocationSnapshot(store, {
      id: "loc_001",
      name: "Home",
      armState: "DISARMED",
      updatedAt: "2026-08-24T21:00:00.000Z"
    });

    expect(store.snapshot().locations).toEqual([
      {
        id: "loc_001",
        name: "Home",
        armState: "DISARMED",
        updatedAt: "2026-08-24T21:00:00.000Z"
      }
    ]);
  });

  test("updates SmartThings Home Monitor arm state from security events", () => {
    const store = new DeviceStore();
    observeLocationSnapshot(store, {
      locationId: "loc_001",
      name: "Home",
      armState: "DISARMED",
      updatedAt: "2026-08-24T21:00:00.000Z"
    });
    const listener = vi.fn();
    store.subscribe(listener);

    store.observe(
      receivedFrame(
        `42${JSON.stringify([
          "api/subscription SECURITY_ARM_STATE_EVENT",
          {
            data: {
              location_id: "loc_001",
              arm_state: "AWAY",
              event_time: "2026-08-24T21:02:00.000Z"
            }
          }
        ])}`
      )
    );

    expect(store.snapshot().locations[0]).toMatchObject({
      id: "loc_001",
      armState: "AWAY",
      updatedAt: "2026-08-24T21:02:00.000Z"
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: "inventory", sequence: 2 })
    );
  });

  test("updates SmartThings Home Monitor from live securityArmStateEvent shape", () => {
    const store = new DeviceStore();
    observeLocationSnapshot(store, {
      locationId: "loc_001",
      name: "Home",
      armState: "DISARMED",
      updatedAt: "2026-08-24T21:00:00.000Z"
    });

    store.observe(
      receivedFrame(
        `42${JSON.stringify([
          "api/subscription SECURITY_ARM_STATE_EVENT",
          {
            data: {
              eventTime: Date.parse("2026-08-24T21:03:00.000Z"),
              securityArmStateEvent: {
                locationId: "loc_001",
                armState: "ARMED_AWAY",
                eventId: "identifier_event001",
                optionalArguments: {}
              }
            }
          }
        ])}`
      )
    );

    expect(store.snapshot().locations[0]).toMatchObject({
      armState: "ARMED_AWAY",
      updatedAt: "2026-08-24T21:03:00.000Z"
    });
  });

  test("rejects stale and malformed location security events", () => {
    const store = new DeviceStore();
    observeLocationSnapshot(store, {
      locationId: "loc_001",
      name: "Home",
      armState: "AWAY",
      updatedAt: "2026-08-24T21:02:00.000Z"
    });
    const listener = vi.fn();
    store.subscribe(listener);

    store.observe(
      receivedFrame(
        `42${JSON.stringify([
          "api/subscription SECURITY_ARM_STATE_EVENT",
          {
            data: {
              location_id: "loc_001",
              arm_state: "DISARMED",
              event_time: "2026-08-24T21:01:59.000Z"
            }
          }
        ])}`
      )
    );
    store.observe(
      receivedFrame(
        `42${JSON.stringify([
          "api/subscription SECURITY_ARM_STATE_EVENT",
          {
            data: {
              location_id: "loc_001",
              arm_state: "STAY",
              event_time: "not-a-time"
            }
          }
        ])}`
      )
    );
    store.observe(
      receivedFrame(
        `42${JSON.stringify([
          "api/subscription SECURITY_ARM_STATE_EVENT",
          {
            data: {
              location_id: "loc_001",
              arm_state: "DISARMED",
              event_time: "2026-08-24T21:03:00"
            }
          }
        ])}`
      )
    );

    expect(store.snapshot().locations[0]).toMatchObject({
      armState: "AWAY",
      updatedAt: "2026-08-24T21:02:00.000Z"
    });
    expect(listener).not.toHaveBeenCalled();
  });

  test("persists scenes and location arm state across restart", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-device-store-scenes-"));
    try {
      const sqlitePath = join(root, "bridge.sqlite");
      const first = new DeviceStore({ sqlitePath });
      observeLocationSnapshot(first, {
        locationId: "loc_001",
        name: "Home",
        armState: "STAY",
        updatedAt: "2026-08-24T21:00:00.000Z"
      });
      observeSceneSnapshot(first, {
        sceneId: "identifier_scenegoodnight",
        locationId: "loc_001",
        name: "Good night",
        updatedAt: "2026-08-24T21:01:00.000Z"
      });
      const beforeRestart = first.snapshot();
      first.close();

      const restored = new DeviceStore({ sqlitePath });

      expect(restored.snapshot()).toEqual(beforeRestart);
      restored.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows may release node:sqlite file handles after the assertion completes.
      }
    }
  });

  test("publishes an inventory marker for scene lifecycle events without leaking payload", () => {
    const store = new DeviceStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.observe(
      receivedFrame(
        `42${JSON.stringify([
          "api/subscription SCENE_LIFECYCLE_EVENT",
          {
            data: {
              opaque: "raw-value-that-must-not-be-copied"
            }
          }
        ])}`
      )
    );

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      schemaVersion: 1,
      sequence: 1,
      type: "inventory"
    });
    expect(JSON.stringify(store.snapshot())).not.toContain("raw-value-that-must-not-be-copied");
  });

  test("captures safe device detail swatch controls", () => {
    const store = new DeviceStore();
    const listener = vi.fn();
    store.subscribe(listener);

    observeDeviceDetails(store, [
      detailSwatch("TOGGLE", "toggle", {
        swatchId: "identifier_toggle001",
        label: "Power",
        onState: { command: "on" },
        offState: { command: "off" }
      }),
      detailSwatch("BUTTON", "button", {
        swatchId: "identifier_button001",
        label: "Refresh",
        command: "refresh"
      }),
      detailSwatch("SLIDER", "slider", {
        swatchId: "identifier_slider001",
        label: "Detection Frequency",
        min: 5,
        max: 120,
        step: 5,
        command: "setDetectionFrequency"
      }),
      detailSwatch("ENUMERATED", "enumerated", {
        swatchId: "identifier_enum001",
        label: "Fan Mode",
        options: ["auto", "중간 풍량", { label: "강" }, "[REDACTED]", "https://example.test/raw"]
      })
    ]);

    expect(store.snapshot().devices[0]?.controls).toEqual([
      expect.objectContaining({
        kind: "button",
        label: "Refresh",
        command: "refresh"
      }),
      expect.objectContaining({
        kind: "enumerated",
        options: ["auto", "중간 풍량", "강"]
      }),
      expect.objectContaining({
        kind: "slider",
        min: 5,
        max: 120,
        step: 5,
        command: "setDetectionFrequency"
      }),
      expect.objectContaining({
        kind: "toggle",
        label: "Power",
        commands: ["on", "off"]
      })
    ]);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: "inventory", sequence: 1 })
    );
  });

  test("captures enumerated possibleStates as status options with atomic label mappings", () => {
    const store = new DeviceStore();

    observeDeviceDetails(store, [
      detailSwatch("ENUMERATED", "enumerated", {
        swatchId: "identifier_enum001",
        label: "Mode",
        attributeName: "mode",
        possibleStates: [
          { status: "cool", label: "Cooling", command: "setCool" },
          { status: "windFree", label: "Wind free", command: "setMode" }
        ]
      }),
      detailSwatch("ENUMERATED", "enumerated", {
        swatchId: "identifier_enum002",
        label: "Broken duplicate",
        attributeName: "brokenMode",
        possibleStates: [
          { status: "cool", label: "Cooling", command: "setCool" },
          { status: "cool", label: "Cooling duplicate", command: "setCoolingDuplicate" }
        ]
      }),
      detailSwatch("ENUMERATED", "enumerated", {
        swatchId: "identifier_enum003",
        label: "Broken incomplete",
        attributeName: "incompleteMode",
        possibleStates: [
          { status: "sleep", label: "Sleep", command: "setSleep" },
          { status: "away", label: "Away" }
        ]
      }),
      detailSwatch("ENUMERATED", "enumerated", {
        swatchId: "identifier_enum004",
        label: "Broken object key",
        attributeName: "unsafeMode",
        possibleStates: [
          { status: "__proto__", label: "Unsafe", command: "setUnsafe" }
        ]
      })
    ]);

    expect(store.snapshot().devices[0]?.controls).toEqual([
      expect.objectContaining({
        id: "identifier_enum001",
        kind: "enumerated",
        options: ["cool", "windFree"],
        optionLabels: {
          cool: "Cooling",
          windFree: "Wind free"
        },
        optionCommands: {
          cool: "setCool",
          windFree: "setMode"
        }
      }),
      expect.not.objectContaining({
        id: "identifier_enum002",
        options: expect.any(Array)
      }),
      expect.not.objectContaining({
        id: "identifier_enum003",
        options: expect.any(Array)
      }),
      expect.not.objectContaining({
        id: "identifier_enum004",
        options: expect.any(Array)
      })
    ]);
  });

  test("keeps pending detail ACKs isolated by websocket connection", () => {
    const store = new DeviceStore();

    store.observe(sentFrame('421["get","api/device","identifier_rawdevice",{}]', "detail"));
    store.observe(
      receivedFrame(
        `431${JSON.stringify([null, [{ locationId: "loc_001", name: "Home" }]])}`,
        "keeper"
      )
    );
    store.observe(
      receivedFrame(
        `431${JSON.stringify([
          null,
          {
            data: [
              detailSwatch("BUTTON", "button", {
                swatchId: "identifier_button001",
                label: "Refresh",
                command: "refresh"
              })
            ]
          }
        ])}`,
        "detail"
      )
    );

    expect(store.snapshot().devices[0]?.controls).toEqual([
      expect.objectContaining({ kind: "button", label: "Refresh", command: "refresh" })
    ]);
  });

  test("promotes VALUE detail swatches into normalized device states", () => {
    const store = new DeviceStore();

    observeDeviceDetails(store, [
      detailSwatch("VALUE", "value", {
        capabilityId: "identifier_capability_signal",
        attributeName: "signalMetrics",
        value: { rssi: -61, lqi: 99 },
        unit: "dBm",
        timestamp: "2026-08-25T00:00:00Z"
      })
    ]);

    expect(store.snapshot().devices[0]?.states).toEqual([
      {
        component: "identifier_component_main",
        capability: "identifier_capability_signal",
        attribute: "signalMetrics",
        value: { rssi: -61, lqi: 99 },
        unit: "dBm",
        updatedAt: "2026-08-25T00:00:00Z"
      }
    ]);
  });

  test("rejects malformed device detail swatches", () => {
    const store = new DeviceStore();
    observeDeviceDetails(store, [
      detailSwatch("SLIDER", "slider", {
        deviceId: "raw-device-id",
        swatchId: "identifier_bad001",
        label: "Bad"
      }),
      detailSwatch("BUTTON", "button", {
        swatchId: "identifier_bad002",
        label: "[REDACTED]"
      }),
      { type: "UNKNOWN", unknown: {} }
    ]);

    expect(store.snapshot().devices).toHaveLength(0);
  });

  test("restores old schemaVersion 1 inventory without scenes or controls", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-device-store-old-"));
    try {
      const sqlitePath = join(root, "bridge.sqlite");
      const seeded = new DeviceStore({ sqlitePath });
      seeded.close();
      const db = new DatabaseSync(sqlitePath);
      db.prepare(
        "INSERT INTO normalized_inventory (schema_version, inventory_json, persisted_at) VALUES (1, ?, ?)"
      ).run(
        JSON.stringify({
          schemaVersion: 1,
          sequence: 7,
          locations: [{ id: "loc_001", name: "Home" }],
          rooms: [],
          devices: [
            {
              id: "dev_001",
              locationId: "loc_001",
              roomId: null,
              name: "Old sensor",
              type: null,
              online: true,
              states: []
            }
          ]
        }),
        "2026-08-24T21:00:00.000Z"
      );
      db.close();

      const restored = new DeviceStore({ sqlitePath });

      expect(restored.snapshot()).toMatchObject({ sequence: 7, scenes: [] });
      expect(restored.snapshot().devices[0]?.controls).toBeUndefined();
      restored.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows may release node:sqlite file handles after the assertion completes.
      }
    }
  });
});

function observeSnapshotState(
  store: DeviceStore,
  state: {
    componentId: string;
    capabilityId: string;
    attributeName: string;
    value: unknown;
    unit?: string;
    timestamp: string;
  }
): void {
  store.observe(sentFrame('421["find","api/device/status",{}]'));
  store.observe(
    receivedFrame(
      `431${JSON.stringify([
        null,
        [
          {
            deviceId: "dev_001",
            locationId: "loc_001",
            ...state
          }
        ]
      ])}`
    )
  );
}

function observeLocationSnapshot(
  store: DeviceStore,
  location: Record<string, unknown>
): void {
  store.observe(sentFrame('421["find","api/location",{}]'));
  store.observe(receivedFrame(`431${JSON.stringify([null, [location]])}`));
}

function observeSceneSnapshot(
  store: DeviceStore,
  scene: Record<string, unknown>
): void {
  store.observe(sentFrame('422["find","api/scene",{}]'));
  store.observe(receivedFrame(`432${JSON.stringify([null, [scene]])}`));
}

function observeDeviceDetails(store: DeviceStore, rows: Record<string, unknown>[]): void {
  store.observe(sentFrame('423["get","api/device","identifier_rawdevice",{}]'));
  store.observe(receivedFrame(`433${JSON.stringify([null, { data: rows }])}`));
}

function detailSwatch(
  type: string,
  key: string,
  overrides: Record<string, unknown>
): Record<string, unknown> {
  return {
    type,
    [key]: {
      deviceId: "dev_001",
      locationId: "loc_001",
      componentId: "identifier_component_main",
      capabilityId: "identifier_capability_switch",
      attributeName: key === "slider" ? "detectionFrequency" : "switch",
      label: "Control",
      ...overrides
    }
  };
}

function liveStateEvent(overrides: Record<string, unknown>): SanitizedCaptureRecord {
  return receivedFrame(
    `42${JSON.stringify([
      "api/subscription DEVICE_EVENT",
      {
        data: {
          event_type: "DEVICE_EVENT",
          device_event: {
            device_id: "dev_001",
            location_id: "loc_001",
            component: null,
            ...overrides
          }
        }
      }
    ])}`
  );
}

function sentFrame(text: string, connectionId?: string): SanitizedCaptureRecord {
  return capture("sent", text, connectionId);
}

function receivedFrame(text: string, connectionId?: string): SanitizedCaptureRecord {
  return capture("received", text, connectionId);
}

function capture(
  direction: "sent" | "received",
  text: string,
  connectionId?: string
): SanitizedCaptureRecord {
  return {
    __sanitized: true,
    source: "playwright-websocket-frame",
    receivedAt: "2026-08-24T21:00:00.000Z",
    payload: {
      direction,
      ...(connectionId ? { connectionId } : {}),
      frame: { payload: text, truncated: false }
    },
    payloadHash: "fixture"
  };
}
