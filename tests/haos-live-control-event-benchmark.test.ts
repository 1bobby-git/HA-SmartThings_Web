import { describe, expect, test } from "vitest";

import {
  DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID,
  createLiveControlEventBenchmarkPreview,
  runLiveControlEventBenchmark,
  type BridgeSseBenchmarkClient,
  type HaStateChangedEvent,
  type HomeAssistantEventControlClient,
  type LiveControlEventBenchmarkClock
} from "../tools/haos-live-control-event-benchmark-core.js";

describe("HAOS live control event benchmark", () => {
  test("previews the allowlisted target without subscribing or calling services", async () => {
    const calls: string[] = [];
    const preview = await createLiveControlEventBenchmarkPreview({
      entityId: DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID,
      allowedEntityIds: [DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID],
      cycles: 2,
      ha: eventHaClient({
        calls,
        states: [haState("off", "2026-08-27T00:00:00.000Z")]
      })
    });

    expect(preview).toMatchObject({
      schemaVersion: 1,
      mode: "preview",
      entityId: DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID,
      cycles: 2,
      willExecute: false,
      executionEligible: true,
      initialState: { state: "off" }
    });
    expect(calls).toEqual([`get:${DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID}`]);
    expect(JSON.stringify(preview)).not.toMatch(/token|authorization|cookie|secret/i);
  });

  test("rejects non-allowlisted entities before opening event streams", async () => {
    const calls: string[] = [];

    await expect(
      runLiveControlEventBenchmark({
        entityId: "switch.other",
        allowedEntityIds: [DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID],
        execute: true,
        cycles: 1,
        ha: eventHaClient({ calls, states: [] }),
        clock: fixedClock()
      })
    ).rejects.toThrowError("live_control_event_benchmark_entity_not_allowed");

    expect(calls).toEqual([]);
  });

  test("subscribes to HA state_changed before ON/OFF service calls and records event latency", async () => {
    const calls: string[] = [];
    const bridgeEvents = [
      bridgeEvent(41, "on", "2026-08-27T00:00:00.235Z", "2026-08-27T00:00:00.205Z"),
      bridgeEvent(42, "off", "2026-08-27T00:00:00.435Z", "2026-08-27T00:00:00.405Z")
    ];
    const haEvents = [
      haEvent("on", "2026-08-27T00:00:00.260Z", "2026-08-27T00:00:00.270Z"),
      haEvent("off", "2026-08-27T00:00:00.460Z", "2026-08-27T00:00:00.470Z")
    ];
    const artifacts: unknown[] = [];

    const result = await runLiveControlEventBenchmark({
      entityId: DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID,
      allowedEntityIds: [DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID],
      execute: true,
      cycles: 1,
      ha: eventHaClient({
        calls,
        states: [
          haState("off", "2026-08-27T00:00:00.000Z"),
          haState("off", "2026-08-27T00:00:00.900Z")
        ],
        events: haEvents
      }),
      bridge: bridgeClient(calls, bridgeEvents),
      bridgeDeviceId: "dev_123",
      clock: fixedClock([
        "2026-08-27T00:00:00.100Z",
        "2026-08-27T00:00:00.200Z",
        "2026-08-27T00:00:00.250Z",
        "2026-08-27T00:00:00.400Z",
        "2026-08-27T00:00:00.450Z",
        "2026-08-27T00:00:00.800Z"
      ]),
      writeArtifact: async (_fileName, value) => {
        artifacts.push(value);
      }
    });

    expect(calls).toEqual([
      `get:${DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID}`,
      `ha-subscribe:${DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID}`,
      "bridge-subscribe",
      `service:switch.turn_on:${DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID}`,
      `service:switch.turn_off:${DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID}`,
      `get:${DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID}`,
      "bridge-unsubscribe",
      "ha-unsubscribe"
    ]);
    expect(result.finalState.state).toBe("off");
    expect(result.transitions).toHaveLength(2);
    expect(result.transitions[0]).toMatchObject({
      targetState: "on",
      service: "turn_on",
      serviceDurationMs: 50,
      haEventSeenAfterRequestMs: 70,
      haLastUpdatedAfterRequestMs: 60,
      bridgeToHaEventMs: 35,
      bridge: {
        sequence: 41,
        receivedAfterRequestMs: 35,
        updatedAtAfterRequestMs: 5
      }
    });
    expect(result.transitions[1]).toMatchObject({
      targetState: "off",
      bridge: { sequence: 42 }
    });
    expect(result.sequence).toEqual({ first: 41, last: 42, gaps: 0 });
    expect(result.speedup).toEqual({
      baselineHaObservedAfterRequestMs: undefined,
      measuredP95HaEventSeenAfterRequestMs: 70,
      factor: undefined
    });
    expect(result.latency).toEqual({
      minimumHaEventSeenAfterRequestMs: 70,
      medianHaEventSeenAfterRequestMs: 70,
      p95HaEventSeenAfterRequestMs: 70,
      maximumHaEventSeenAfterRequestMs: 70
    });
    expect(artifacts).toEqual([result]);
    expect(JSON.stringify(result)).not.toMatch(/token|authorization|cookie|secret/i);
  });

  test("ignores stale or non-switch bridge events and requires increasing transition sequence", async () => {
    const calls: string[] = [];
    const bridgeEvents = [
      bridgeEvent(40, "on", "2026-08-27T00:00:00.230Z", "2026-08-27T00:00:00.090Z"),
      bridgeEvent(41, "on", "2026-08-27T00:00:00.235Z", "2026-08-27T00:00:00.205Z", {
        attribute: "power"
      }),
      bridgeEvent(42, "on", "2026-08-27T00:00:00.240Z", "2026-08-27T00:00:00.210Z"),
      bridgeEvent(41, "off", "2026-08-27T00:00:00.435Z", "2026-08-27T00:00:00.405Z"),
      bridgeEvent(43, "off", "2026-08-27T00:00:00.440Z", "2026-08-27T00:00:00.410Z")
    ];

    const result = await runLiveControlEventBenchmark({
      entityId: DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID,
      allowedEntityIds: [DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID],
      execute: true,
      cycles: 1,
      ha: eventHaClient({
        calls,
        states: [
          haState("off", "2026-08-27T00:00:00.000Z"),
          haState("off", "2026-08-27T00:00:00.900Z")
        ],
        events: [
          haEvent("on", "2026-08-27T00:00:00.260Z", "2026-08-27T00:00:00.270Z"),
          haEvent("off", "2026-08-27T00:00:00.460Z", "2026-08-27T00:00:00.470Z")
        ]
      }),
      bridge: bridgeClient(calls, bridgeEvents),
      bridgeDeviceId: "dev_123",
      clock: fixedClock([
        "2026-08-27T00:00:00.100Z",
        "2026-08-27T00:00:00.200Z",
        "2026-08-27T00:00:00.250Z",
        "2026-08-27T00:00:00.400Z",
        "2026-08-27T00:00:00.450Z",
        "2026-08-27T00:00:00.800Z"
      ])
    });

    expect(result.transitions[0]?.bridge?.sequence).toBe(42);
    expect(result.transitions[1]?.bridge?.sequence).toBe(43);
  });

  test("turns the allowlisted switch back off in finally when event wait fails", async () => {
    const calls: string[] = [];
    const artifacts: unknown[] = [];

    await expect(
      runLiveControlEventBenchmark({
        entityId: DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID,
        allowedEntityIds: [DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID],
        execute: true,
        cycles: 1,
        ha: eventHaClient({
          calls,
          states: [
            haState("off", "2026-08-27T00:00:00.000Z"),
            haState("on", "2026-08-27T00:00:00.500Z"),
            haState("off", "2026-08-27T00:00:00.700Z")
          ],
          events: []
        }),
        clock: fixedClock(),
        waitTimeoutMs: 1,
        writeArtifact: async (_fileName, value) => {
          artifacts.push(value);
        }
      })
    ).rejects.toThrowError("live_control_event_benchmark_state_timeout");

    expect(calls).toEqual([
      `get:${DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID}`,
      `ha-subscribe:${DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID}`,
      `service:switch.turn_on:${DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID}`,
      `get:${DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID}`,
      `service:switch.turn_off:${DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID}`,
      `get:${DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID}`,
      "ha-unsubscribe"
    ]);
    expect(artifacts).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        mode: "failure",
        entityId: DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID,
        error: "live_control_event_benchmark_state_timeout",
        finalStateKnown: true,
        finalState: { state: "off", lastUpdated: "2026-08-27T00:00:00.700Z" },
        transitions: [],
        sequence: { gaps: 0 }
      })
    ]);
    expect(JSON.stringify(artifacts)).not.toMatch(/token|authorization|cookie|secret/i);
  });

  test("preserves primary and cleanup errors when final off state is uncertain", async () => {
    const calls: string[] = [];

    await expect(
      runLiveControlEventBenchmark({
        entityId: DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID,
        allowedEntityIds: [DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID],
        execute: true,
        cycles: 1,
        ha: eventHaClient({
          calls,
          states: [
            haState("off", "2026-08-27T00:00:00.000Z"),
            haState("on", "2026-08-27T00:00:00.500Z"),
            haState("on", "2026-08-27T00:00:00.700Z")
          ],
          events: []
        }),
        clock: fixedClock(),
        waitTimeoutMs: 1
      })
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        "live_control_event_benchmark_cleanup_failed_final_state_unknown"
      ),
      finalStateKnown: false
    });

    expect(calls).toEqual([
      `get:${DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID}`,
      `ha-subscribe:${DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID}`,
      `service:switch.turn_on:${DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID}`,
      `get:${DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID}`,
      `service:switch.turn_off:${DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID}`,
      `get:${DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID}`,
      "ha-unsubscribe"
    ]);
  });
});

