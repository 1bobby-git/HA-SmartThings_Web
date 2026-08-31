import { describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeviceStore } from "../../src/state/device-store.js";

describe("DeviceStore Advanced primary inventory", () => {
  test("ignores undated Advanced OFFLINE health", () => {
    const store = new DeviceStore();

    store.observeAdvancedDeviceSnapshot({
      items: [
        {
          deviceId: "dev_001",
          locationId: "loc_001",
          health: { state: "OFFLINE" },
          components: []
        }
      ]
    });

    expect(store.snapshot().devices[0]).toMatchObject({ id: "dev_001", online: true });
    expect(store.snapshot().devices[0]).not.toHaveProperty("healthUpdatedAt");
  });

  test("merges Advanced locations, rooms, and devices without changing canonical keys", () => {
    const store = new DeviceStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.observeAdvancedInventorySnapshot(
      {
        locations: [{ locationId: "loc_001", name: "Home" }],
        rooms: [{ roomId: "identifier_room", locationId: "loc_001", name: "Living room" }],
        devices: [
          {
            deviceId: "dev_001",
            locationId: "loc_001",
            roomId: "identifier_room",
            label: "Safe plug",
            deviceType: "ZIGBEE",
            healthState: "ONLINE",
            status: {
              components: {
                main: { switch: { switch: { value: "on", timestamp: "2026-08-31T00:00:00Z" } } }
              }
            }
          }
        ]
      },
      { authoritativeWholeSnapshot: true }
    );

    expect(store.snapshot()).toMatchObject({
      locations: [{ id: "loc_001", name: "Home" }],
      rooms: [{ id: "identifier_room", locationId: "loc_001", name: "Living room" }],
      devices: [
        {
          id: "dev_001",
          locationId: "loc_001",
          roomId: "identifier_room",
          name: "Safe plug",
          type: "ZIGBEE"
        }
      ]
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(store.snapshot().devices[0]?.states[0]?.source).toBe("ADVANCED_SNAPSHOT");
  });

  test("uses later Advanced topology metadata for the same IDs without duplicating devices", () => {
    const store = new DeviceStore();
    store.observeAdvancedInventorySnapshot({
      locations: [{ locationId: "loc_001", name: "Old home" }],
      rooms: [],
      devices: [{ deviceId: "dev_001", locationId: "loc_001", label: "Old name" }]
    });
    store.observeAdvancedInventorySnapshot({
      locations: [{ locationId: "loc_001", name: "Home" }],
      rooms: [],
      devices: [{ deviceId: "dev_001", locationId: "loc_001", label: "Safe plug" }]
    });

    expect(store.snapshot().locations).toEqual([{ id: "loc_001", name: "Home" }]);
    expect(store.snapshot().devices).toHaveLength(1);
    expect(store.snapshot().devices[0]?.name).toBe("Safe plug");
  });

  test("retains capability versions for command schema lookup without changing public IDs", () => {
    const store = new DeviceStore();
    store.observeAdvancedInventorySnapshot({
      locations: [{ locationId: "loc_001", name: "Home" }],
      rooms: [],
      devices: [
        {
          deviceId: "dev_001",
          locationId: "loc_001",
          components: [
            {
              id: "identifier_main",
              capabilities: [{ id: "identifier_switchLevel", version: 3 }],
            },
          ],
        },
      ],
    });

    expect(
      store.capabilityVersion("dev_001", "identifier_main", "identifier_switchLevel")
    ).toBe(3);
    expect(store.snapshot().devices[0]?.id).toBe("dev_001");
  });

  test("retains redacted Advanced relationship and classification metadata", () => {
    const store = new DeviceStore();
    store.observeAdvancedInventorySnapshot({
      locations: [{ locationId: "loc_001", name: "Home" }],
      rooms: [],
      devices: [
        {
          deviceId: "dev_001",
          locationId: "loc_001",
          ownerId: "identifier_owner",
          profileId: "identifier_profile",
          presentationId: "identifier_presentation",
          parentDeviceId: "dev_parent",
          childDevices: [{ deviceId: "dev_child" }],
          hubId: "dev_hub",
          driverId: "identifier_driver",
          executionContext: "LOCAL",
          restricted: true,
          deviceType: "GROUP",
          preferences: { thermostatScale: "C", secretToken: "redacted" }
        }
      ]
    });

    expect(store.snapshot().devices[0]).toMatchObject({
      id: "dev_001",
      advanced: {
        ownerId: "identifier_owner",
        profileId: "identifier_profile",
        presentationId: "identifier_presentation",
        parentDeviceId: "dev_parent",
        childDeviceIds: ["dev_child"],
        hubId: "dev_hub",
        driverId: "identifier_driver",
        executionContext: "LOCAL",
        restricted: true,
        group: true,
        preferenceKeys: ["secretToken", "thermostatScale"]
      }
    });
  });

  test("restores redacted Advanced metadata from normalized inventory persistence", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-advanced-metadata-"));
    const sqlitePath = join(root, "bridge.sqlite");
    let first: DeviceStore | undefined;
    let second: DeviceStore | undefined;
    try {
      first = new DeviceStore({ sqlitePath });
      first.observeAdvancedInventorySnapshot({
        locations: [{ locationId: "loc_001", name: "Home" }],
        rooms: [],
        devices: [
          {
            deviceId: "dev_001",
            locationId: "loc_001",
            ownerId: "identifier_owner",
            parentDeviceId: "dev_parent",
            restricted: true
          }
        ]
      });
      first.close();
      first = undefined;

      second = new DeviceStore({ sqlitePath });
      expect(second.snapshot().devices[0]?.advanced).toEqual({
        ownerId: "identifier_owner",
        parentDeviceId: "dev_parent",
        restricted: true
      });
      second.close();
      second = undefined;
    } finally {
      first?.close();
      second?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
