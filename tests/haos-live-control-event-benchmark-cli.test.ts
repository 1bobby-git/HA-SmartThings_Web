import { describe, expect, test } from "vitest";

import {
  parseCliOptions
} from "../tools/haos-live-control-event-benchmark.js";
import {
  DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID
} from "../tools/haos-live-control-event-benchmark-core.js";

describe("HAOS live control event benchmark CLI", () => {
  test("defaults to a preview of the allowlisted entry toggle", () => {
    const options = parseCliOptions([]);

    expect(options).toMatchObject({
      execute: false,
      entityId: DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID,
      allowedEntityIds: [DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID],
      cycles: 10,
      haUrl: "http://supervisor/core/api",
      haWsUrl: "ws://supervisor/core/api/websocket",
      bridgeUrl: "http://127.0.0.1:8098",
      waitTimeoutMs: 15000,
      pollIntervalMs: 25
    });
    expect(options.bridgeTokenFile).toMatch(/(?:^|[/\\])data[/\\]bridge-secret$/u);
  });

  test("accepts execute options without widening the allowed entity", () => {
    const options = parseCliOptions([
      "--execute",
      "--output-dir",
      "C:/smartthings-benchmark",
      "--cycles",
      "3",
      "--baseline-ha-ms",
      "10557"
    ]);

    expect(options.execute).toBe(true);
    expect(options.entityId).toBe(DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID);
    expect(options.allowedEntityIds).toEqual([DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID]);
    expect(options.outputDirectory).toMatch(/smartthings-benchmark$/u);
    expect(options.baselineHaObservedAfterRequestMs).toBe(10557);
  });

  test("rejects non-local HA and Bridge endpoints", () => {
    expect(() =>
      parseCliOptions(["--ha-url", "https://homeassistant.example.com/api"])
    ).toThrowError("live_control_event_benchmark_arguments_invalid");
    expect(() =>
      parseCliOptions(["--bridge-url", "http://example.com"])
    ).toThrowError("live_control_event_benchmark_arguments_invalid");
    expect(() =>
      parseCliOptions(["--ha-ws-url", "wss://homeassistant.example.com/api/websocket"])
    ).toThrowError("live_control_event_benchmark_arguments_invalid");
  });
});