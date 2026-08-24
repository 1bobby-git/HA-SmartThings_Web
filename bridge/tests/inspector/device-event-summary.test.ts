import { describe, expect, test } from "vitest";

import { extractDeviceEventSummary } from "../../src/inspector/device-event-summary.js";

describe("extractDeviceEventSummary", () => {
  test("extracts frozen safe metadata from a valid snake-case DEVICE_EVENT", () => {
    const summary = extractDeviceEventSummary(
      deviceEvent({
        event_id: "evt_secret_001",
        device_id: "dev_001",
        location_id: "loc_secret_001",
        component: "main",
        capability: "switch",
        attribute: "switch",
        value: "on",
        unit: "secret_unit",
        state_change: true,
        event_time: "2026-08-24T00:00:00.000Z"
      })
    );

    expect(summary).not.toBeNull();
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary?.safe)).toBe(true);
    expect(summary?.safe).toEqual({
      deviceAlias: "dev_001",
      component: "main",
      capability: "switch",
      attribute: "switch",
      valueType: "string",
      unitPresent: true,
      stateChange: true,
      sourceEventAtMs: Date.parse("2026-08-24T00:00:00.000Z")
    });
    expect(summary?.matchesExpectedValue("on")).toBe(true);
    expect(summary?.matchesExpectedValue("ON")).toBe(false);
  });

  test("rejects unsafe device aliases", () => {
    for (const device_id of ["raw-device-id", "dev_1", "dev_001?token=x"]) {
      expect(extractDeviceEventSummary(deviceEvent({ device_id }))).toBeNull();
    }
  });

  test("rejects overlong and newline component, capability, or attribute tokens", () => {
    const overlong = "a".repeat(129);

    expect(extractDeviceEventSummary(deviceEvent({ component: overlong }))).toBeNull();
    expect(extractDeviceEventSummary(deviceEvent({ capability: "switch\nmain" }))).toBeNull();
    expect(extractDeviceEventSummary(deviceEvent({ attribute: overlong }))).toBeNull();
  });

  test("omits invalid timestamps", () => {
    const summary = extractDeviceEventSummary(
      deviceEvent({
        event_time: "not-a-date"
      })
    );

    expect(summary?.safe).not.toHaveProperty("sourceEventAtMs");
  });

  test("distinguishes every value type", () => {
    expect(extractDeviceEventSummary(deviceEvent({ value: null }))?.safe.valueType).toBe("null");
    expect(extractDeviceEventSummary(deviceEvent({ value: true }))?.safe.valueType).toBe("boolean");
    expect(extractDeviceEventSummary(deviceEvent({ value: 7 }))?.safe.valueType).toBe("number");
    expect(extractDeviceEventSummary(deviceEvent({ value: "7" }))?.safe.valueType).toBe("string");
    expect(extractDeviceEventSummary(deviceEvent({ value: ["on"] }))?.safe.valueType).toBe("array");
    expect(extractDeviceEventSummary(deviceEvent({ value: { current: "on" } }))?.safe.valueType).toBe("object");
  });

  test("keeps raw values and event IDs out of enumerable serialization", () => {
    const summary = extractDeviceEventSummary(
      deviceEvent({
        event_id: "evt_secret_001",
        location_id: "loc_secret_001",
        value: "raw-secret-value",
        unit: "secret_unit"
      })
    );

    expect(summary?.matchesExpectedValue("raw-secret-value")).toBe(true);
    expect(summary?.matchesExpectedValue("raw")).toBe(false);
    expect(JSON.stringify(summary)).toBe(
      JSON.stringify({
        safe: {
          deviceAlias: "dev_001",
          component: "main",
          capability: "switch",
          attribute: "switch",
          valueType: "string",
          unitPresent: true,
          stateChange: true
        }
      })
    );
    expect(Object.keys(summary ?? {})).toEqual(["safe", "matchesExpectedValue"]);
    expect(JSON.stringify(summary)).not.toContain("raw-secret-value");
    expect(JSON.stringify(summary)).not.toContain("evt_secret_001");
    expect(JSON.stringify(summary)).not.toContain("loc_secret_001");
    expect(JSON.stringify(summary)).not.toContain("secret_unit");
  });

  test("accepts camel-case envelope and event fields", () => {
    const summary = extractDeviceEventSummary({
      data: {
        eventType: "DEVICE_EVENT",
        deviceEvent: {
          deviceId: "dev_123",
          component: "main",
          capability: "contactSensor",
          attribute: "contact",
          value: "closed",
          unit: null,
          stateChange: false,
          eventTime: "2026-08-24T01:02:03.000Z"
        }
      }
    });

    expect(summary?.safe).toEqual({
      deviceAlias: "dev_123",
      component: "main",
      capability: "contactSensor",
      attribute: "contact",
      valueType: "string",
      unitPresent: false,
      stateChange: false,
      sourceEventAtMs: Date.parse("2026-08-24T01:02:03.000Z")
    });
  });

  test("ignores unrelated or malformed envelopes", () => {
    expect(extractDeviceEventSummary({ data: { event_type: "OTHER_EVENT" } })).toBeNull();
    expect(extractDeviceEventSummary({ data: { event_type: "DEVICE_EVENT" } })).toBeNull();
    expect(extractDeviceEventSummary(null)).toBeNull();
  });
});

function deviceEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    data: {
      event_type: "DEVICE_EVENT",
      device_event: {
        device_id: "dev_001",
        component: "main",
        capability: "switch",
        attribute: "switch",
        value: "on",
        unit: "percent",
        state_change: true,
        ...overrides
      }
    }
  };
}
