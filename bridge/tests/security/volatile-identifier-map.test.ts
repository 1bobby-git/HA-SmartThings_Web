import { describe, expect, test, vi } from "vitest";

import { VolatileIdentifierMap } from "../../src/security/volatile-identifier-map.js";

describe("VolatileIdentifierMap", () => {
  test("maps raw device, component, and capability identifiers from a received device event", () => {
    const alias = vi.fn((kind: "device" | "identifier", raw: string) =>
      kind === "device" ? `dev_${raw}` : `identifier_${raw}`
    );
    const identifiers = new VolatileIdentifierMap(alias);

    identifiers.observeRawWebSocketFrame(
      "received",
      `42${JSON.stringify([
        "api/subscription DEVICE_EVENT",
        {
          data: {
            device_event: {
              device_id: "raw-device",
              component: "main",
              capability: "switch",
              attribute: "switch",
              value: "on"
            }
          }
        }
      ])}`
    );

    expect(identifiers.rawDeviceId("dev_raw-device")).toBe("raw-device");
    expect(identifiers.rawDeviceId("dev_dev_raw-device")).toBe("raw-device");
    expect(identifiers.rawIdentifier("identifier_main")).toBe("main");
    expect(identifiers.rawIdentifier("identifier_switch")).toBe("switch");
    expect(identifiers.rawIdentifier("identifier_identifier_main")).toBe("main");
    expect(identifiers.rawIdentifier("identifier_identifier_switch")).toBe("switch");
    expect(identifiers.rawIdentifier("identifier_identifier_identifier_main")).toBe("main");
    expect(identifiers.rawIdentifier("identifier_identifier_identifier_switch")).toBe("switch");
    expect(identifiers.rawIdentifier("identifier_identifier_identifier_identifier_main")).toBe("main");
    expect(identifiers.rawIdentifier("identifier_identifier_identifier_identifier_switch")).toBe("switch");
  });

  test("maps identifiers from initial status ACKs and clears every raw value on reset", () => {
    const identifiers = new VolatileIdentifierMap((kind, raw) =>
      kind === "device" ? `dev_${raw}` : `identifier_${raw}`
    );

    identifiers.observeRawWebSocketFrame(
      "received",
      `431${JSON.stringify([
        null,
        [
          {
            deviceId: "raw-device",
            componentId: "main",
            capabilityId: "switch",
            attributeName: "switch",
            value: "off"
          }
        ]
      ])}`
    );

    expect(identifiers.rawDeviceId("dev_raw-device")).toBe("raw-device");
    expect(identifiers.rawDeviceId("dev_dev_raw-device")).toBe("raw-device");
    expect(identifiers.rawIdentifier("identifier_main")).toBe("main");
    expect(identifiers.rawIdentifier("identifier_switch")).toBe("switch");

    identifiers.reset();

    expect(identifiers.rawDeviceId("dev_raw-device")).toBeUndefined();
    expect(identifiers.rawDeviceId("dev_dev_raw-device")).toBeUndefined();
    expect(identifiers.rawIdentifier("identifier_main")).toBeUndefined();
    expect(identifiers.rawIdentifier("identifier_switch")).toBeUndefined();
  });

  test("maps a device from a full snapshot larger than the diagnostic capture text limit", () => {
    const identifiers = new VolatileIdentifierMap((kind, raw) =>
      kind === "device" ? `dev_${raw}` : `identifier_${raw}`
    );
    const filler = "x".repeat(1_200_000);

    identifiers.observeRawWebSocketFrame(
      "received",
      `431${JSON.stringify([
        null,
        [{ deviceId: "large-device", componentId: "main", capabilityId: "switch", filler }]
      ])}`
    );

    expect(identifiers.rawDeviceId("dev_large-device")).toBe("large-device");
    expect(identifiers.rawDeviceId("dev_dev_large-device")).toBe("large-device");
    expect(identifiers.rawIdentifier("identifier_identifier_identifier_identifier_main")).toBe("main");
  });

  test("ignores unrelated ids and malformed or oversized frames", () => {
    const alias = vi.fn((kind: "device" | "identifier", raw: string) =>
      kind === "device" ? `dev_${raw}` : `identifier_${raw}`
    );
    const identifiers = new VolatileIdentifierMap(alias);

    identifiers.observeRawWebSocketFrame("received", '42["event",{"id":"not-a-device"}]');
    identifiers.observeRawWebSocketFrame("received", "not-socket-io");
    identifiers.observeRawWebSocketFrame("received", `42["event","${"x".repeat(8 * 1024 * 1024)}"]`);

    expect(alias).not.toHaveBeenCalled();
  });
});
