import { describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      rmSync(root, { recursive: true, force: true });
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

function sentFrame(text: string): SanitizedCaptureRecord {
  return capture("sent", text);
}

function receivedFrame(text: string): SanitizedCaptureRecord {
  return capture("received", text);
}

function capture(direction: "sent" | "received", text: string): SanitizedCaptureRecord {
  return {
    __sanitized: true,
    source: "playwright-websocket-frame",
    receivedAt: "2026-08-24T21:00:00.000Z",
    payload: { direction, frame: { payload: text, truncated: false } },
    payloadHash: "fixture"
  };
}
