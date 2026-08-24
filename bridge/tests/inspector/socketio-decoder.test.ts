import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { decodeSocketIoTextFrame } from "../../src/inspector/socketio-decoder.js";

interface DuplicateFixture {
  event_name: string;
  fixture_deliveries: unknown[];
}

const fixture = JSON.parse(
  readFileSync("protocol/fixtures/2026-08-20-device-event-duplicate.sanitized.json", "utf8")
) as DuplicateFixture;

describe("decodeSocketIoTextFrame", () => {
  test("decodes the sanitized real DEVICE_EVENT envelope", () => {
    const raw = `42${JSON.stringify([fixture.event_name, fixture.fixture_deliveries[0]])}`;

    const decoded = decodeSocketIoTextFrame(raw);

    expect(decoded).toMatchObject({
      kind: "event",
      eventName: "api/subscription DEVICE_EVENT",
      args: [fixture.fixture_deliveries[0]]
    });
  });

  test.each([
    ["2", "ping"],
    ["3", "pong"],
    ['0{"sid":"[REDACTED]","pingInterval":25000}', "engine_open"],
    ['40{"sid":"[REDACTED]"}', "socket_connect"]
  ] as const)("decodes observed control frame %s", (raw, kind) => {
    expect(decodeSocketIoTextFrame(raw)).toMatchObject({ kind });
  });

  test("returns a bounded invalid result instead of throwing for malformed or oversized frames", () => {
    expect(decodeSocketIoTextFrame("42[broken-json")).toMatchObject({
      kind: "invalid",
      reason: "invalid_json"
    });
    expect(decodeSocketIoTextFrame(`42["event","${"x".repeat(100)}"]`, { maxBytes: 32 })).toMatchObject({
      kind: "invalid",
      reason: "frame_too_large"
    });
  });
});
