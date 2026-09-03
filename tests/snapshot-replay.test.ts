import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { replaySanitizedSnapshotFixture } from "../tools/replay-snapshot-fixture.js";

describe("sanitized snapshot ACK replay", () => {
  test("correlates all six required categories into one complete snapshot epoch", () => {
    const fixture = JSON.parse(
      readFileSync("protocol/fixtures/2026-08-20-snapshot-ack-correlations.sanitized.json", "utf8")
    ) as unknown;

    expect(replaySanitizedSnapshotFixture(fixture)).toEqual({
      correlations: 6,
      matchedCorrelations: 6,
      complete: true,
      categories: {
        locations: 2,
        rooms: 9,
        device_cards: 205,
        device_states: 1557,
        device_health: 212,
        scenes: 4
      },
      pendingRequests: 0
    });
  });
});
