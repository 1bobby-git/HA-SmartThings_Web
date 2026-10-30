import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { SqliteAliasStore } from "../../src/security/alias-store.js";
import { createRedactor } from "../../src/security/redactor.js";
import { VolatileIdentifierMap } from "../../src/security/volatile-identifier-map.js";
import { DeviceStore } from "../../src/state/device-store.js";

const LOCATION = "6f1c2f9e-6a4b-4f41-9a55-0c6b3e0d1a01";
const DEVICES = [
  ["0b7d9c64-0d0f-4b8e-8a9b-1d7a0d5b2c01", "Lamp"],
  ["2a9b5c3e-6d1f-4c7a-9e8b-3f4a5b6c7d02", "Fan plug"],
  ["9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c03", "Heater"]
] as const;

function rawDevice(deviceId: string, label: string) {
  return {
    deviceId,
    locationId: LOCATION,
    label,
    components: [
      {
        id: "main",
        capabilities: [
          {
            id: "switch",
            version: 1,
            status: { switch: { value: "off", timestamp: "2026-09-01T00:00:00.000Z" } }
          }
        ]
      }
    ]
  };
}

// Wires the alias store the way runtime.ts does: redactor, then DeviceStore
// normalization, and the camera store's alias(alias(raw)).
function install(secret: string, order: number[]) {
  const root = mkdtempSync(join(tmpdir(), "stw-alias-pipeline-"));
  const aliases = new SqliteAliasStore(join(root, "bridge.sqlite"), secret);
  try {
    const redactor = createRedactor(aliases);
    const volatile = new VolatileIdentifierMap(
      (kind, raw) => aliases.alias(kind, raw),
      (raw) => aliases.alias("location", raw)
    );
    const devices = new DeviceStore({
      normalizeStateToken: (value) =>
        aliases.alias("identifier", aliases.alias("identifier", value)),
      normalizeAdvancedAlias: (kind, value) => aliases.alias(kind, value),
      identifierRole: (value) => volatile.semanticIdentifierRole(value)
    });
    const raw = {
      locations: [{ locationId: LOCATION, name: "Home" }],
      rooms: [],
      devices: order.map((index) => rawDevice(DEVICES[index]![0], DEVICES[index]![1]))
    };
    volatile.observeRawAdvancedDeviceSnapshot({ items: raw.devices });
    devices.observeAdvancedInventorySnapshot(redactor(raw) as Parameters<
      DeviceStore["observeAdvancedInventorySnapshot"]
    >[0], { authoritativeWholeSnapshot: true });
    const snapshot = devices.snapshot();
    return {
      locations: snapshot.locations.map((location) => location.id),
      devices: Object.fromEntries(snapshot.devices.map((device) => [device.name, device.id])),
      stateTokens: Object.fromEntries(
        snapshot.devices.map((device) => [
          device.name,
          device.states.map((state) => `${state.component}_${state.capability}`)
        ])
      ),
      camera: Object.fromEntries(
        DEVICES.map(([rawId, name]) => [name, aliases.alias("device", aliases.alias("device", rawId))])
      )
    };
  } finally {
    aliases.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("public IDs after a Bridge data reset", () => {
  test("device and location IDs survive an empty database, a new secret and a new order", () => {
    const before = install("secret-before-reinstall-0123456789abcdef", [0, 1, 2]);
    const after = install("secret-after-reinstall-fedcba9876543210", [2, 0, 1]);

    expect(Object.keys(before.devices).sort()).toEqual(["Fan plug", "Heater", "Lamp"]);
    expect(after.devices).toEqual(before.devices);
    expect(after.locations).toEqual(before.locations);
    expect(before.locations).toHaveLength(1);
    // Camera images are cached under the same public ID as the inventory.
    expect(before.camera).toEqual(before.devices);
    // Component and capability tokens stay HMAC-keyed by the bridge secret, so
    // per-capability entity IDs change on a reinstall (documented in 1.8.64).
    expect(after.stateTokens).not.toEqual(before.stateTokens);
  });
});
