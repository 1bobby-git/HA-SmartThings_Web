import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import {
  REQUIRED_SNAPSHOT_CATEGORIES,
  SnapshotDetector
} from "../../src/inspector/snapshot-detector.js";

interface CorrelationFixture {
  required_categories: string[];
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
  readFileSync("protocol/fixtures/2026-08-20-snapshot-ack-correlations.sanitized.json", "utf8")
) as CorrelationFixture;

describe("SnapshotDetector", () => {
  test("correlates all six sanitized real request/ACK categories into a complete snapshot", () => {
    const detector = new SnapshotDetector();

    for (const correlation of fixture.correlations) {
      const ackId = Number(correlation.ack_id.split("_")[1]);
      detector.observeSentFrame(
        `42${ackId}${JSON.stringify([
          correlation.request_event,
          correlation.request_query,
          buildItem(correlation.request_keys)
        ])}`
      );
      const response = buildResponse(correlation);
      expect(
        detector.observeReceivedFrame(`43${ackId}${JSON.stringify([null, response])}`)
      ).toEqual({
        kind: "snapshot",
        requestEvent: correlation.request_event,
        category: correlation.response_category,
        count: correlation.response_count
      });
    }

    expect(REQUIRED_SNAPSHOT_CATEGORIES).toEqual(fixture.required_categories);
    expect(detector.snapshot()).toEqual({
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

  test("stays incomplete when a category is missing and ignores unmatched ACKs", () => {
    const detector = new SnapshotDetector();
    const first = fixture.correlations[0];
    if (!first) throw new Error("fixture missing correlation");
    const ackId = 1;

    expect(detector.observeReceivedFrame(`43${ackId}${JSON.stringify([null, buildResponse(first)])}`)).toBeNull();
    detector.observeSentFrame(
      `42${ackId}${JSON.stringify([
        first.request_event,
        first.request_query,
        buildItem(first.request_keys)
      ])}`
    );
    detector.observeReceivedFrame(`43${ackId}${JSON.stringify([null, buildResponse(first)])}`);

    expect(detector.snapshot().complete).toBe(false);
  });

  test("does not let the same ACK id on another websocket consume a pending snapshot request", () => {
    const detector = new SnapshotDetector();

    detector.observeSentFrame('421["find","api/room",{}]', "keeper");
    expect(
      detector.observeReceivedFrame(
        `431${JSON.stringify([null, [{ actions: null, dateCreated: null, name: null }]])}`,
        "detail"
      )
    ).toBeNull();
    expect(
      detector.observeReceivedFrame(
        `431${JSON.stringify([null, [{ roomId: null, locationId: null }]])}`,
        "keeper"
      )
    ).toEqual({ kind: "snapshot", requestEvent: "find", category: "rooms", count: 1 });

    expect(detector.snapshot()).toMatchObject({
      categories: { rooms: 1 },
      pendingRequests: 0
    });
  });

  test("keeps independent pending snapshot requests with the same ACK id on separate websockets", () => {
    const detector = new SnapshotDetector();

    detector.observeSentFrame('421["find","api/room",{}]', "keeper");
    detector.observeSentFrame('421["find","api/scene",{}]', "detail");

    expect(
      detector.observeReceivedFrame(
        `431${JSON.stringify([null, [{ actions: null, dateCreated: null, name: null }]])}`,
        "detail"
      )
    ).toEqual({ kind: "snapshot", requestEvent: "find", category: "scenes", count: 1 });
    expect(
      detector.observeReceivedFrame(
        `431${JSON.stringify([null, [{ roomId: null, locationId: null }]])}`,
        "keeper"
      )
    ).toEqual({ kind: "snapshot", requestEvent: "find", category: "rooms", count: 1 });
  });

  test("keeps the largest category count and can reset for a reconnect epoch", () => {
    const detector = new SnapshotDetector();
    const locations = fixture.correlations.find((entry) => entry.response_category === "locations");
    if (!locations) throw new Error("fixture missing locations");

    detector.observeSentFrame('421["find","api/location",{}]');
    detector.observeReceivedFrame(`431${JSON.stringify([null, buildResponse(locations)])}`);
    detector.observeSentFrame('422["find","api/location",{}]');
    detector.observeReceivedFrame(`432${JSON.stringify([null, [buildItem(locations.response_item_keys)]])}`);
    expect(detector.snapshot().categories.locations).toBe(2);

    detector.reset();
    expect(detector.snapshot()).toEqual({ complete: false, categories: {}, pendingRequests: 0 });
  });

  test("treats known empty snapshot responses as observed categories", () => {
    const detector = new SnapshotDetector();
    const emptyResponses = [
      ["api/location", []],
      ["api/room", []],
      ["api/device", { data: [] }],
      ["api/device/status", []],
      ["api/device/health", []],
      ["api/scene", []]
    ] as const;

    emptyResponses.forEach(([queryName, response], index) => {
      const ackId = index + 1;
      detector.observeSentFrame(`42${ackId}${JSON.stringify(["find", queryName, {}])}`);
      expect(
        detector.observeReceivedFrame(`43${ackId}${JSON.stringify([null, response])}`)
      ).toMatchObject({ kind: "snapshot", count: 0 });
    });

    expect(detector.snapshot()).toEqual({
      complete: true,
      categories: {
        locations: 0,
        rooms: 0,
        device_cards: 0,
        device_states: 0,
        device_health: 0,
        scenes: 0
      },
      pendingRequests: 0
    });
  });

  test("does not classify mixed partial array records by their unioned keys", () => {
    const detector = new SnapshotDetector();
    detector.observeSentFrame('421["find","api/unknown",{}]');

    expect(
      detector.observeReceivedFrame(
        `431${JSON.stringify([null, [{ roomId: null }, { locationId: null }]])}`
      )
    ).toBeNull();
    expect(detector.snapshot().categories).toEqual({});
  });

  test("does not infer an empty category without a known request query", () => {
    const detector = new SnapshotDetector();
    detector.observeSentFrame('421["find","api/unknown",{}]');

    expect(detector.observeReceivedFrame('431[null,[]]')).toBeNull();
    expect(detector.snapshot()).toEqual({ complete: false, categories: {}, pendingRequests: 0 });
  });

  test("does not accept snapshot-shaped ACKs from unrecognized requests", () => {
    const detector = new SnapshotDetector();
    const roomResponse = [{ roomId: null, locationId: null }];

    detector.observeSentFrame('421["get","not-a-snapshot",{}]');
    detector.observeSentFrame('422["find","api/unknown",{}]');

    expect(detector.observeReceivedFrame(`431${JSON.stringify([null, roomResponse])}`)).toBeNull();
    expect(detector.observeReceivedFrame(`432${JSON.stringify([null, roomResponse])}`)).toBeNull();
    expect(detector.snapshot()).toEqual({ complete: false, categories: {}, pendingRequests: 0 });
  });

  test("does not let unrecognized requests evict a pending snapshot correlation", () => {
    const detector = new SnapshotDetector({ maxPendingRequests: 1 });
    detector.observeSentFrame('421["find","api/room",{}]');
    detector.observeSentFrame('422["get","not-a-snapshot",{}]');

    expect(detector.snapshot().pendingRequests).toBe(1);
    expect(
      detector.observeReceivedFrame(
        `431${JSON.stringify([null, [{ roomId: null, locationId: null }]])}`
      )
    ).toMatchObject({ kind: "snapshot", category: "rooms", count: 1 });
  });

  test("does not classify partial device-card records by their unioned keys", () => {
    const detector = new SnapshotDetector();
    detector.observeSentFrame('421["find","api/unknown",{}]');

    expect(
      detector.observeReceivedFrame(
        `431${JSON.stringify([null, { data: [{ type: null }, { basic: null }] }])}`
      )
    ).toBeNull();
    expect(detector.snapshot().categories).toEqual({});
  });

  test("emits protocol_changed when a known request hint conflicts with a non-empty response shape", () => {
    const detector = new SnapshotDetector();
    detector.observeSentFrame('421["find","api/scene",{}]');

    expect(
      detector.observeReceivedFrame(
        `431${JSON.stringify([null, [{ roomId: null, locationId: null }]])}`
      )
    ).toEqual({ kind: "protocol_changed", surface: "snapshot:scenes:response_shape" });
    expect(detector.snapshot().categories).toEqual({});
  });

  test("ignores a standard Feathers request error without declaring a protocol change", () => {
    const detector = new SnapshotDetector();
    detector.observeSentFrame('421["find","api/device/status",{}]');

    expect(
      detector.observeReceivedFrame(
        `431${JSON.stringify([
          {
            name: "BadRequest",
            message: "request failed",
            code: 400,
            className: "bad-request",
            data: {}
          }
        ])}`
      )
    ).toBeNull();
    expect(detector.snapshot()).toEqual({ complete: false, categories: {}, pendingRequests: 0 });
  });

  test.each([404])(
    "surfaces HTTP %i-shaped snapshot errors as protocol changes",
    (code) => {
      const detector = new SnapshotDetector();
      detector.observeSentFrame('421["find","api/device/status",{}]');

      expect(
        detector.observeReceivedFrame(
          `431${JSON.stringify([
            {
              name: code === 404 ? "NotFound" : "GeneralError",
              message: "request failed",
              code,
              className: code === 404 ? "not-found" : "general-error",
              data: {}
            }
          ])}`
        )
      ).toEqual({
        kind: "protocol_changed",
        surface: "snapshot:device_states:response_shape"
      });
      expect(detector.snapshot()).toEqual({ complete: false, categories: {}, pendingRequests: 0 });
    }
  );

  test("ignores a standard Feathers 500 snapshot error without declaring a protocol change", () => {
    const detector = new SnapshotDetector();
    detector.observeSentFrame('421["find","api/device/status",{}]');

    expect(
      detector.observeReceivedFrame(
        `431${JSON.stringify([
          {
            name: "GeneralError",
            message: "Rejected HTTP Response",
            code: 500,
            className: "general-error",
            data: { status: 500 }
          }
        ])}`
      )
    ).toBeNull();
    expect(detector.snapshot()).toEqual({ complete: false, categories: {}, pendingRequests: 0 });
  });

  test("accepts an empty device-card response as an authoritative zero-device snapshot", () => {
    const detector = new SnapshotDetector();
    detector.observeSentFrame('421["find","api/device",{}]');

    expect(detector.observeReceivedFrame("431[null,[]]")).toEqual({
      kind: "snapshot",
      requestEvent: "find",
      category: "device_cards",
      count: 0
    });
    expect(detector.snapshot()).toEqual({
      complete: false,
      categories: { device_cards: 0 },
      pendingRequests: 0
    });
  });

  test("keeps unrelated and unknown ACK traffic null even when it is snapshot-shaped", () => {
    const detector = new SnapshotDetector();

    expect(
      detector.observeReceivedFrame(
        `4399${JSON.stringify([null, [{ roomId: null, locationId: null }]])}`
      )
    ).toBeNull();

    detector.observeSentFrame('421["find","api/unknown",{}]');
    expect(
      detector.observeReceivedFrame(
        `431${JSON.stringify([null, [{ roomId: null, locationId: null }]])}`
      )
    ).toBeNull();
    expect(detector.snapshot()).toEqual({ complete: false, categories: {}, pendingRequests: 0 });
  });
});

function buildResponse(correlation: CorrelationFixture["correlations"][number]): unknown {
  const items = Array.from({ length: correlation.response_count }, () =>
    buildItem(correlation.response_item_keys)
  );
  if (correlation.response_category === "device_cards") {
    return Object.fromEntries(
      (correlation.response_keys ?? ["data"]).map((key) => [key, key === "data" ? items : null])
    );
  }
  return items;
}

function buildItem(keys: string[]): Record<string, null> {
  return Object.fromEntries(keys.map((key) => [key, null] as const));
}
