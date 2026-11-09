import { describe, expect, test } from "vitest";
import { summarizeAckFrame, validateSnapshotResponseShape } from "../../src/inspector/snapshot-response-diagnostics.js";

describe("snapshot response diagnostics", () => {
  test("counts malformed cards beyond the preview without exposing values or arbitrary keys", () => {
    const rows = Array.from({ length: 5 }, (_, index) => index === 4
      ? { basic: { deviceId: "", locationId: 123, token: "secret" }, privateName: "raw-name" }
      : { basic: { deviceId: `raw-${index}`, locationId: "raw-location" } });
    const shape = summarizeAckFrame(`431[null,${JSON.stringify(rows)}]`);
    expect(shape?.cards).toMatchObject({ total: 5, missingDeviceId: 1, missingLocationId: 1 });
    expect(shape?.firstCards).toHaveLength(3);
    expect(shape?.cardShapeGroups).toHaveLength(2);
    expect(shape?.cardShapeGroups[1]).toMatchObject({ count: 1, shape: { deviceId: "empty_string", locationId: "non_string" } });
    expect(JSON.stringify(shape)).not.toMatch(/secret|raw-|raw-name|raw-location|privateName|token/);
  });

  test("keeps wire envelope and parser body interpretation separate", () => {
    const shape = summarizeAckFrame('432[{"data":[{"basic":{"deviceId":"raw-id"}}],"name":"NotAuthenticated","message":"secret"}]');
    expect(shape).toMatchObject({ argCount: 1, argTypes: ["object"], bodyType: "array", singleArgEnvelope: true,
      dataType: "array", error: { name: "NotAuthenticated", messageType: "string" } });
    expect(JSON.stringify(shape)).not.toContain("secret");
  });

  test("rejects tampered known fields and strips extra fields", () => {
    const shape = summarizeAckFrame('433[null,{"data":[]}]');
    expect(shape).not.toBeNull();
    expect(validateSnapshotResponseShape({ ...shape, leaked: "secret" })).toEqual(shape);
    expect(validateSnapshotResponseShape({ ...shape, bodyType: "secret" })).toBeNull();
  });
});
