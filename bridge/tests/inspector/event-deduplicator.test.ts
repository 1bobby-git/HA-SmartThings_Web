import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import {
  EventDeduplicator,
  createEventIdentity,
  extractDeviceEventIdentity,
  type EventIdentityInput
} from "../../src/inspector/event-deduplicator.js";

interface FixtureDelivery {
  data: {
    device_event: {
      event_id: string;
      device_id: string;
      location_id: string;
      component: string;
      capability: string;
      attribute: string;
      state_change: boolean;
    };
  };
}

interface DuplicateFixture {
  fixture_deliveries: FixtureDelivery[];
  expected_unique_events: number;
}

const fixture = JSON.parse(
  readFileSync("protocol/fixtures/2026-08-20-device-event-duplicate.sanitized.json", "utf8")
) as DuplicateFixture;

function identityInput(delivery: FixtureDelivery): EventIdentityInput {
  const event = delivery.data.device_event;
  return {
    eventId: event.event_id,
    deviceId: event.device_id,
    locationId: event.location_id,
    component: event.component,
    capability: event.capability,
    attribute: event.attribute,
    stateChange: event.state_change
  };
}

describe("EventDeduplicator", () => {
  test("extracts identity fields from sanitized real fixture deliveries", () => {
    expect(extractDeviceEventIdentity(fixture.fixture_deliveries[0])).toMatchObject({
      eventId: "evt_001",
      deviceId: "dev_001",
      locationId: "loc_001",
      component: "main",
      capability: "fineDustSensor",
      attribute: "fineDustLevel",
      stateChange: true
    });
    expect(extractDeviceEventIdentity({ data: { event_type: "CONTROL_EVENT" } })).toBeNull();
  });

  test("collapses three sanitized deliveries from one real event ID into one logical event", () => {
    let now = 1_000;
    const dedupe = new EventDeduplicator({ ttlMs: 60_000, maxEntries: 100, now: () => now });

    const results = fixture.fixture_deliveries.map((delivery) => {
      now += 1;
      return dedupe.observe(identityInput(delivery));
    });

    expect(results.filter((result) => !result.duplicate)).toHaveLength(fixture.expected_unique_events);
    expect(results.map((result) => result.occurrence)).toEqual([1, 2, 3]);
    expect(new Set(results.map((result) => result.key))).toHaveLength(1);
  });

  test("uses a deterministic canonical hash when eventId is unavailable", () => {
    const first = createEventIdentity({
      deviceId: "dev_001",
      locationId: "loc_001",
      component: "main",
      capability: "contactSensor",
      attribute: "contact",
      stateChange: true,
      payloadHash: "payload_hash_001"
    });
    const same = createEventIdentity({
      payloadHash: "payload_hash_001",
      stateChange: true,
      attribute: "contact",
      capability: "contactSensor",
      component: "main",
      locationId: "loc_001",
      deviceId: "dev_001"
    });
    const different = createEventIdentity({
      deviceId: "dev_001",
      locationId: "loc_001",
      component: "main",
      capability: "contactSensor",
      attribute: "contact",
      stateChange: true,
      payloadHash: "payload_hash_002"
    });

    expect(first.source).toBe("fingerprint");
    expect(first.key).toBe(same.key);
    expect(first.key).not.toBe(different.key);
  });

  test("accepts an event again after TTL and keeps the journal bounded", () => {
    let now = 0;
    const dedupe = new EventDeduplicator({ ttlMs: 10, maxEntries: 2, now: () => now });

    expect(dedupe.observe({ eventId: "evt_001" }).duplicate).toBe(false);
    now = 5;
    expect(dedupe.observe({ eventId: "evt_001" }).duplicate).toBe(true);
    now = 11;
    expect(dedupe.observe({ eventId: "evt_001" }).duplicate).toBe(false);
    dedupe.observe({ eventId: "evt_002" });
    dedupe.observe({ eventId: "evt_003" });

    expect(dedupe.size).toBe(2);
  });
});
