import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { ProtocolAnalyzer } from "../../src/inspector/protocol-analyzer.js";
import {
  PROTOCOL_CONTRACT_FINGERPRINT,
  PROTOCOL_CONTRACT_VERSION,
  REQUIRED_PROTOCOL_SURFACES,
  type SafeProtocolSurface
} from "../../src/inspector/protocol-contract.js";
import { sanitizeCaptureRecord } from "../../src/state/capture-store.js";

interface DuplicateFixture {
  event_name: string;
  fixture_deliveries: unknown[];
}

interface SnapshotFixture {
  correlations: Array<{
    ack_id: string;
    request_event: string;
    request_query: string;
    request_keys: string[];
    response_category: string;
    response_count: number;
    response_item_keys: string[];
    response_keys?: string[];
  }>;
}

const fixture = JSON.parse(
  readFileSync("protocol/fixtures/2026-08-20-device-event-duplicate.sanitized.json", "utf8")
) as DuplicateFixture;
const snapshotFixture = JSON.parse(
  readFileSync("protocol/fixtures/2026-08-20-snapshot-ack-correlations.sanitized.json", "utf8")
) as SnapshotFixture;

const identityRedactor = (value: unknown) => value;

describe("ProtocolAnalyzer", () => {
  test("decodes and deduplicates sanitized Playwright capture records", () => {
    let now = 1_000;
    const analyzer = new ProtocolAnalyzer({ ttlMs: 60_000, maxEntries: 100, now: () => now });

    const results = fixture.fixture_deliveries.map((delivery) => {
      now += 1;
      return analyzer.observe(
        sanitizeCaptureRecord(
          "playwright-websocket-frame",
          {
            direction: "received",
            frame: {
              payload: `42${JSON.stringify([fixture.event_name, delivery])}`,
              truncated: false
            }
          },
          identityRedactor
        )
      );
    });

    expect(results.map((result) => result?.kind)).toEqual(["new", "duplicate", "duplicate"]);
    expect(analyzer.snapshot()).toEqual({
      decodedDeviceEvents: 3,
      uniqueLogicalEvents: 1,
      duplicateDeliveries: 2,
      invalidFrames: 0,
      journalSize: 1,
      snapshotComplete: false,
      snapshotCategories: {},
      pendingSnapshotRequests: 0,
      protocolComplete: false,
      protocolMismatchCount: 0
    });

    analyzer.reset();
    expect(analyzer.snapshot()).toEqual({
      decodedDeviceEvents: 0,
      uniqueLogicalEvents: 0,
      duplicateDeliveries: 0,
      invalidFrames: 0,
      journalSize: 0,
      snapshotComplete: false,
      snapshotCategories: {},
      pendingSnapshotRequests: 0,
      protocolComplete: false,
      protocolMismatchCount: 0
    });
  });

  test("returns dedupe correlation metadata and safe summaries for switch event deliveries", () => {
    const analyzer = new ProtocolAnalyzer({ ttlMs: 60_000, maxEntries: 100 });
    const delivery = sanitizedSwitchDelivery();

    const first = analyzer.observe(deviceEventRecord(delivery));
    const duplicate = analyzer.observe(cdpDeviceEventRecord(delivery));

    expect(first).toMatchObject({
      kind: "new",
      identitySource: "event_id",
      occurrence: 1,
      event: {
        safe: {
          deviceAlias: "dev_001",
          component: "main",
          capability: "switch",
          attribute: "switch",
          valueType: "string",
          unitPresent: false,
          stateChange: true
        }
      }
    });
    expect(first).toHaveProperty("key", expect.stringMatching(/^event_id:/));
    expect(duplicate).toMatchObject({
      kind: "duplicate",
      identitySource: "event_id",
      occurrence: 2,
      event: {
        safe: {
          deviceAlias: "dev_001",
          component: "main",
          capability: "switch",
          attribute: "switch",
          valueType: "string",
          unitPresent: false,
          stateChange: true
        }
      }
    });
    expect(duplicate).toHaveProperty("key", first?.kind === "new" ? first.key : expect.stringMatching(/^event_id:/));

    const serializedEvent = JSON.stringify(first?.kind === "new" ? first.event : null);
    expect(serializedEvent).not.toContain("value_raw");
    expect(serializedEvent).not.toContain("event_id");
    expect(serializedEvent).not.toContain("identifier_deadbeef0000");
  });

  test("keeps identity-valid unsafe aliases deduplicated while omitting event summary", () => {
    const analyzer = new ProtocolAnalyzer({ ttlMs: 60_000, maxEntries: 100 });
    const delivery = sanitizedSwitchDelivery({ device_id: "unsafe alias" });

    expect(analyzer.observe(deviceEventRecord(delivery))).toMatchObject({
      kind: "new",
      identitySource: "event_id",
      occurrence: 1,
      event: null
    });
    expect(analyzer.observe(cdpDeviceEventRecord(delivery))).toMatchObject({
      kind: "duplicate",
      identitySource: "event_id",
      occurrence: 2,
      event: null
    });
    expect(analyzer.snapshot()).toMatchObject({
      decodedDeviceEvents: 2,
      uniqueLogicalEvents: 1,
      duplicateDeliveries: 1,
      invalidFrames: 0,
      protocolMismatchCount: 0
    });
  });

  test("keeps distinct missing-ID events while deduplicating the same sanitized payload across observers", () => {
    const analyzer = new ProtocolAnalyzer({ ttlMs: 60_000, maxEntries: 100 });
    const firstDelivery = deviceEventWithoutId({ value: "off", event_time: "2026-08-24T00:00:00Z" });
    const changedDelivery = deviceEventWithoutId({ value: "on", event_time: "2026-08-24T00:00:01Z" });

    expect(analyzer.observe(deviceEventRecord(firstDelivery))).toMatchObject({
      kind: "new",
      identitySource: "fingerprint"
    });
    expect(analyzer.observe(cdpDeviceEventRecord(firstDelivery))).toMatchObject({
      kind: "duplicate",
      identitySource: "fingerprint"
    });
    expect(analyzer.observe(deviceEventRecord(changedDelivery))).toMatchObject({ kind: "new" });
    expect(analyzer.snapshot()).toMatchObject({
      decodedDeviceEvents: 3,
      uniqueLogicalEvents: 2,
      duplicateDeliveries: 1,
      journalSize: 2
    });
  });

  test("supports sanitized CDP payloads and ignores outgoing, truncated, and unrelated frames", () => {
    const analyzer = new ProtocolAnalyzer({ ttlMs: 60_000, maxEntries: 100 });
    const delivery = fixture.fixture_deliveries[0];
    const raw = `42${JSON.stringify([fixture.event_name, delivery])}`;

    expect(
      analyzer.observe(
        sanitizeCaptureRecord(
          "cdp-websocket-frame",
          { direction: "received", payload: { response: { payloadData: raw, truncated: false } } },
          identityRedactor
        )
      )?.kind
    ).toBe("new");
    expect(
      analyzer.observe(
        sanitizeCaptureRecord(
          "cdp-websocket-frame",
          { direction: "sent", payload: { response: { payloadData: raw, truncated: false } } },
          identityRedactor
        )
      )
    ).toBeNull();
    expect(
      analyzer.observe(
        sanitizeCaptureRecord(
          "playwright-websocket-frame",
          { direction: "received", frame: { payload: raw, truncated: true } },
          identityRedactor
        )
      )
    ).toBeNull();
    expect(
      analyzer.observe(
        sanitizeCaptureRecord(
          "playwright-websocket-frame",
          {
            direction: "received",
            frame: {
              payload: '42["api/subscription OTHER_EVENT",{"data":{"event_type":"OTHER_EVENT"}}]',
              truncated: false
            }
          },
          identityRedactor
        )
      )
    ).toBeNull();
  });

  test("correlates sanitized sent requests and received ACKs into a complete snapshot", () => {
    const analyzer = new ProtocolAnalyzer({ ttlMs: 60_000, maxEntries: 100 });

    for (const correlation of snapshotFixture.correlations) {
      const ackId = Number(correlation.ack_id.split("_")[1]);
      analyzer.observe(
        sanitizeCaptureRecord(
          "playwright-websocket-frame",
          {
            direction: "sent",
            frame: {
              payload: `42${ackId}${JSON.stringify([
                correlation.request_event,
                correlation.request_query,
                Object.fromEntries(correlation.request_keys.map((key) => [key, null]))
              ])}`,
              truncated: false
            }
          },
          identityRedactor
        )
      );
      const result = analyzer.observe(
        sanitizeCaptureRecord(
          "playwright-websocket-frame",
          {
            direction: "received",
            frame: {
              payload: `43${ackId}${JSON.stringify([null, buildSnapshotResponse(correlation)])}`,
              truncated: false
            }
          },
          identityRedactor
        )
      );
      expect(result).toMatchObject({ kind: "snapshot", category: correlation.response_category });
    }

    expect(analyzer.snapshot()).toMatchObject({
      snapshotComplete: true,
      snapshotCategories: {
        locations: 2,
        rooms: 9,
        device_cards: 205,
        device_states: 1557,
        device_health: 212,
        scenes: 4
      },
      pendingSnapshotRequests: 0,
      protocolComplete: false,
      protocolMismatchCount: 0
    });
  });

  test("marks the protocol complete only after all six snapshot surfaces and device event surface are observed in one epoch", () => {
    const analyzer = new ProtocolAnalyzer({ ttlMs: 60_000, maxEntries: 100 });

    observeAllSnapshots(analyzer);
    expect(analyzer.snapshot()).toMatchObject({
      snapshotComplete: true,
      protocolComplete: false,
      protocolMismatchCount: 0
    });
    expect(analyzer.snapshot().protocolFingerprint).toBeUndefined();

    const result = analyzer.observe(deviceEventRecord(fixture.fixture_deliveries[0]));
    expect(result).toMatchObject({ kind: "new" });

    expect(analyzer.snapshot()).toMatchObject({
      protocolComplete: true,
      protocolFingerprint: PROTOCOL_CONTRACT_FINGERPRINT,
      protocolMismatchCount: 0
    });
  });

  test("exports exactly the seven safe protocol surfaces used for completion", () => {
    const surfaces = [...REQUIRED_PROTOCOL_SURFACES].sort();
    expect(surfaces).toEqual([
      "event:device_event:v1",
      "snapshot:device_cards:v1",
      "snapshot:device_health:v1",
      "snapshot:device_states:v1",
      "snapshot:locations:v1",
      "snapshot:rooms:v1",
      "snapshot:scenes:v1"
    ] satisfies SafeProtocolSurface[]);
    expect(new Set(REQUIRED_PROTOCOL_SURFACES).size).toBe(7);
    expect(PROTOCOL_CONTRACT_VERSION).toBe(2);
    expect(PROTOCOL_CONTRACT_FINGERPRINT).toMatch(/^[a-f0-9]{64}$/);
  });

  test("reports known snapshot response-shape mismatches without raw payload and dedupes per surface per epoch", () => {
    const analyzer = new ProtocolAnalyzer({ ttlMs: 60_000, maxEntries: 100 });

    expect(observeSnapshotMismatch(analyzer, 1)).toEqual({
      kind: "protocol_changed",
      surface: "snapshot:scenes:response_shape"
    });
    expect(observeSnapshotMismatch(analyzer, 2)).toEqual({
      kind: "protocol_changed",
      surface: "snapshot:scenes:response_shape"
    });

    expect(analyzer.snapshot()).toMatchObject({
      invalidFrames: 0,
      protocolComplete: false,
      protocolMismatchCount: 1,
      protocolMismatchSurface: "snapshot:scenes:response_shape"
    });
  });

  test("accepts optional payload fields without reporting a protocol change", () => {
    const analyzer = new ProtocolAnalyzer({ ttlMs: 60_000, maxEntries: 100 });
    analyzer.observe(sanitizedFrame("sent", '421["find","api/room",{"optional":true}]'));

    expect(
      analyzer.observe(
        sanitizedFrame(
          "received",
          `431${JSON.stringify([null, [{ roomId: null, locationId: null, optionalField: null }]])}`
        )
      )
    ).toEqual({ kind: "snapshot", requestEvent: "find", category: "rooms", count: 1 });

    const delivery = {
      ...(fixture.fixture_deliveries[0] as Record<string, unknown>),
      optionalEnvelopeField: true
    };
    expect(analyzer.observe(deviceEventRecord(delivery))).toMatchObject({ kind: "new" });
    expect(analyzer.snapshot()).toMatchObject({ protocolMismatchCount: 0, invalidFrames: 0 });
  });

  test("reports exact DEVICE_EVENT identity mismatches and ignores unrelated events", () => {
    const analyzer = new ProtocolAnalyzer({ ttlMs: 60_000, maxEntries: 100 });

    expect(
      analyzer.observe(
        sanitizedFrame(
          "received",
          '42["api/subscription OTHER_EVENT",{"data":{"event_type":"OTHER_EVENT"}}]'
        )
      )
    ).toBeNull();
    expect(
      analyzer.observe(
        sanitizedFrame(
          "received",
          '42["api/subscription DEVICE_EVENT",{"data":{"event_type":"DEVICE_EVENT"}}]'
        )
      )
    ).toEqual({ kind: "protocol_changed", surface: "event:device_event:identity" });

    expect(analyzer.snapshot()).toMatchObject({
      invalidFrames: 1,
      protocolComplete: false,
      protocolMismatchCount: 1,
      protocolMismatchSurface: "event:device_event:identity"
    });
  });

  test("reset clears observed protocol surfaces, mismatches, and counters", () => {
    const analyzer = new ProtocolAnalyzer({ ttlMs: 60_000, maxEntries: 100 });

    observeAllSnapshots(analyzer);
    analyzer.observe(deviceEventRecord(fixture.fixture_deliveries[0]));
    observeSnapshotMismatch(analyzer, 50);
    expect(analyzer.snapshot()).toMatchObject({
      protocolComplete: true,
      protocolMismatchCount: 1,
      decodedDeviceEvents: 1
    });

    analyzer.reset();
    expect(analyzer.snapshot()).toEqual({
      decodedDeviceEvents: 0,
      uniqueLogicalEvents: 0,
      duplicateDeliveries: 0,
      invalidFrames: 0,
      journalSize: 0,
      snapshotComplete: false,
      snapshotCategories: {},
      pendingSnapshotRequests: 0,
      protocolComplete: false,
      protocolMismatchCount: 0
    });
  });
});

