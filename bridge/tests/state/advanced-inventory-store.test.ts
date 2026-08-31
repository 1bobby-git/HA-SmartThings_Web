import { describe, expect, test, vi } from "vitest";

import { DeviceStore } from "../../src/state/device-store.js";

describe("DeviceStore Advanced primary inventory", () => {
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
});
