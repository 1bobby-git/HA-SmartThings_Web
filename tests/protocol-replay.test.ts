import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { replaySanitizedDeviceEventFixture } from "../tools/replay-device-event-fixture.js";

describe("sanitized DEVICE_EVENT replay", () => {
  test("decodes and collapses the real duplicate fixture to one logical event", () => {
    const fixture = JSON.parse(
      readFileSync("protocol/fixtures/2026-08-20-device-event-duplicate.sanitized.json", "utf8")
    ) as unknown;

    expect(replaySanitizedDeviceEventFixture(fixture)).toEqual({
      eventName: "api/subscription DEVICE_EVENT",
      fixtureDeliveries: 3,
      decodedDeviceEvents: 3,
      uniqueLogicalEvents: 1,
      duplicateDeliveries: 2,
      invalidFrames: 0,
      expectedUniqueEvents: 1,
      matchesExpectation: true
    });
  });
});