function observeAllSnapshots(analyzer: ProtocolAnalyzer): void {
  for (const correlation of snapshotFixture.correlations) {
    const ackId = Number(correlation.ack_id.split("_")[1]);
    analyzer.observe(
      sanitizedFrame(
        "sent",
        `42${ackId}${JSON.stringify([
          correlation.request_event,
          correlation.request_query,
          Object.fromEntries(correlation.request_keys.map((key) => [key, null]))
        ])}`
      )
    );
    analyzer.observe(
      sanitizedFrame("received", `43${ackId}${JSON.stringify([null, buildSnapshotResponse(correlation)])}`)
    );
  }
}

function observeSnapshotMismatch(analyzer: ProtocolAnalyzer, ackId: number) {
  analyzer.observe(sanitizedFrame("sent", `42${ackId}${JSON.stringify(["find", "api/scene", {}])}`));
  return analyzer.observe(
    sanitizedFrame("received", `43${ackId}${JSON.stringify([null, [{ roomId: null, locationId: null }]])}`)
  );
}

function deviceEventRecord(delivery: unknown) {
  return sanitizedFrame("received", `42${JSON.stringify([fixture.event_name, delivery])}`);
}

function cdpDeviceEventRecord(delivery: unknown) {
  return sanitizeCaptureRecord(
    "cdp-websocket-frame",
    {
      direction: "received",
      payload: {
        response: {
          payloadData: `42${JSON.stringify([fixture.event_name, delivery])}`,
          truncated: false
        }
      }
    },
    identityRedactor
  );
}