function haState(state: "on" | "off", lastUpdated: string) {
  return {
    entityId: DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID,
    state,
    lastUpdated,
    attributes: { token: "must be dropped" }
  };
}

function haEvent(
  state: "on" | "off",
  lastUpdated: string,
  receivedAt: string
): HaStateChangedEvent {
  return {
    entityId: DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID,
    state,
    lastUpdated,
    receivedAt
  };
}

function bridgeEvent(
  sequence: number,
  value: "on" | "off",
  receivedAt: string,
  updatedAt: string,
  overrides: Partial<{
    deviceId: string;
    component: string;
    capability: string;
    attribute: string;
  }> = {}
) {
  return {
    schemaVersion: 1,
    type: "state",
    sequence,
    receivedAt,
    updatedAt,
    deviceId: overrides.deviceId ?? "dev_123",
    component: overrides.component ?? "main",
    capability: overrides.capability ?? "switch",
    attribute: overrides.attribute ?? "switch",
    value,
    authorization: "raw secret"
  };
}

function eventHaClient(options: {
  calls: string[];
  states: Array<ReturnType<typeof haState>>;
  events?: HaStateChangedEvent[];
}): HomeAssistantEventControlClient {
  return {
    async getState(entityId) {
      options.calls.push(`get:${entityId}`);
      const next = options.states.shift();
      if (!next) throw new Error("missing_state");
      return next;
    },
    async callService(domain, service, data) {
      options.calls.push(`service:${domain}.${service}:${data.entity_id}`);
    },
    async subscribeStateChanged(entityId, onEvent) {
      options.calls.push(`ha-subscribe:${entityId}`);
      for (const event of options.events ?? []) {
        queueMicrotask(() => onEvent(event));
      }
      return {
        async unsubscribe() {
          options.calls.push("ha-unsubscribe");
        }
      };
    }
  };
}

function bridgeClient(calls: string[], events: unknown[]): BridgeSseBenchmarkClient {
  return {
    async subscribeEvents(onEvent) {
      calls.push("bridge-subscribe");
      for (const event of events) {
        queueMicrotask(() => onEvent(event));
      }
      return {
        async unsubscribe() {
          calls.push("bridge-unsubscribe");
        }
      };
    }
  };
}

function fixedClock(values: string[] = []): LiveControlEventBenchmarkClock {
  let index = 0;
  return {
    nowIso() {
      const value = values[index] ?? "2026-08-27T00:00:00.000Z";
      index += 1;
      return value;
    },
    nowMs() {
      return Date.parse(this.nowIso());
    },
    async sleep() {
      return undefined;
    }
  };
}
