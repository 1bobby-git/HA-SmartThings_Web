import { describe, expect, test } from "vitest";

import {
  ProtocolFingerprintError,
  protocolFingerprint
} from "../../src/inspector/protocol-fingerprint.js";

describe("protocolFingerprint", () => {
  test("ignores object key order while treating required key changes as protocol changes", () => {
    expect(protocolFingerprint({ device: { id: "a", state: true }, epoch: 1 })).toBe(
      protocolFingerprint({ epoch: 2, device: { state: false, id: "b" } })
    );

    expect(protocolFingerprint({ device: { id: "a", state: true }, epoch: 1 })).not.toBe(
      protocolFingerprint({ device: { id: "a" } })
    );
    expect(protocolFingerprint({ device: { id: "a" } })).not.toBe(
      protocolFingerprint({ device: { id: "a", state: true } })
    );
  });

  test("represents primitive leaves by type while keeping null distinct", () => {
    expect(protocolFingerprint({ label: "kitchen", power: 7, active: true })).toBe(
      protocolFingerprint({ label: "garage", power: 99, active: false })
    );

    expect(protocolFingerprint({ deletedAt: null })).not.toBe(
      protocolFingerprint({ deletedAt: "2026-08-20T00:00:00Z" })
    );
    expect(protocolFingerprint({ reading: Number.NaN })).toBe(
      protocolFingerprint({ reading: Number.POSITIVE_INFINITY })
    );
  });

  test("deduplicates and sorts array member shapes without preserving literal order or counts", () => {
    expect(
      protocolFingerprint({
        devices: [
          { id: "a", state: { online: true } },
          { id: "b", state: { online: false } },
          { id: "c", state: { online: true } }
        ]
      })
    ).toBe(
      protocolFingerprint({
        devices: [{ state: { online: false }, id: "z" }]
      })
    );
  });

  test("detects heterogeneous array member shape changes", () => {
    expect(
      protocolFingerprint({
        devices: [{ id: "a", state: { online: true } }]
      })
    ).not.toBe(
      protocolFingerprint({
        devices: [{ id: "a", state: { online: true } }, { id: "b", state: { battery: 80 } }]
      })
    );
  });

  test("is deterministic for nested objects and heterogeneous arrays", () => {
    const first = {
      payload: [
        { state: { switch: "on", level: 1 }, capabilities: ["switch", "level", "switch"] },
        { room: null }
      ]
    };
    const second = {
      payload: [
        { room: null },
        { capabilities: ["level"], state: { level: 100, switch: "off" } }
      ]
    };

    expect(protocolFingerprint(first)).toBe(protocolFingerprint(second));
  });

  test("returns a SHA-256 hex digest without leaking literal protocol values", () => {
    const fingerprint = protocolFingerprint({
      secretDeviceId: "literal-device-id",
      token: "literal-token",
      samples: ["literal-device-id", 42, null]
    });

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain("literal-device-id");
    expect(fingerprint).not.toContain("literal-token");
  });

  test("rejects self-referential cycles with a fixed safe error", () => {
    const value: Record<string, unknown> = {};
    value.self = value;

    expectProtocolFingerprintError(
      () => protocolFingerprint(value),
      "cyclic_structure",
      "Protocol fingerprint input contains a cycle."
    );
  });

  test("rejects mutual cycles with a fixed safe error", () => {
    const first: Record<string, unknown> = {};
    const second: Record<string, unknown> = { first };
    first.second = second;

    expectProtocolFingerprintError(
      () => protocolFingerprint(first),
      "cyclic_structure",
      "Protocol fingerprint input contains a cycle."
    );
  });

  test("rejects structures that exceed the configured depth", () => {
    expectProtocolFingerprintError(
      () => protocolFingerprint({ child: { child: { child: null } } }, { maxDepth: 2 }),
      "maximum_depth_exceeded",
      "Protocol fingerprint input exceeds maximum depth."
    );
  });

  test("rejects structures that exceed the configured node budget", () => {
    expectProtocolFingerprintError(
      () => protocolFingerprint({ first: null, second: true }, { maxNodes: 2 }),
      "maximum_nodes_exceeded",
      "Protocol fingerprint input exceeds maximum nodes."
    );
  });

  test("rejects unsupported objects and unsupported primitive types", () => {
    class DeviceEvent {
      readonly id = "literal-device-id";
    }

    for (const value of [new Date(), new Map(), new Set(), /literal-regexp/, new DeviceEvent()]) {
      expectProtocolFingerprintError(
        () => protocolFingerprint(value),
        "unsupported_object",
        "Protocol fingerprint input contains an unsupported value."
      );
    }

    for (const value of [undefined, () => "literal-function", Symbol("literal-symbol"), 1n]) {
      expectProtocolFingerprintError(
        () => protocolFingerprint({ value }),
        "unsupported_object",
        "Protocol fingerprint input contains an unsupported value."
      );
      expectProtocolFingerprintError(
        () => protocolFingerprint(value),
        "unsupported_object",
        "Protocol fingerprint input contains an unsupported value."
      );
    }
  });

  test("rejects plain-object accessors without invoking caller code", () => {
    const value = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(value, "secret", {
      enumerable: true,
      get() {
        throw new Error("literal getter should not run");
      }
    });

    expectProtocolFingerprintError(
      () => protocolFingerprint(value),
      "unsupported_object",
      "Protocol fingerprint input contains an unsupported value."
    );
  });

  test("rejects array index accessors without invoking caller code", () => {
    const value = ["safe"];
    Object.defineProperty(value, "0", {
      enumerable: true,
      get() {
        throw new Error("literal array getter should not run");
      }
    });

    expectProtocolFingerprintError(
      () => protocolFingerprint(value),
      "unsupported_object",
      "Protocol fingerprint input contains an unsupported value."
    );
  });

  test("rejects sparse arrays as unsupported values", () => {
    const value = new Array<unknown>(2);
    value[1] = "literal-value";

    expectProtocolFingerprintError(
      () => protocolFingerprint(value),
      "unsupported_object",
      "Protocol fingerprint input contains an unsupported value."
    );
  });

  test("rejects arrays with custom string or symbol properties", () => {
    const withStringProperty = ["literal-value"] as unknown[] & { extra?: string };
    withStringProperty.extra = "literal-extra";
    expectProtocolFingerprintError(
      () => protocolFingerprint(withStringProperty),
      "unsupported_object",
      "Protocol fingerprint input contains an unsupported value."
    );

    const withSymbolProperty = ["literal-value"];
    Object.defineProperty(withSymbolProperty, Symbol("literal-symbol"), {
      enumerable: true,
      value: "literal-symbol-value"
    });
    expectProtocolFingerprintError(
      () => protocolFingerprint(withSymbolProperty),
      "unsupported_object",
      "Protocol fingerprint input contains an unsupported value."
    );
  });

  test("rejects invalid safety options before walking input", () => {
    expectProtocolFingerprintError(
      () => protocolFingerprint({ ignored: "literal-value" }, { maxDepth: 0 }),
      "maximum_depth_exceeded",
      "Protocol fingerprint maxDepth must be a positive safe integer."
    );
    expectProtocolFingerprintError(
      () => protocolFingerprint({ ignored: "literal-value" }, { maxNodes: Number.NaN }),
      "maximum_nodes_exceeded",
      "Protocol fingerprint maxNodes must be a positive safe integer."
    );
  });
});

function expectProtocolFingerprintError(
  callback: () => unknown,
  code: ProtocolFingerprintError["code"],
  message: string
): void {
  expect(callback).toThrow(ProtocolFingerprintError);
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolFingerprintError);
    expect(error).toMatchObject({ code, message });
    expect(String(error)).not.toContain("literal");
    return;
  }
  throw new Error("Expected protocol fingerprint error");
}