function deviceEventWithoutId(overrides: Record<string, unknown>) {
  const delivery = structuredClone(fixture.fixture_deliveries[0]) as {
    data: { device_event: Record<string, unknown> };
  };
  delete delivery.data.device_event["event_id"];
  Object.assign(delivery.data.device_event, overrides);
  return delivery;
}

function sanitizedSwitchDelivery(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      event_type: "DEVICE_EVENT",
      device_event: {
        event_id: "identifier_deadbeef0000",
        device_id: "dev_001",
        component: "main",
        capability: "switch",
        attribute: "switch",
        value: "value_raw",
        state_change: true,
        ...overrides
      }
    }
  };
}

function sanitizedFrame(direction: "sent" | "received", payload: string) {
  return sanitizeCaptureRecord(
    "playwright-websocket-frame",
    { direction, frame: { payload, truncated: false } },
    identityRedactor
  );
}

function buildSnapshotResponse(correlation: SnapshotFixture["correlations"][number]): unknown {
  const items = Array.from({ length: correlation.response_count }, () =>
    Object.fromEntries(correlation.response_item_keys.map((key) => [key, null]))
  );
  if (correlation.response_category === "device_cards") {
    return Object.fromEntries(
      (correlation.response_keys ?? ["data"]).map((key) => [key, key === "data" ? items : null])
    );
  }
  return items;
}
