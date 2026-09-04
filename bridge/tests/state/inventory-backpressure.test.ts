import { describe, expect, test } from "vitest";

import type { AdvancedCommandDescriptor } from "../../src/advanced/command-catalog-types.js";
import { DeviceStore } from "../../src/state/device-store.js";

const command = (): AdvancedCommandDescriptor => ({
  component: "main",
  capability: "switch",
  capabilityVersion: 1,
  command: "on",
  arguments: [],
  transport: "advanced",
  confirmation: "state",
  label: "On",
  labelSource: "capability"
});

describe("DeviceStore inventory backpressure", () => {
  test("publishes one inventory marker for a 300-device catalog generation", () => {
    const store = new DeviceStore();
    const deviceIds = Array.from(
      { length: 300 },
      (_, index) => `dev_${String(index).padStart(3, "0")}`
    );
    store.observeAdvancedDeviceSnapshot({
      items: deviceIds.map((deviceId) => ({
        deviceId,
        locationId: "loc_001",
        label: deviceId
      }))
    });
    const events: unknown[] = [];
    store.subscribe((event) => events.push(event));

    const updates = deviceIds.map((deviceId) => ({
      deviceId,
      commands: [command()],
      omissions: []
    }));
    store.observeAdvancedCommandCatalogs(updates);

    expect(events).toEqual([
      {
        schemaVersion: 1,
        sequence: 2,
        type: "inventory"
      }
    ]);

    store.observeAdvancedCommandCatalogs(updates);
    expect(events).toHaveLength(1);
  });

  test("stores newer snapshot timestamps without publishing semantic no-ops", () => {
    const store = new DeviceStore();
    const snapshot = (timestamp: string) => ({
      items: [
        {
          deviceId: "dev_001",
          locationId: "loc_001",
          label: "Sensor",
          health: { state: "ONLINE", updatedAt: timestamp },
          status: {
            components: {
              main: {
                temperatureMeasurement: {
                  temperature: {
                    value: 21,
                    unit: "C",
                    timestamp
                  }
                }
              }
            }
          }
        }
      ]
    });
    store.observeAdvancedDeviceSnapshot(snapshot("2026-09-04T00:00:00.000Z"));
    const events: unknown[] = [];
    store.subscribe((event) => events.push(event));

    store.observeAdvancedDeviceSnapshot(snapshot("2026-09-04T00:01:00.000Z"));

    expect(events).toEqual([]);
    expect(store.currentSequence()).toBe(1);
    expect(store.snapshot().devices[0]).toMatchObject({
      healthUpdatedAt: "2026-09-04T00:01:00.000Z",
      states: [
        expect.objectContaining({
          value: 21,
          updatedAt: "2026-09-04T00:01:00.000Z"
        })
      ]
    });
  });
});
