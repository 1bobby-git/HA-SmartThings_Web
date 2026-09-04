import { describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { SanitizedCaptureRecord } from "../../src/state/capture-store.js";
import type {
  AdvancedCommandDescriptor,
  AdvancedCommandOmission
} from "../../src/advanced/command-catalog-types.js";
import { DeviceStore } from "../../src/state/device-store.js";

describe("DeviceStore", () => {
  test("deduplicates repeated event IDs before applying or publishing state", () => {
    const store = new DeviceStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const eventFrame = (value: string, eventTime: string) =>
      receivedFrame(
        `42${JSON.stringify([
          "api/subscription DEVICE_EVENT",
          {
            data: {
              event_type: "DEVICE_EVENT",
              device_event: {
                event_id: "event_same_001",
                event_time: eventTime,
                device_id: "dev_001",
                location_id: "loc_001",
                component: "main",
                capability: "identifier_contactSensor",
                attribute: "contact",
                value,
                state_change: true
              }
            }
          }
        ])}`
      );

    store.observe(eventFrame("open", "2026-08-31T00:00:01Z"));
    store.observe(eventFrame("closed", "2026-08-31T00:00:02Z"));

    expect(
      store.snapshot().devices[0]?.states.find((state) => state.attribute === "contact")?.value
    ).toBe("open");
    expect(listener).toHaveBeenCalledOnce();
  });

  test("stores timestamp-only repeats without publishing another state event", () => {
    const store = new DeviceStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const frame = (eventId: string, eventTime: string) =>
      receivedFrame(
        `42${JSON.stringify([
          "api/subscription DEVICE_EVENT",
          { data: { event_type: "DEVICE_EVENT", device_event: {
            event_id: eventId,
            event_time: eventTime,
            device_id: "dev_001",
            location_id: "loc_001",
            component: "main",
            capability: "switch",
            attribute: "switch",
            value: "off",
            state_change: true
          } } }
        ])}`
      );
    store.observe(frame("event_timestamp_001", "2026-09-04T00:00:01Z"));
    listener.mockClear();
    const sequence = store.currentSequence();
    store.observe(frame("event_timestamp_002", "2026-09-04T00:00:02Z"));
    expect(store.currentSequence()).toBe(sequence);
    expect(listener).not.toHaveBeenCalled();
    expect(store.snapshot().devices[0]?.states[0]?.updatedAt).toBe(
      "2026-09-04T00:00:02Z"
    );
  });

  test("keeps command-correlated repeats for confirmation", () => {
    const store = new DeviceStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const frame = (eventId: string, eventTime: string, commandId?: string) =>
      receivedFrame(
        `42${JSON.stringify([
          "api/subscription DEVICE_EVENT",
          { data: { event_type: "DEVICE_EVENT", device_event: {
            event_id: eventId,
            event_time: eventTime,
            device_id: "dev_001",
            location_id: "loc_001",
            component: "main",
            capability: "switch",
            attribute: "switch",
            value: "off",
            state_change: true,
            ...(commandId ? { command_id: commandId } : {})
          } } }
        ])}`
      );
    store.observe(frame("event_command_001", "2026-09-04T00:00:01Z"));
    listener.mockClear();
    store.observe(frame("event_command_002", "2026-09-04T00:00:02Z", "command_confirm_002"));
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: "state", commandId: "command_confirm_002" })
    );
  });

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

  test("attaches allowlisted semantic roles to snapshot and push states", () => {
    const aliases: Record<string, string> = {
      main: "identifier_main",
      freezer: "identifier_freezer",
      temperatureMeasurement: "identifier_temperature",
      contactSensor: "identifier_contact",
    };
    const roles: Record<string, string> = {
      identifier_freezer: "freezer",
      identifier_contact: "contact",
    };
    const store = new DeviceStore({
      normalizeStateToken: (value) => aliases[value] ?? value,
      identifierRole: (value) => roles[value],
    });

    observeSnapshotState(store, {
      componentId: "identifier_freezer",
      capabilityId: "identifier_temperature",
      attributeName: "temperature",
      value: -18,
      unit: "C",
      timestamp: "2026-08-24T21:00:00.000Z"
    });
    store.observe(
      liveStateEvent({
        component: "freezer",
        capability: "contactSensor",
        attribute: "contact",
        value: "closed",
        event_time: Date.parse("2026-08-24T21:01:00.000Z")
      })
    );

    expect(store.snapshot().devices[0]?.states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attribute: "temperature",
          componentRole: "freezer"
        }),
        expect.objectContaining({
          attribute: "contact",
          componentRole: "freezer",
          capabilityRole: "contact"
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

  test("deduplicates repeated button delivery with the same fallback identity", () => {
    const store = new DeviceStore();
    observeSnapshotState(store, {
      componentId: "identifier_component_main",
      capabilityId: "identifier_capability_button",
      attributeName: "button",
      value: "pushed",
      timestamp: "2026-08-24T21:15:53.000Z"
    });
    const listener = vi.fn();
    store.subscribe(listener);
    const repeated = liveStateEvent({
      capability: "identifier_capability_button",
      attribute: "button",
      value: "pushed",
      event_time: Date.parse("2026-08-24T21:15:53.000Z")
    });

    store.observe(repeated);
    store.observe(repeated);

    expect(store.snapshot().sequence).toBe(2);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls.map(([event]) => event.sequence)).toEqual([2]);
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

  test("applies and persists a live device health event as an inventory change", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-device-store-health-event-"));
    try {
      const sqlitePath = join(root, "bridge.sqlite");
      const store = new DeviceStore({ sqlitePath });
      observeDeviceSnapshot(store, {
        deviceId: "dev_001",
        locationId: "loc_001",
        deviceName: "Hub",
        deviceTypeData: { type: "hub" }
      });
      const listener = vi.fn();
      store.subscribe(listener);

      store.observe(
        liveHealthEvent({
          status: "offline",
          eventTime: "2026-08-24T21:01:00.000Z"
        })
      );

      expect(store.snapshot()).toMatchObject({
        sequence: 2,
        devices: [expect.objectContaining({ id: "dev_001", online: false })]
      });
      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith({
        schemaVersion: 1,
        sequence: 2,
        type: "inventory"
      });
      store.close();

      const restored = new DeviceStore({ sqlitePath });
      expect(restored.snapshot().devices[0]).toMatchObject({ id: "dev_001", online: false });
      restored.observe(
        liveHealthEvent({
          status: "ONLINE",
          eventTime: "2026-08-24T21:00:59.000Z"
        })
      );
      expect(restored.snapshot()).toMatchObject({
        sequence: 2,
        devices: [expect.objectContaining({ id: "dev_001", online: false })]
      });
      restored.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows may release node:sqlite file handles after the assertion completes.
      }
    }
  });

  test("rejects stale device health events before accepting newer status", () => {
    const store = new DeviceStore();
    observeHealthSnapshot(store, {
      deviceId: "dev_001",
      locationId: "loc_001",
      state: "OFFLINE",
      updatedAt: "2026-08-24T21:02:00.000Z"
    });
    const listener = vi.fn();
    store.subscribe(listener);

    store.observe(
      liveHealthEvent({
        status: "ONLINE",
        eventTime: "2026-08-24T21:01:59.000Z"
      })
    );
    expect(store.snapshot()).toMatchObject({
      sequence: 1,
      devices: [expect.objectContaining({ online: false })]
    });
    expect(listener).not.toHaveBeenCalled();

    store.observe(
      liveHealthEvent({
        status: "online",
        eventTime: "2026-08-24T21:03:00.000Z"
      })
    );

    expect(store.snapshot()).toMatchObject({
      sequence: 2,
      devices: [expect.objectContaining({ online: true })]
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: "inventory", sequence: 2 }));
  });

  test("reads lastUpdatedDate from the observed device health snapshot", () => {
    const store = new DeviceStore();

    observeHealthSnapshot(store, {
      deviceId: "dev_001",
      locationId: "loc_001",
      state: "OFFLINE",
      lastUpdatedDate: "2026-09-01T00:02:00.000Z"
    });

    expect(store.snapshot().devices[0]).toMatchObject({
      online: false,
      healthUpdatedAt: "2026-09-01T00:02:00.000Z"
    });
  });

  test("a newer Location state event restores online availability", () => {
    const store = new DeviceStore();
    observeSnapshotState(store, {
      componentId: "main",
      capabilityId: "switch",
      attributeName: "switch",
      value: "off",
      timestamp: "2026-09-01T00:00:00.000Z"
    });
    store.observe(
      liveHealthEvent({
        status: "OFFLINE",
        eventTime: "2026-09-01T00:01:00.000Z"
      })
    );
    expect(store.snapshot().devices[0]?.online).toBe(false);

    store.observe(
      liveStateEvent({
        component: "main",
        capability: "switch",
        attribute: "switch",
        value: "on",
        event_time: Date.parse("2026-09-01T00:02:00.000Z")
      })
    );

    expect(store.snapshot().devices[0]).toMatchObject({
      online: true,
      healthUpdatedAt: "2026-09-01T00:02:00.000Z"
    });
  });

  test("a newer dated health OFFLINE remains authoritative", () => {
    const store = new DeviceStore();
    observeSnapshotState(store, {
      componentId: "main",
      capabilityId: "switch",
      attributeName: "switch",
      value: "off",
      timestamp: "2026-09-01T00:00:00.000Z"
    });
    store.observe(
      liveStateEvent({
        component: "main",
        capability: "switch",
        attribute: "switch",
        value: "on",
        event_time: Date.parse("2026-09-01T00:01:00.000Z")
      })
    );
    store.observe(
      liveHealthEvent({
        status: "OFFLINE",
        eventTime: "2026-09-01T00:02:00.000Z"
      })
    );

    expect(store.snapshot().devices[0]).toMatchObject({
      online: false,
      healthUpdatedAt: "2026-09-01T00:02:00.000Z"
    });
  });

  test("successful status evidence restores online with its observation time", () => {
    const store = new DeviceStore();
    observeSnapshotState(store, {
      componentId: "main",
      capabilityId: "switch",
      attributeName: "switch",
      value: "off",
      timestamp: "2026-09-01T00:00:00.000Z"
    });
    store.observe(
      liveHealthEvent({
        status: "OFFLINE",
        eventTime: "2026-09-01T00:01:00.000Z"
      })
    );
    const listener = vi.fn();
    store.subscribe(listener);

    expect(() =>
      store.observeOnlineEvidence("dev_001", Date.parse("2026-09-01T00:02:00.000Z"))
    ).not.toThrow();

    expect(store.snapshot().devices[0]).toMatchObject({
      online: true,
      healthUpdatedAt: "2026-09-01T00:02:00.000Z"
    });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: "inventory" }));
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

  test("restores online from newer persisted Location state evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-device-store-restored-liveness-"));
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
          locations: [],
          rooms: [],
          scenes: [],
          devices: [
            {
              id: "dev_324",
              locationId: "loc_001",
              roomId: null,
              name: "Safe light",
              type: "light",
              online: false,
              healthUpdatedAt: "2026-08-29T12:16:26.043Z",
              states: [
                {
                  component: "identifier_main",
                  capability: "identifier_colorTemperature",
                  attribute: "colorTemperature",
                  value: 2732,
                  unit: "K",
                  updatedAt: "2026-08-31T16:41:26.902Z",
                  source: "LOCATION_EVENT"
                }
              ]
            }
          ]
        }),
        "2026-09-01T00:00:00.000Z"
      );
      db.close();

      const restored = new DeviceStore({ sqlitePath });
      expect(restored.snapshot().devices[0]).toMatchObject({
        id: "dev_324",
        online: true,
        healthUpdatedAt: "2026-08-31T16:41:26.902Z"
      });
      restored.close();

      const persisted = new DeviceStore({ sqlitePath });
      expect(persisted.snapshot().devices[0]).toMatchObject({
        id: "dev_324",
        online: true,
        healthUpdatedAt: "2026-08-31T16:41:26.902Z"
      });
      persisted.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows may release node:sqlite file handles after the assertion completes.
      }
    }
  });

  test("does not treat a persisted explicit offline state as positive liveness", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-device-store-restored-offline-"));
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
          sequence: 8,
          locations: [],
          rooms: [],
          scenes: [],
          devices: [
            {
              id: "dev_165",
              locationId: "loc_001",
              roomId: null,
              name: "Offline device",
              type: "light",
              online: false,
              healthUpdatedAt: "2024-07-08T04:00:46.118Z",
              states: [
                {
                  component: "identifier_main",
                  capability: "identifier_health",
                  attribute: "DeviceWatch-DeviceStatus",
                  value: "offline",
                  unit: null,
                  updatedAt: "2026-08-31T22:59:03.625Z",
                  source: "LOCATION_EVENT"
                }
              ]
            }
          ]
        }),
        "2026-09-01T00:00:00.000Z"
      );
      db.close();

      const restored = new DeviceStore({ sqlitePath });
      expect(restored.snapshot().devices[0]).toMatchObject({
        id: "dev_165",
        online: false,
        healthUpdatedAt: "2024-07-08T04:00:46.118Z"
      });
      restored.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows may release node:sqlite file handles after the assertion completes.
      }
    }
  });

  test("publishes live state before coalesced inventory persistence", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-device-store-live-first-"));
    try {
      const sqlitePath = join(root, "bridge.sqlite");
      const store = new DeviceStore({ sqlitePath });
      observeSnapshotState(store, {
        componentId: "identifier_component_main",
        capabilityId: "identifier_capability_contact",
        attributeName: "contact",
        value: "closed",
        timestamp: "2026-08-24T21:00:00.000Z"
      });
      store.close();

      const live = new DeviceStore({ sqlitePath });
      const persistedSequencesAtPublish: number[] = [];
      live.subscribe(() => {
        const observer = new DatabaseSync(sqlitePath, { readOnly: true });
        try {
          persistedSequencesAtPublish.push(readPersistedSequence(observer));
        } finally {
          observer.close();
        }
      });

      live.observe(
        liveStateEvent({
          capability: "identifier_capability_contact",
          attribute: "contact",
          value: "open",
          event_time: Date.parse("2026-08-24T21:00:01.000Z")
        })
      );

      expect(live.snapshot().sequence).toBe(2);
      expect(persistedSequencesAtPublish).toEqual([1]);
      live.close();

      const observer = new DatabaseSync(sqlitePath, { readOnly: true });
      try {
        expect(readPersistedSequence(observer)).toBe(2);
      } finally {
        observer.close();
      }
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows may release node:sqlite file handles after the assertion completes.
      }
    }
  });

  test("retries a transient coalesced persistence failure without interrupting live publish", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "stw-device-store-persist-retry-"));
    try {
      const sqlitePath = join(root, "bridge.sqlite");
      const seed = new DeviceStore({ sqlitePath });
      observeSnapshotState(seed, {
        componentId: "identifier_component_main",
        capabilityId: "identifier_capability_contact",
        attributeName: "contact",
        value: "closed",
        timestamp: "2026-08-24T21:00:00.000Z"
      });
      seed.close();

      const onPersistenceError = vi.fn();
      const live = new DeviceStore({ sqlitePath, onPersistenceError });
      const listener = vi.fn();
      live.subscribe(listener);
      const locker = new DatabaseSync(sqlitePath);
      locker.exec("BEGIN EXCLUSIVE");

      live.observe(
        liveStateEvent({
          capability: "identifier_capability_contact",
          attribute: "contact",
          value: "open",
          event_time: Date.parse("2026-08-24T21:00:01.000Z")
        })
      );
      expect(listener).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(5_100);
      expect(onPersistenceError).toHaveBeenCalledOnce();

      locker.exec("COMMIT");
      locker.close();
      await vi.advanceTimersByTimeAsync(5_100);
      live.close();

      const observer = new DatabaseSync(sqlitePath, { readOnly: true });
      try {
        expect(readPersistedSequence(observer)).toBe(2);
      } finally {
        observer.close();
      }
    } finally {
      vi.useRealTimers();
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows may release node:sqlite file handles after the assertion completes.
      }
    }
  });

  test("does not mask graceful shutdown when the final best-effort persistence flush is locked", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-device-store-close-locked-"));
    const sqlitePath = join(root, "bridge.sqlite");
    let locker: DatabaseSync | undefined;
    try {
      const seed = new DeviceStore({ sqlitePath });
      observeSnapshotState(seed, {
        componentId: "identifier_component_main",
        capabilityId: "identifier_capability_contact",
        attributeName: "contact",
        value: "closed",
        timestamp: "2026-08-24T21:00:00.000Z"
      });
      seed.close();

      const onPersistenceError = vi.fn();
      const live = new DeviceStore({ sqlitePath, onPersistenceError });
      locker = new DatabaseSync(sqlitePath);
      locker.exec("BEGIN EXCLUSIVE");
      live.observe(
        liveStateEvent({
          capability: "identifier_capability_contact",
          attribute: "contact",
          value: "open",
          event_time: Date.parse("2026-08-24T21:00:01.000Z")
        })
      );

      expect(() => live.close()).not.toThrow();
      expect(onPersistenceError).toHaveBeenCalledOnce();
    } finally {
      if (locker) {
        locker.exec("ROLLBACK");
        locker.close();
      }
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows may release node:sqlite file handles after the assertion completes.
      }
    }
  });

  test("restores a persisted location whose optional updatedAt is null", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-device-store-null-location-time-"));
    try {
      const sqlitePath = join(root, "bridge.sqlite");
      const first = new DeviceStore({ sqlitePath });
      observeLocationSnapshot(first, {
        locationId: "loc_001",
        name: "Home",
        armState: "DISARMED",
        updatedAt: null
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

  test("preserves allowlisted SmartThings presentation metadata across restart", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-device-presentation-"));
    try {
      const sqlitePath = join(root, "bridge.sqlite");
      const first = new DeviceStore({ sqlitePath });
      observeDeviceSnapshot(first, {
        deviceId: "dev_001",
        locationId: "loc_001",
        deviceName: "Hub",
        deviceTypeData: { type: "NONE" },
        icon: "https://client.smartthings.com/icons/oneui/hub/on",
        inactiveIcon: "https://client.smartthings.com/icons/oneui/hub/off",
        lottieData: {
          icon: "https://app-asset.samsungiotcloud.com/assets/icons/published/hub/hub.json"
        }
      });

      expect(first.snapshot().devices[0]).toMatchObject({
        type: "hub",
        presentation: {
          assetType: "hub",
          iconUrl: "https://client.smartthings.com/icons/oneui/hub/on",
          inactiveIconUrl: "https://client.smartthings.com/icons/oneui/hub/off",
          animationUrl: "https://app-asset.samsungiotcloud.com/assets/icons/published/hub/hub.json"
        }
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

  test("drops untrusted device presentation URLs instead of persisting them", () => {
    const store = new DeviceStore();
    observeDeviceSnapshot(store, {
      deviceId: "dev_001",
      locationId: "loc_001",
      deviceName: "Untrusted",
      deviceTypeData: { type: "NONE" },
      icon: "https://example.com/device/on",
      inactiveIcon: "data:image/svg+xml,private",
      lottieData: { icon: "https://example.com/device.json" }
    });

    expect(store.snapshot().devices[0]).toMatchObject({ type: "NONE" });
    expect(store.snapshot().devices[0]).not.toHaveProperty("presentation");
  });

  test("preserves a location omitted by both complete startup snapshots", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-device-store-location-preserve-"));
    try {
      const sqlitePath = join(root, "bridge.sqlite");
      const first = new DeviceStore({ sqlitePath });
      observeDeviceSnapshot(first, {
        deviceId: "dev_home",
        locationId: "loc_home",
        deviceName: "Home switch",
        deviceTypeData: { type: "switch" }
      });
      observeDeviceSnapshot(first, {
        deviceId: "dev_officea",
        locationId: "loc_office",
        deviceName: "ExampleOffice switch",
        deviceTypeData: { type: "switch" }
      });
      observeDeviceSnapshot(first, {
        deviceId: "dev_officeb",
        locationId: "loc_office",
        deviceName: "ExampleOffice sensor",
        deviceTypeData: { type: "contact_sensor" }
      });
      first.close();

      const second = new DeviceStore({ sqlitePath });
      observeDeviceSnapshot(second, {
        deviceId: "dev_home",
        locationId: "loc_home",
        deviceName: "Home switch",
        deviceTypeData: { type: "switch" }
      });
      second.observeAdvancedDeviceSnapshot(
        {
          items: [
            {
              deviceId: "dev_home",
              locationId: "loc_home",
              label: "Home switch",
              deviceTypeName: "switch"
            }
          ]
        },
        { authoritativeWholeSnapshot: true }
      );

      expect(second.snapshot().devices.map((device) => device.id)).toEqual([
        "dev_home",
        "dev_officea",
        "dev_officeb"
      ]);

      observeDeviceSnapshot(second, {
        deviceId: "dev_officea",
        locationId: "loc_office",
        deviceName: "ExampleOffice switch",
        deviceTypeData: { type: "switch" }
      });
      second.observeAdvancedDeviceSnapshot(
        {
          items: [
            {
              deviceId: "dev_officea",
              locationId: "loc_office",
              label: "ExampleOffice switch",
              deviceTypeName: "switch"
            }
          ]
        },
        { authoritativeWholeSnapshot: true }
      );

      expect(second.snapshot().devices.map((device) => device.id)).toEqual([
        "dev_home",
        "dev_officea"
      ]);
      second.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows may release node:sqlite file handles after the assertion completes.
      }
    }
  });
  test("prunes restored devices the new browser session never refreshes", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-device-store-prune-"));
    try {
      const sqlitePath = join(root, "bridge.sqlite");
      const first = new DeviceStore({ sqlitePath });
      observeDeviceSnapshot(first, {
        deviceId: "dev_aliasold",
        locationId: "loc_001",
        deviceName: "Presence switch",
        deviceTypeData: { type: "switch" }
      });
      first.close();

      const second = new DeviceStore({ sqlitePath });
      const newSessionDevice = {
        deviceId: "dev_aliasnew",
        locationId: "loc_001",
        deviceName: "Presence switch",
        deviceTypeData: { type: "switch" }
      };
      observeDeviceSnapshot(second, newSessionDevice);
      second.observeAdvancedDeviceSnapshot(
        {
          items: [
            {
              deviceId: "dev_aliasnew",
              locationId: "loc_001",
              label: "Presence switch",
              deviceTypeName: "switch"
            }
          ]
        },
        { authoritativeWholeSnapshot: true }
      );

      const ids = second.snapshot().devices.map((device) => device.id);
      expect(ids).toEqual(["dev_aliasnew"]);
      second.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows may release node:sqlite file handles after the assertion completes.
      }
    }
  });

  test("keeps restored devices until both consumer and whole Advanced snapshots arrive", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-device-store-dual-snapshot-session-"));
    try {
      const sqlitePath = join(root, "bridge.sqlite");
      const first = new DeviceStore({ sqlitePath });
      observeDeviceSnapshot(first, {
        deviceId: "dev_cached",
        locationId: "loc_001",
        deviceName: "Cached switch",
        deviceTypeData: { type: "switch" },
        actions: [
          {
            componentId: "main",
            capabilityId: "switch",
            attributeName: "switch",
            command: "on"
          }
        ]
      });
      first.close();

      const second = new DeviceStore({ sqlitePath });
      observeDeviceSnapshot(second, {
        deviceId: "dev_new",
        locationId: "loc_001",
        deviceName: "New switch",
        deviceTypeData: { type: "switch" }
      });

      expect(second.snapshot().devices.map((device) => device.id)).toEqual([
        "dev_cached",
        "dev_new"
      ]);
      second.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows may release node:sqlite file handles after the assertion completes.
      }
    }
  });

  test("keeps restored controls when whole Advanced still contains a consumer-missing device", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-device-store-advanced-presence-"));
    try {
      const sqlitePath = join(root, "bridge.sqlite");
      const first = new DeviceStore({ sqlitePath });
      observeDeviceSnapshot(first, {
        deviceId: "dev_cached",
        locationId: "loc_001",
        deviceName: "Cached switch",
        deviceTypeData: { type: "switch" },
        actions: [
          {
            componentId: "main",
            capabilityId: "switch",
            attributeName: "switch",
            command: "on"
          }
        ]
      });
      first.close();

      const second = new DeviceStore({ sqlitePath });
      observeDeviceSnapshot(second, {
        deviceId: "dev_new",
        locationId: "loc_001",
        deviceName: "New switch",
        deviceTypeData: { type: "switch" }
      });
      second.observeAdvancedDeviceSnapshot(
        {
          items: [
            {
              deviceId: "dev_cached",
              locationId: "loc_001",
              label: "Cached switch",
              deviceTypeName: "switch"
            },
            {
              deviceId: "dev_new",
              locationId: "loc_001",
              label: "New switch",
              deviceTypeName: "switch"
            }
          ]
        },
        { authoritativeWholeSnapshot: true }
      );

      const cached = second.snapshot().devices.find((device) => device.id === "dev_cached");
      expect(second.snapshot().devices.map((device) => device.id)).toEqual([
        "dev_cached",
        "dev_new"
      ]);
      expect(cached?.controls).toEqual([
        {
          id: "action:main:switch:switch",
          kind: "toggle",
          label: "Power",
          component: "main",
          capability: "switch",
          attribute: "switch",
          commands: ["on"]
        }
      ]);
      second.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows may release node:sqlite file handles after the assertion completes.
      }
    }
  });

  test("keeps restored controls when whole Advanced arrives before the consumer snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-device-store-advanced-first-retain-"));
    try {
      const sqlitePath = join(root, "bridge.sqlite");
      const first = new DeviceStore({ sqlitePath });
      observeDeviceSnapshot(first, {
        deviceId: "dev_cached",
        locationId: "loc_001",
        deviceName: "Cached switch",
        deviceTypeData: { type: "switch" },
        actions: [
          {
            componentId: "main",
            capabilityId: "switch",
            attributeName: "switch",
            command: "on"
          }
        ]
      });
      first.close();

      const second = new DeviceStore({ sqlitePath });
      second.observeAdvancedDeviceSnapshot(
        {
          items: [
            {
              deviceId: "dev_cached",
              locationId: "loc_001",
              label: "Cached switch",
              deviceTypeName: "switch"
            },
            {
              deviceId: "dev_new",
              locationId: "loc_001",
              label: "New switch",
              deviceTypeName: "switch"
            }
          ]
        },
        { authoritativeWholeSnapshot: true }
      );
      observeDeviceSnapshot(second, {
        deviceId: "dev_new",
        locationId: "loc_001",
        deviceName: "New switch",
        deviceTypeData: { type: "switch" }
      });

      const cached = second.snapshot().devices.find((device) => device.id === "dev_cached");
      expect(second.snapshot().devices.map((device) => device.id)).toEqual([
        "dev_cached",
        "dev_new"
      ]);
      expect(cached?.controls).toEqual([
        {
          id: "action:main:switch:switch",
          kind: "toggle",
          label: "Power",
          component: "main",
          capability: "switch",
          attribute: "switch",
          commands: ["on"]
        }
      ]);
      second.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows may release node:sqlite file handles after the assertion completes.
      }
    }
  });

  test("prunes restored devices absent from both snapshots when whole Advanced arrives first", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-device-store-advanced-first-prune-"));
    try {
      const sqlitePath = join(root, "bridge.sqlite");
      const first = new DeviceStore({ sqlitePath });
      observeDeviceSnapshot(first, {
        deviceId: "dev_cached",
        locationId: "loc_001",
        deviceName: "Cached switch",
        deviceTypeData: { type: "switch" }
      });
      first.close();

      const second = new DeviceStore({ sqlitePath });
      second.observeAdvancedDeviceSnapshot(
        {
          items: [
            {
              deviceId: "dev_new",
              locationId: "loc_001",
              label: "New switch",
              deviceTypeName: "switch"
            }
          ]
        },
        { authoritativeWholeSnapshot: true }
      );
      expect(second.snapshot().devices.map((device) => device.id)).toEqual([
        "dev_cached",
        "dev_new"
      ]);

      observeDeviceSnapshot(second, {
        deviceId: "dev_new",
        locationId: "loc_001",
        deviceName: "New switch",
        deviceTypeData: { type: "switch" }
      });

      expect(second.snapshot().devices.map((device) => device.id)).toEqual(["dev_new"]);
      second.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows may release node:sqlite file handles after the assertion completes.
      }
    }
  });

  test("keeps restored devices when only non-device snapshots arrive", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-device-store-partial-session-"));
    try {
      const sqlitePath = join(root, "bridge.sqlite");
      const first = new DeviceStore({ sqlitePath });
      observeDeviceSnapshot(first, {
        deviceId: "dev_cached",
        locationId: "loc_001",
        deviceName: "Cached sensor",
        deviceTypeData: { type: "contact_sensor" }
      });
      first.close();

      const second = new DeviceStore({ sqlitePath });
      observeLocationSnapshot(second, {
        locationId: "loc_001",
        name: "Home"
      });
      observeLocationSnapshot(second, {
        locationId: "loc_001",
        name: "Home"
      });

      expect(second.snapshot().devices.map((device) => device.id)).toEqual(["dev_cached"]);
      second.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows may release node:sqlite file handles after the assertion completes.
      }
    }
  });

  test("keeps restored devices when the consumer device snapshot is malformed", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-device-store-malformed-session-"));
    try {
      const sqlitePath = join(root, "bridge.sqlite");
      const first = new DeviceStore({ sqlitePath });
      observeDeviceSnapshot(first, {
        deviceId: "dev_cached",
        locationId: "loc_001",
        deviceName: "Cached sensor",
        deviceTypeData: { type: "contact_sensor" }
      });
      first.close();

      const second = new DeviceStore({ sqlitePath });
      second.observe(sentFrame('424["find","api/device",{}]'));
      second.observe(receivedFrame('434["temporary snapshot error"]'));

      expect(second.snapshot().devices.map((device) => device.id)).toEqual(["dev_cached"]);
      second.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows may release node:sqlite file handles after the assertion completes.
      }
    }
  });

  test("ignores restored presence from malformed consumer device snapshots before pruning", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-device-store-malformed-presence-"));
    try {
      const sqlitePath = join(root, "bridge.sqlite");
      const first = new DeviceStore({ sqlitePath });
      observeDeviceSnapshot(first, {
        deviceId: "dev_cached",
        locationId: "loc_001",
        deviceName: "Cached sensor",
        deviceTypeData: { type: "contact_sensor" }
      });
      first.close();

      const second = new DeviceStore({ sqlitePath });
      second.observe(sentFrame('424["find","api/device",{}]'));
      second.observe(
        receivedFrame(
          `434${JSON.stringify([
            null,
            [
              {
                basic: {
                  deviceId: "dev_cached",
                  locationId: "loc_001",
                  deviceName: "Cached sensor",
                  deviceTypeData: { type: "contact_sensor" }
                }
              },
              { broken: true }
            ]
          ])}`
        )
      );
      observeDeviceSnapshot(second, {
        deviceId: "dev_new",
        locationId: "loc_001",
        deviceName: "New sensor",
        deviceTypeData: { type: "contact_sensor" }
      });
      second.observeAdvancedDeviceSnapshot(
        {
          items: [
            {
              deviceId: "dev_new",
              locationId: "loc_001",
              label: "New sensor",
              deviceTypeName: "contact_sensor"
            }
          ]
        },
        { authoritativeWholeSnapshot: true }
      );

      expect(second.snapshot().devices.map((device) => device.id)).toEqual(["dev_new"]);
      second.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows may release node:sqlite file handles after the assertion completes.
      }
    }
  });

  test("does not prune restored devices after partial Advanced and complete consumer snapshots", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-device-store-partial-advanced-no-prune-"));
    try {
      const sqlitePath = join(root, "bridge.sqlite");
      const first = new DeviceStore({ sqlitePath });
      observeDeviceSnapshot(first, {
        deviceId: "dev_cached",
        locationId: "loc_001",
        deviceName: "Cached sensor",
        deviceTypeData: { type: "contact_sensor" }
      });
      first.close();

      const second = new DeviceStore({ sqlitePath });
      second.observeAdvancedDeviceSnapshot({
        items: [
          {
            deviceId: "dev_new",
            locationId: "loc_001",
            label: "New sensor",
            deviceTypeName: "contact_sensor"
          }
        ]
      });
      observeDeviceSnapshot(second, {
        deviceId: "dev_new",
        locationId: "loc_001",
        deviceName: "New sensor",
        deviceTypeData: { type: "contact_sensor" }
      });

      expect(second.snapshot().devices.map((device) => device.id)).toEqual([
        "dev_cached",
        "dev_new"
      ]);
      second.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows may release node:sqlite file handles after the assertion completes.
      }
    }
  });

  test("does not combine consumer and whole Advanced evidence across snapshot epochs", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-device-store-epoch-reset-"));
    try {
      const sqlitePath = join(root, "bridge.sqlite");
      const first = new DeviceStore({ sqlitePath });
      observeDeviceSnapshot(first, {
        deviceId: "dev_cached",
        locationId: "loc_001",
        deviceName: "Cached sensor",
        deviceTypeData: { type: "contact_sensor" }
      });
      first.close();

      const second = new DeviceStore({ sqlitePath });
      observeDeviceSnapshot(second, {
        deviceId: "dev_new",
        locationId: "loc_001",
        deviceName: "New sensor",
        deviceTypeData: { type: "contact_sensor" }
      });
      second.resetSnapshotSession();
      second.observeAdvancedDeviceSnapshot(
        {
          items: [
            {
              deviceId: "dev_new",
              locationId: "loc_001",
              label: "New sensor",
              deviceTypeName: "contact_sensor"
            }
          ]
        },
        { authoritativeWholeSnapshot: true }
      );

      expect(second.snapshot().devices.map((device) => device.id)).toEqual([
        "dev_cached",
        "dev_new"
      ]);
      second.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows may release node:sqlite file handles after the assertion completes.
      }
    }
  });

  test("keeps restored devices when Advanced enrichment is partial", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-device-store-partial-advanced-"));
    try {
      const sqlitePath = join(root, "bridge.sqlite");
      const first = new DeviceStore({ sqlitePath });
      observeDeviceSnapshot(first, {
        deviceId: "dev_cached",
        locationId: "loc_001",
        deviceName: "Cached sensor",
        deviceTypeData: { type: "contact_sensor" }
      });
      first.close();

      const second = new DeviceStore({ sqlitePath });
      second.observeAdvancedDeviceSnapshot({
        items: [
          {
            deviceId: "dev_new",
            locationId: "loc_001",
            label: "New sensor",
            deviceTypeName: "contact_sensor"
          }
        ]
      });
      second.observeAdvancedDeviceSnapshot({
        items: [
          {
            deviceId: "dev_new",
            locationId: "loc_001",
            label: "New sensor",
            deviceTypeName: "contact_sensor"
          }
        ]
      });

      expect(second.snapshot().devices.map((device) => device.id)).toEqual([
        "dev_cached",
        "dev_new"
      ]);
      second.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows may release node:sqlite file handles after the assertion completes.
      }
    }
  });

  test("merges same-origin advanced device metadata without creating controls", () => {
    const store = new DeviceStore();
    observeDeviceSnapshot(store, {
      deviceId: "dev_001",
      locationId: "loc_001",
      deviceName: "Old label",
      roomId: "identifier_roomold",
      deviceTypeData: { type: "accessory" }
    });
    const listener = vi.fn();
    store.subscribe(listener);

    store.observeAdvancedDeviceSnapshot({
      items: [
        {
          deviceId: "dev_001",
          locationId: "loc_001",
          label: "아리",
          roomId: "identifier_roomnew",
          deviceTypeName: "bleD2D",
          presentationId: "smart_tag_2",
          healthState: { state: "ONLINE" },
          allowedActions: [{ command: "setVolume" }]
        }
      ]
    });

    expect(store.snapshot().devices[0]).toMatchObject({
      name: "아리",
      roomId: "identifier_roomnew",
      type: "bleD2D",
      online: true,
      presentation: { assetType: "smart_tag_2" }
    });
    expect(store.snapshot().devices[0]?.controls).toBeUndefined();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: "inventory" }));
  });

  test("preserves observed switch actions from device cards as toggle controls", () => {
    const store = new DeviceStore();
    observeSnapshotState(store, {
      componentId: "main",
      capabilityId: "switch",
      attributeName: "switch",
      value: "off",
      timestamp: "2026-08-24T22:59:02.000Z"
    });
    observeSnapshotState(store, {
      componentId: "main",
      capabilityId: "contactSensor",
      attributeName: "contact",
      value: "closed",
      timestamp: "2026-08-24T22:59:02.000Z"
    });

    observeDeviceSnapshot(store, {
      deviceId: "dev_001",
      locationId: "loc_001",
      roomId: "identifier_room",
      deviceName: "Home Assistant 연동 스위치",
      deviceTypeData: { type: "NONE" },
      lottieData: {
        icon: "https://app-asset.samsungiotcloud.com/assets/icons/published/switch/switch.json"
      },
      actions: [
        {
          capabilityId: "switch",
          attributeName: "switch",
          componentId: "main",
          value: "off",
          command: "on"
        },
        {
          capabilityId: "switch",
          attributeName: "switch",
          componentId: "main",
          value: "on",
          command: "off"
        }
      ]
    });

    expect(store.snapshot().devices[0]).toMatchObject({
      type: "switch",
      states: expect.arrayContaining([
        expect.objectContaining({ capability: "switch", attribute: "switch" }),
        expect.objectContaining({ capability: "contactSensor", attribute: "contact" })
      ]),
      controls: [
        {
          id: "action:main:switch:switch",
          kind: "toggle",
          label: "Power",
          component: "main",
          capability: "switch",
          attribute: "switch",
          commands: ["on", "off"]
        }
      ]
    });
  });

  test("preserves only the currently observed status switch action", () => {
    const store = new DeviceStore();
    store.observe(sentFrame('421["find","api/device/status",{}]'));

    store.observe(
      receivedFrame(
        `431${JSON.stringify([
          null,
          [
            {
              deviceId: "dev_001",
              locationId: "loc_001",
              componentId: "main",
              capabilityId: "switch",
              attributeName: "switch",
              value: "off",
              timestamp: "2026-08-24T22:59:02.000Z",
              action: {
                componentId: "main",
                capabilityId: "switch",
                attributeName: "switch",
                command: "on"
              }
            }
          ]
        ])}`
      )
    );

    expect(store.snapshot().devices[0]?.controls).toEqual([
      {
        id: "action:main:switch:switch",
        kind: "toggle",
        label: "Power",
        component: "main",
        capability: "switch",
        attribute: "switch",
        commands: ["on"]
      }
    ]);
  });

  test("preserves status switch controls from plural actions command lists", () => {
    const store = new DeviceStore();
    store.observe(sentFrame('421["find","api/device/status",{}]'));

    store.observe(
      receivedFrame(
        `431${JSON.stringify([
          null,
          [
            {
              deviceId: "dev_001",
              locationId: "loc_001",
              componentId: "main",
              capabilityId: "switch",
              attributeName: "switch",
              value: "off",
              timestamp: "2026-08-30T14:00:00.000Z",
              actions: [
                {
                  componentId: "main",
                  capabilityId: "switch",
                  attributeName: "switch",
                  commands: ["on", "off", "refresh"]
                },
                {
                  componentId: "main",
                  capabilityId: "switchLevel",
                  attributeName: "level",
                  commands: ["on", "off"]
                }
              ]
            }
          ]
        ])}`
      )
    );

    expect(store.snapshot().devices[0]?.controls).toEqual([
      {
        id: "action:main:switch:switch",
        kind: "toggle",
        label: "Power",
        component: "main",
        capability: "switch",
        attribute: "switch",
        commands: ["on", "off"]
      }
    ]);
  });

  test("preserves a status switch action even when the row only has display state", () => {
    const store = new DeviceStore();
    store.observe(sentFrame('421["find","api/device/status",{}]'));

    store.observe(
      receivedFrame(
        `431${JSON.stringify([
          null,
          [
            {
              deviceId: "dev_001",
              locationId: "loc_001",
              componentId: "main",
              capabilityId: "switch",
              attributeName: "switch",
              state: {
                label: "꺼짐",
                active: false,
                type: "inactivated",
                icon: "https://client.smartthings.com/icons/oneui/oic.d.switch/off"
              },
              action: {
                componentId: "main",
                capabilityId: "switch",
                attributeName: "switch",
                command: "on"
              }
            }
          ]
        ])}`
      )
    );

    expect(store.snapshot().devices[0]?.controls).toEqual([
      {
        id: "action:main:switch:switch",
        kind: "toggle",
        label: "Power",
        component: "main",
        capability: "switch",
        attribute: "switch",
        commands: ["on"]
      }
    ]);
  });

  test("accumulates both switch directions only after each action is observed", () => {
    const store = new DeviceStore();
    store.observe(sentFrame('421["find","api/device/status",{}]'));
    store.observe(
      receivedFrame(
        `431${JSON.stringify([
          null,
          [
            {
              deviceId: "dev_001",
              locationId: "loc_001",
              componentId: "main",
              capabilityId: "switch",
              attributeName: "switch",
              value: "off",
              timestamp: "2026-08-24T22:59:02.000Z",
              action: {
                componentId: "main",
                capabilityId: "switch",
                attributeName: "switch",
                command: "on"
              }
            }
          ]
        ])}`
      )
    );
    store.observe(sentFrame('422["find","api/device/status",{}]'));
    store.observe(
      receivedFrame(
        `432${JSON.stringify([
          null,
          [
            {
              deviceId: "dev_001",
              locationId: "loc_001",
              componentId: "main",
              capabilityId: "switch",
              attributeName: "switch",
              value: "on",
              timestamp: "2026-08-24T22:59:03.000Z",
              action: {
                componentId: "main",
                capabilityId: "switch",
                attributeName: "switch",
                command: "off"
              }
            }
          ]
        ])}`
      )
    );

    expect(store.snapshot().devices[0]?.controls).toEqual([
      expect.objectContaining({
        id: "action:main:switch:switch",
        commands: ["on", "off"]
      })
    ]);
  });

  test("creates a refresh button only from an observed Advanced refresh capability", () => {
    const store = new DeviceStore({
      normalizeAdvancedAlias: (kind, value) => {
        if (kind === "device") return "dev_001";
        if (kind === "location") return "loc_001";
        return `identifier_${value}`;
      },
      identifierRole: (value) =>
        value === "identifier_refresh" ? "refresh" : undefined
    });
    observeDeviceSnapshot(store, {
      deviceId: "dev_001",
      locationId: "loc_001",
      deviceName: "거실 창문센서",
      roomId: "identifier_room",
      deviceTypeData: { type: "contact_sensor" }
    });

    store.observeAdvancedDeviceSnapshot({
      items: [
        {
          deviceId: "raw-device",
          locationId: "raw-location",
          components: [
            {
              id: "main",
              capabilities: [{ id: "refresh", status: {} }]
            }
          ]
        }
      ]
    });

    expect(store.snapshot().devices[0]?.controls).toEqual([
      {
        id: "advanced:refresh:identifier_main:identifier_refresh",
        kind: "button",
        label: "Refresh",
        component: "identifier_main",
        capability: "identifier_refresh",
        attribute: "refresh",
        command: "refresh",
        commands: ["refresh"]
      }
    ]);
  });

  test("merges advanced status components as states and keeps newer values", () => {
    const store = new DeviceStore({
      identifierRole: (value) =>
        ({
          identifier_cooler: "cooler",
          identifier_freezer: "freezer",
        })[value],
    });
    observeSnapshotState(store, {
      componentId: "identifier_freezer",
      capabilityId: "identifier_temperatureMeasurement",
      attributeName: "temperature",
      value: -18,
      unit: "C",
      timestamp: "2026-08-24T21:10:00.000Z"
    });
    const listener = vi.fn();
    store.subscribe(listener);

    store.observeAdvancedDeviceSnapshot({
      items: [
        {
          deviceId: "dev_001",
          locationId: "loc_001",
          label: "냉장고",
          status: {
            components: {
              identifier_cooler: {
                identifier_temperatureMeasurement: {
                  temperature: {
                    value: 3,
                    unit: "C",
                    timestamp: "2026-08-24T21:11:00.000Z"
                  }
                },
                identifier_contactSensor: {
                  contact: {
                    value: "closed",
                    timestamp: "2026-08-24T21:11:00.000Z"
                  }
                }
              },
              identifier_freezer: {
                identifier_temperatureMeasurement: {
                  temperature: {
                    value: -20,
                    unit: "C",
                    timestamp: "2026-08-24T21:09:00.000Z"
                  }
                },
                identifier_battery: {
                  battery: {
                    value: 88,
                    unit: "%",
                    timestamp: "2026-08-24T21:11:00.000Z"
                  }
                }
              }
            }
          }
        }
      ]
    });

    expect(store.snapshot().devices[0]?.states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          component: "identifier_cooler",
          attribute: "temperature",
          value: 3,
          componentRole: "cooler"
        }),
        expect.objectContaining({
          component: "identifier_cooler",
          attribute: "contact",
          value: "closed",
          componentRole: "cooler"
        }),
        expect.objectContaining({
          component: "identifier_freezer",
          attribute: "temperature",
          value: -18,
          componentRole: "freezer"
        }),
        expect.objectContaining({
          component: "identifier_freezer",
          attribute: "battery",
          value: 88,
          componentRole: "freezer"
        })
      ])
    );
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("merges advanced component arrays into the existing refrigerator device and restores roles", () => {
    const store = new DeviceStore({
      normalizeAdvancedAlias: (kind, value) => {
        if (kind === "device" && value === "dev_advanced") return "dev_001";
        if (kind === "location" && value === "loc_advanced") return "loc_001";
        return value.replace("_advanced", "");
      }
    });
    observeDeviceSnapshot(store, {
      deviceId: "dev_001",
      locationId: "loc_001",
      deviceName: "냉장고",
      deviceTypeData: { type: "refrigerator" }
    });
    for (const component of ["main", "freezer", "cooler", "cvroom"]) {
      observeSnapshotState(store, {
        componentId: `identifier_${component}`,
        capabilityId: "identifier_contactSensor",
        attributeName: "contact",
        value: "closed",
        timestamp: "2026-08-27T03:00:00.000Z"
      });
    }

    store.observeAdvancedDeviceSnapshot({
      items: [
        {
          deviceId: "dev_advanced",
          locationId: "loc_advanced",
          label: "냉장고",
          ocfDeviceType: "oic.d.refrigerator",
          components: [
            advancedComponent("identifier_main_advanced", "main", "Refrigerator"),
            advancedComponent("identifier_freezer_advanced", "freezer", "Other"),
            advancedComponent("identifier_cooler_advanced", "cooler", "Other"),
            advancedComponent("identifier_cvroom_advanced", "cvroom", "Other")
          ]
        }
      ]
    });

    const snapshot = store.snapshot();
    expect(snapshot.devices).toHaveLength(1);
    expect(snapshot.devices[0]?.states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ component: "identifier_main", value: "closed", componentRole: "refrigerator" }),
        expect.objectContaining({ component: "identifier_freezer", value: "closed", componentRole: "freezer" }),
        expect.objectContaining({ component: "identifier_cooler", value: "closed", componentRole: "cooler" }),
        expect.objectContaining({ component: "identifier_cvroom", value: "closed", componentRole: "cvroom" })
      ])
    );
    expect(snapshot.devices[0]?.states.every((state) => state.updatedAt === "2026-08-27T03:00:00.000Z")).toBe(true);
  });

  test("does not replace an existing semantic role from a stale advanced state", () => {
    const store = new DeviceStore({
      identifierRole: (value) => value === "identifier_freezer" ? "freezer" : undefined
    });
    observeSnapshotState(store, {
      componentId: "identifier_freezer",
      capabilityId: "identifier_contactSensor",
      attributeName: "contact",
      value: "closed",
      timestamp: "2026-08-27T03:00:00.000Z"
    });

    store.observeAdvancedDeviceSnapshot({
      items: [
        {
          deviceId: "dev_001",
          locationId: "loc_001",
          components: [
            advancedComponent(
              "identifier_freezer",
              "cooler",
              "Other",
              "identifier_contactSensor"
            )
          ]
        }
      ]
    });

    expect(store.snapshot().devices[0]?.states).toEqual([
      expect.objectContaining({
        component: "identifier_freezer",
        value: "closed",
        updatedAt: "2026-08-27T03:00:00.000Z",
        componentRole: "freezer"
      })
    ]);
  });

  test("uses component array metadata when advanced values use status components", () => {
    const store = new DeviceStore({
      normalizeStateToken: (value) => ({
        cooler: "identifier_cooler",
        contactSensor: "identifier_contactSensor"
      })[value] ?? value
    });

    store.observeAdvancedDeviceSnapshot({
      items: [
        {
          deviceId: "dev_001",
          locationId: "loc_001",
          components: [
            {
              id: "identifier_cooler",
              label: "cooler",
              categories: [{ name: "Other" }]
            }
          ],
          status: {
            components: {
              cooler: {
                contactSensor: {
                  contact: {
                    value: "closed",
                    timestamp: "2026-08-27T03:00:00.000Z"
                  }
                }
              }
            }
          }
        }
      ]
    });

    expect(store.snapshot().devices[0]?.states).toEqual([
      expect.objectContaining({
        component: "identifier_cooler",
        capability: "identifier_contactSensor",
        componentRole: "cooler"
      })
    ]);
  });

  test("aliases raw advanced status keys before publishing semantic roles", () => {
    const aliases: Record<string, string> = {
      cooler: "identifier_cooler",
      "hca.main": "identifier_hca_main",
      temperatureMeasurement: "identifier_temperatureMeasurement",
    };
    const store = new DeviceStore({
      normalizeStateToken: (value) => aliases[value] ?? value,
      identifierRole: (value) =>
        ({
          cooler: "cooler",
          "hca.main": "hca.main",
          identifier_cooler: "cooler",
          identifier_hca_main: "hca.main"
        })[value],
    });

    store.observeAdvancedDeviceSnapshot({
      items: [
        {
          deviceId: "dev_001",
          locationId: "loc_001",
          label: "냉장고",
          status: {
            components: {
              cooler: {
                temperatureMeasurement: {
                  temperature: {
                    value: 2,
                    unit: "C",
                    timestamp: "2026-08-24T21:11:00.000Z"
                  }
                }
              },
              "hca.main": {
                temperatureMeasurement: {
                  temperature: {
                    value: 12,
                    unit: "C",
                    timestamp: "2026-08-24T21:12:00.000Z"
                  }
                }
              }
            }
          }
        }
      ]
    });

    expect(store.snapshot().devices[0]?.states).toEqual([
      expect.objectContaining({
        component: "identifier_cooler",
        capability: "identifier_temperatureMeasurement",
        attribute: "temperature",
        value: 2,
        componentRole: "cooler"
      }),
      expect.objectContaining({
        component: "identifier_hca_main",
        capability: "identifier_temperatureMeasurement",
        attribute: "temperature",
        value: 12,
        componentRole: "hca.main"
      })
    ]);
    expect(JSON.stringify(store.snapshot())).not.toContain('"component":"cooler"');
    expect(JSON.stringify(store.snapshot())).not.toContain('"component":"hca.main"');
    expect(JSON.stringify(store.snapshot())).not.toContain('"capability":"temperatureMeasurement"');
  });

  test("ignores malformed advanced rows and unsafe presentation ids", () => {
    const store = new DeviceStore();

    store.observeAdvancedDeviceSnapshot({
      items: [
        {
          deviceId: "raw-device-id",
          locationId: "loc_001",
          label: "Ignored"
        },
        {
          deviceId: "dev_001",
          locationId: "loc_001",
          label: "Safe device",
          presentationId: "../unsafe"
        }
      ]
    });

    expect(store.snapshot().devices).toEqual([
      expect.objectContaining({
        id: "dev_001",
        name: "Safe device"
      })
    ]);
    expect(store.snapshot().devices[0]).not.toHaveProperty("presentation");
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
      updatedAt: "2026-08-24T21:01:00.000Z",
      actions: [
        {
          command: {
            devices: ["dev_001"],
            commands: [
              {
                component: "main",
                capability: "identifier_switch",
                command: "on",
                arguments: []
              }
            ]
          }
        }
      ]
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
          updatedAt: "2026-08-24T21:01:00.000Z",
          expectedStates: [
            {
              deviceId: "dev_001",
              component: "main",
              capability: "identifier_switch",
              attribute: "switch",
              value: "on"
            }
          ]
        }
      ]
    });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "inventory", sequence: 2 })
    );
  });

  test("unwraps typed scene action arguments into primitive expected states", () => {
    const store = new DeviceStore();
    observeSceneSnapshot(store, {
      sceneId: "identifier_scenemedia",
      locationId: "loc_001",
      name: "Volume preset",
      updatedAt: "2026-08-24T21:01:00.000Z",
      actions: [
        {
          command: {
            devices: ["dev_001"],
            commands: [
              {
                component: "main",
                capability: "identifier_audioVolume",
                command: "setVolume",
                arguments: [{ integer: 64, type: "integer" }]
              },
              {
                component: "main",
                capability: "identifier_thermostatMode",
                command: "setThermostatMode",
                arguments: [{ string: "eco", type: "string" }]
              }
            ]
          }
        }
      ]
    });

    expect(store.snapshot().scenes[0]?.expectedStates).toEqual([
      {
        deviceId: "dev_001",
        component: "main",
        capability: "identifier_audioVolume",
        attribute: "volume",
        value: 64
      },
      {
        deviceId: "dev_001",
        component: "main",
        capability: "identifier_thermostatMode",
        attribute: "thermostatMode",
        value: "eco"
      }
    ]);
  });

  test("normalizes raw scene action component and capability tokens like states", () => {
    const aliases: Record<string, string> = {
      main: "identifier_main",
      switch: "identifier_switch",
      audioVolume: "identifier_audioVolume"
    };
    const store = new DeviceStore({ normalizeStateToken: (value) => aliases[value] ?? value });
    observeSceneSnapshot(store, {
      sceneId: "identifier_sceneraw",
      locationId: "loc_001",
      name: "Raw scene",
      updatedAt: "2026-08-24T21:01:00.000Z",
      actions: [
        {
          command: {
            devices: ["dev_001"],
            commands: [
              {
                component: "main",
                capability: "switch",
                command: "on",
                arguments: []
              },
              {
                component: "main",
                capability: "audioVolume",
                command: "setVolume",
                arguments: [{ integer: 64, type: "integer" }]
              }
            ]
          }
        }
      ]
    });

    expect(store.snapshot().scenes[0]?.expectedStates).toEqual([
      {
        deviceId: "dev_001",
        component: "identifier_main",
        capability: "identifier_audioVolume",
        attribute: "volume",
        value: 64
      },
      {
        deviceId: "dev_001",
        component: "identifier_main",
        capability: "identifier_switch",
        attribute: "switch",
        value: "on"
      }
    ]);
  });

  test("deep clones scene expected states in snapshots", () => {
    const store = new DeviceStore();
    observeSceneSnapshot(store, {
      sceneId: "identifier_sceneclone",
      locationId: "loc_001",
      name: "Clone scene",
      updatedAt: "2026-08-24T21:01:00.000Z",
      actions: [
        {
          command: {
            devices: ["dev_001"],
            commands: [
              {
                component: "main",
                capability: "identifier_switch",
                command: "on",
                arguments: []
              }
            ]
          }
        }
      ]
    });

    const snapshot = store.snapshot();
    const expected = snapshot.scenes[0]?.expectedStates?.[0];
    expect(expected).toBeDefined();
    if (!expected) return;
    expected.value = "off";
    expected.component = "mutated";
    snapshot.scenes[0]?.expectedStates?.push({
      deviceId: "dev_999",
      component: "main",
      capability: "identifier_switch",
      attribute: "switch",
      value: "off"
    });

    expect(store.snapshot().scenes[0]?.expectedStates).toEqual([
      {
        deviceId: "dev_001",
        component: "main",
        capability: "identifier_switch",
        attribute: "switch",
        value: "on"
      }
    ]);
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
        updatedAt: "2026-08-24T21:01:00.000Z",
        actions: [
          {
            command: {
              devices: ["dev_001"],
              commands: [
                {
                  component: "main",
                  capability: "identifier_switch",
                  command: "on",
                  arguments: []
                }
              ]
            }
          }
        ]
      });
      const beforeRestart = first.snapshot();
      first.close();

      const restored = new DeviceStore({ sqlitePath });

      expect(restored.snapshot()).toEqual(beforeRestart);
      const restoredSnapshot = restored.snapshot();
      const expected = restoredSnapshot.scenes[0]?.expectedStates?.[0];
      expect(expected).toBeDefined();
      if (!expected) return;
      expected.value = "off";
      restoredSnapshot.scenes[0]?.expectedStates?.push({
        deviceId: "dev_999",
        component: "main",
        capability: "identifier_switch",
        attribute: "switch",
        value: "off"
      });
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

  test("exports the living-room window sensor without stale camera states", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-window-sensor-shape-"));
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
          scenes: [],
          devices: [
            {
              id: "dev_window001",
              locationId: "loc_001",
              roomId: null,
              name: "거실창문센서",
              type: "custom_window_h",
              online: true,
              states: [
                persistedState("contactSensor", "contact", "closed", null, "2026-08-25T02:11:34Z"),
                persistedState("battery", "battery", 91, "%", "2026-04-01T17:21:43Z"),
                persistedState(
                  "legendabsolute60149.signalMetrics",
                  "signalMetrics",
                  "KST-9: 2026/04/01 11:28 LQI: 184  RSSI: -95dbm",
                  null,
                  "2026-04-01T11:28:55Z"
                ),
                persistedState("imageCapture", "image", "stale", null, "2026-04-01T11:28:55Z"),
                persistedState("imageCapture", "imageTransferProgress", 100, "%", "2026-04-01T11:28:55Z")
              ],
              controls: [
                {
                  id: "identifier_refresh",
                  kind: "button",
                  label: "Refresh",
                  component: "main",
                  capability: "refresh",
                  attribute: "refresh",
                  command: "refresh",
                  commands: ["refresh"]
                }
              ]
            },
            {
              id: "dev_camera001",
              locationId: "loc_001",
              roomId: null,
              name: "홈카메라 360",
              type: "camera_security",
              online: true,
              states: [
                persistedState("imageCapture", "image", "metadata", null, "2026-08-25T03:16:00Z"),
                persistedState("imageCapture", "imageTransferProgress", 100, "%", "2026-08-25T03:16:00Z")
              ]
            }
          ]
        }),
        "2026-08-27T00:00:00.000Z"
      );
      db.close();

      const restored = new DeviceStore({ sqlitePath });
      const snapshot = restored.snapshot();
      const window = snapshot.devices.find((device) => device.id === "dev_window001");
      const camera = snapshot.devices.find((device) => device.id === "dev_camera001");

      expect(window?.states.map((state) => [state.attribute, state.value, state.unit])).toEqual([
        ["battery", 91, "%"],
        ["contact", "closed", null],
        ["signalMetrics", "KST-9: 2026/04/01 11:28 LQI: 184  RSSI: -95dbm", null]
      ]);
      expect(window?.controls).toEqual([
        expect.objectContaining({ kind: "button", label: "Refresh", command: "refresh" })
      ]);
      expect(camera?.states.map((state) => state.attribute)).toEqual([
        "image",
        "imageTransferProgress"
      ]);
      restored.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows may release node:sqlite file handles after the assertion completes.
      }
    }
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

  test("projects reversible argument-free Advanced switch commands and preserves native controls", () => {
    const store = new DeviceStore();
    const listener = vi.fn();
    store.subscribe(listener);
    observeSnapshotState(store, {
      componentId: "main",
      capabilityId: "switch",
      attributeName: "switch",
      value: "off",
      timestamp: "2026-09-01T00:00:00.000Z"
    });
    observeDeviceDetails(store, [
      detailSwatch("BUTTON", "button", {
        swatchId: "identifier_refresh",
        capabilityId: "refresh",
        attributeName: "refresh",
        label: "Refresh",
        command: "refresh"
      })
    ]);
    const before = store.currentSequence();

    store.observeAdvancedCommandCatalog("dev_001", [
      advancedDescriptor("main", "switch", "on", "Power"),
      advancedDescriptor("main", "switch", "off", "Power")
    ], []);

    const device = store.snapshot().devices[0];
    expect(device?.advancedCommands).toEqual([
      advancedDescriptor("main", "switch", "off", "Power"),
      advancedDescriptor("main", "switch", "on", "Power")
    ]);
    expect(device?.controls).toEqual([
      expect.objectContaining({ id: "advanced:main:switch:switch", transport: "advanced" }),
      expect.objectContaining({ id: "identifier_refresh" })
    ]);
    expect(device?.controls?.find((control) => control.id === "identifier_refresh")).not.toHaveProperty(
      "transport"
    );
    expect(store.currentSequence()).toBe(before + 1);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "inventory", sequence: before + 1 })
    );
  });

  test("does not project one-sided or argumentful Advanced commands and removes stale catalog controls", () => {
    const store = new DeviceStore();
    observeSnapshotState(store, {
      componentId: "main",
      capabilityId: "switch",
      attributeName: "switch",
      value: "off",
      timestamp: "2026-09-01T00:00:00.000Z"
    });
    store.observeAdvancedCommandCatalog("dev_001", [
      advancedDescriptor("main", "switch", "on"),
      advancedDescriptor("main", "switch", "off")
    ], []);
    expect(store.snapshot().devices[0]?.controls?.map((control) => control.id)).toContain(
      "advanced:main:switch:switch"
    );

    store.observeAdvancedCommandCatalog("dev_001", [
      advancedDescriptor("main", "switch", "on"),
      advancedDescriptor("main", "switch", "off", "setSwitch", [{
        name: "value",
        required: true,
        sensitive: false,
        schema: { type: "string", enum: ["on", "off"] }
      }])
    ], [{ component: "main", capability: "switch", command: "off", reason: "schema_invalid" }]);

    const device = store.snapshot().devices[0];
    expect((device?.controls ?? []).some((control) => control.id.startsWith("advanced:"))).toBe(false);
    expect(device?.advancedCommands?.map((command) => command.command)).toEqual(["off", "on"]);
    expect(device?.commandOmissions).toEqual([
      { component: "main", capability: "switch", command: "off", reason: "schema_invalid" }
    ]);
  });

  test("drops Advanced command descriptors with schema keys outside the public contract", () => {
    const store = new DeviceStore();
    observeSnapshotState(store, {
      componentId: "main",
      capabilityId: "speechSynthesis",
      attributeName: "phrase",
      value: "",
      timestamp: "2026-09-01T00:00:00.000Z"
    });

    store.observeAdvancedCommandCatalog("dev_001", [
      advancedDescriptor("main", "speechSynthesis", "speak", "Speak", [], {
        type: "string",
        enum: ["Hello", "Goodnight"]
      }),
      advancedDescriptor("main", "speechSynthesis", "speakRaw", "Speak raw", [], {
        type: "array",
        items: { type: "string" }
      } as never),
      advancedDescriptor("main", "speechSynthesis", "speakUuid", "Speak uuid", [], {
        type: "string",
        enum: [{ rawDeviceId: "550e8400-e29b-41d4-a716-446655440000" }]
      } as never),
      advancedDescriptor("main", "speechSynthesis", "speakNested", "Speak nested", [], {
        type: "string",
        enum: [{ items: { type: "string" } }]
      } as never),
      advancedDescriptor("main", "speechSynthesis", "speakControl", "Speak control", [], {
        type: "string",
        enum: ["safe", "bad\u0001value"]
      }),
      advancedDescriptor("main", "speechSynthesis", "speakLong", "Speak long", [], {
        type: "string",
        enum: ["x".repeat(1025)]
      } as never)
    ], []);

    const device = store.snapshot().devices[0];
    expect(device?.advancedCommands?.map((command) => command.command)).toEqual(["speak"]);
    expect(device?.advancedCommands?.[0]?.arguments[0]?.schema).toEqual({
      type: "string",
      enum: ["Hello", "Goodnight"]
    });
    expect(JSON.stringify(device)).not.toContain("items");
    expect(JSON.stringify(device)).not.toContain("550e8400-e29b-41d4-a716-446655440000");
  });

  test("keeps bounded string length schema in Advanced command catalogs", () => {
    const store = new DeviceStore();
    observeSnapshotState(store, {
      componentId: "main",
      capabilityId: "speechSynthesis",
      attributeName: "phrase",
      value: "",
      timestamp: "2026-09-01T00:00:00.000Z"
    });

    store.observeAdvancedCommandCatalog("dev_001", [
      advancedDescriptor("main", "speechSynthesis", "speak", "Speak", [], {
        type: "string",
        maxLength: 1000
      }),
      advancedDescriptor("main", "speechSynthesis", "speakBadMinimum", "Speak bad minimum", [], {
        type: "string",
        minLength: -1
      } as never),
      advancedDescriptor("main", "speechSynthesis", "speakBadMaximum", "Speak bad maximum", [], {
        type: "string",
        maxLength: 2049
      } as never),
      advancedDescriptor("main", "speechSynthesis", "speakBadRange", "Speak bad range", [], {
        type: "string",
        minLength: 10,
        maxLength: 4
      } as never)
    ], []);

    const device = store.snapshot().devices[0];
    expect(device?.advancedCommands?.map((command) => command.command)).toEqual(["speak"]);
    expect(device?.advancedCommands?.[0]?.arguments[0]?.schema).toEqual({
      type: "string",
      maxLength: 1000
    });
  });

  test("does not publish or persist unchanged Advanced command catalog observations", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-device-store-catalog-noop-"));
    try {
      const sqlitePath = join(root, "bridge.sqlite");
      const store = new DeviceStore({ sqlitePath });
      observeSnapshotState(store, {
        componentId: "main",
        capabilityId: "switch",
        attributeName: "switch",
        value: "off",
        timestamp: "2026-09-01T00:00:00.000Z"
      });
      store.observeAdvancedCommandCatalog("dev_001", [
        advancedDescriptor("main", "switch", "on"),
        advancedDescriptor("main", "switch", "off")
      ], []);
      store.close();
      const db = new DatabaseSync(sqlitePath);
      const persistedBefore = readPersistedSequence(db);
      db.close();

      const restored = new DeviceStore({ sqlitePath });
      const listener = vi.fn();
      restored.subscribe(listener);
      restored.observeAdvancedCommandCatalog("dev_001", [
        advancedDescriptor("main", "switch", "off"),
        advancedDescriptor("main", "switch", "on")
      ], []);

      expect(restored.currentSequence()).toBe(persistedBefore);
      expect(listener).not.toHaveBeenCalled();
      restored.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows may release node:sqlite file handles after the assertion completes.
      }
    }
  });

  test("persists Advanced command catalogs as deep-copied normalized inventory", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-device-store-catalog-persist-"));
    try {
      const sqlitePath = join(root, "bridge.sqlite");
      const first = new DeviceStore({ sqlitePath });
      observeSnapshotState(first, {
        componentId: "main",
        capabilityId: "switch",
        attributeName: "switch",
        value: "off",
        timestamp: "2026-09-01T00:00:00.000Z"
      });
      first.observeAdvancedCommandCatalog("dev_001", [
        advancedDescriptor("main", "switch", "on", "Power", [], {
          type: "string",
          enum: ["on", "off"],
          minLength: 1,
          maxLength: 3
        }),
        advancedDescriptor("main", "switch", "off", "Power")
      ], []);
      const beforeRestart = first.snapshot();
      beforeRestart.devices[0]?.advancedCommands?.[0]?.arguments.push({
        name: "mutated",
        required: true,
        sensitive: false,
        schema: { type: "string" }
      });
      first.close();

      const restored = new DeviceStore({ sqlitePath });
      const afterRestart = restored.snapshot();
      expect(afterRestart.devices[0]?.advancedCommands?.[0]?.arguments).toEqual([]);
      afterRestart.devices[0]?.advancedCommands?.[1]?.arguments[0]?.schema.enum?.push("mutated");
      expect(restored.snapshot().devices[0]?.advancedCommands?.[1]?.arguments[0]?.schema).toEqual({
        type: "string",
        enum: ["on", "off"],
        minLength: 1,
        maxLength: 3
      });
      expect(restored.snapshot().devices[0]?.advancedCommands?.[1]?.arguments[0]?.schema.enum).toEqual([
        "on",
        "off"
      ]);
      expect(JSON.stringify(restored.snapshot())).not.toContain("raw-command-device");
      restored.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows may release node:sqlite file handles after the assertion completes.
      }
    }
  });

  test("persists safe Advanced command capability roles across restart", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-device-store-catalog-role-"));
    try {
      const sqlitePath = join(root, "bridge.sqlite");
      const first = new DeviceStore({ sqlitePath });
      observeSnapshotState(first, {
        componentId: "identifier_component_main",
        capabilityId: "identifier_74292182f118",
        attributeName: "phrase",
        value: "",
        timestamp: "2026-09-01T00:00:00.000Z"
      });
      first.observeAdvancedCommandCatalog("dev_001", [
        {
          ...advancedDescriptor(
            "identifier_component_main",
            "identifier_74292182f118",
            "speak",
            "Speak",
            [phraseArgument()]
          ),
          capabilityRole: "speechsynthesis"
        }
      ], []);
      first.close();

      const restored = new DeviceStore({ sqlitePath });

      expect(restored.snapshot().devices[0]?.advancedCommands).toEqual([
        expect.objectContaining({
          capability: "identifier_74292182f118",
          capabilityRole: "speechsynthesis",
          command: "speak"
        })
      ]);
      restored.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows may release node:sqlite file handles after the assertion completes.
      }
    }
  });

  test("rejects malformed persisted Advanced catalog data without losing old inventories", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-device-store-catalog-bad-"));
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
          locations: [],
          rooms: [],
          scenes: [],
          devices: [
            {
              id: "dev_001",
              locationId: "loc_001",
              roomId: null,
              name: "Bad catalog",
              type: null,
              online: true,
              states: [],
              advancedCommands: [
                {
                  component: "main",
                  capability: "switch",
                  capabilityRole: "smartthings.speechSynthesis",
                  capabilityVersion: 1,
                  command: "on",
                  arguments: [{ name: "value", required: true, sensitive: false, schema: { type: "bad" } }],
                  transport: "advanced",
                  confirmation: "state",
                  label: "Power",
                  labelSource: "capability"
                }
              ]
            }
          ]
        }),
        "2026-09-01T00:00:00.000Z"
      );
      db.close();

      const restored = new DeviceStore({ sqlitePath });

      expect(restored.snapshot().devices).toEqual([]);
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

function persistedState(
  capability: string,
  attribute: string,
  value: null | number | string,
  unit: string | null,
  updatedAt: string
): Record<string, unknown> {
  return {
    component: "main",
    capability,
    attribute,
    value,
    unit,
    updatedAt
  };
}

function advancedDescriptor(
  component: string,
  capability: string,
  command: string,
  label = command,
  args: AdvancedCommandDescriptor["arguments"] = [],
  schema?: AdvancedCommandDescriptor["arguments"][number]["schema"]
): AdvancedCommandDescriptor {
  return {
    component,
    capability,
    capabilityVersion: 1,
    command,
    arguments: schema
      ? [{ name: "value", required: true, sensitive: false, schema }]
      : args,
    transport: "advanced",
    confirmation: "state",
    label,
    labelSource: "capability"
  };
}

function phraseArgument(): AdvancedCommandDescriptor["arguments"][number] {
  return {
    name: "phrase",
    required: true,
    sensitive: false,
    schema: { type: "string" }
  };
}

function advancedComponent(
  id: string,
  label: string,
  category: string,
  capabilityId = "identifier_contactSensor_advanced"
): Record<string, unknown> {
  return {
    id,
    label,
    categories: [{ name: category }],
    capabilities: [
      {
        id: capabilityId,
        status: {
          contact: {
            value: "open",
            timestamp: "2026-08-27T02:00:00.000Z"
          }
        }
      }
    ]
  };
}

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

function readPersistedSequence(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT inventory_json AS inventoryJson FROM normalized_inventory WHERE schema_version = 1")
    .get() as { inventoryJson: string };
  return (JSON.parse(row.inventoryJson) as { sequence: number }).sequence;
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

function observeDeviceSnapshot(store: DeviceStore, device: Record<string, unknown>): void {
  store.observe(sentFrame('424["find","api/device",{}]'));
  store.observe(receivedFrame(`434${JSON.stringify([null, [{ basic: device }]])}`));
}

function observeHealthSnapshot(store: DeviceStore, health: Record<string, unknown>): void {
  store.observe(sentFrame('425["find","api/device/health",{}]'));
  store.observe(receivedFrame(`435${JSON.stringify([null, [health]])}`));
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

function liveHealthEvent(overrides: Record<string, unknown>): SanitizedCaptureRecord {
  return receivedFrame(
    `42${JSON.stringify([
      "api/subscription DEVICE_HEALTH_EVENT",
      {
        data: {
          eventType: "DEVICE_HEALTH_EVENT",
          deviceHealthEvent: {
            deviceId: "dev_001",
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
