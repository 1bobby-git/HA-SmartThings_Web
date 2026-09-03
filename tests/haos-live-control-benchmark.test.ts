import { describe, expect, test } from "vitest";

import {
  DEFAULT_LIVE_CONTROL_ENTITY_ID,
  createLiveControlBenchmarkPreview,
  runLiveControlBenchmark,
  type BridgeHealthClient,
  type HomeAssistantControlClient,
  type LiveControlBenchmarkClock
} from "../tools/haos-live-control-benchmark-core.js";

describe("HAOS live control benchmark", () => {
  test("previews the default allowlisted entity without calling Home Assistant services", async () => {
    const calls: string[] = [];
    const preview = await createLiveControlBenchmarkPreview({
      entityId: DEFAULT_LIVE_CONTROL_ENTITY_ID,
      allowedEntityIds: [DEFAULT_LIVE_CONTROL_ENTITY_ID],
      cycles: 2,
      ha: {
        getState: async (entityId) => {
          calls.push(`state:${entityId}`);
          return haState(entityId, "off", "2026-08-27T00:00:00.000Z");
        },
        callService: async () => {
          calls.push("service");
        }
      },
      bridge: bridgeClient()
    });

    expect(preview).toMatchObject({
      schemaVersion: 1,
      mode: "preview",
      entityId: DEFAULT_LIVE_CONTROL_ENTITY_ID,
      cycles: 2,
      initialState: { state: "off" },
      willExecute: false
    });
    expect(calls).toEqual([`state:${DEFAULT_LIVE_CONTROL_ENTITY_ID}`]);
    expect(JSON.stringify(preview)).not.toMatch(/token|authorization|cookie|raw/i);
  });

  test("rejects entities outside the explicit allowlist before any service call", async () => {
    const ha = recordingHaClient([
      haState("switch.unlisted", "off", "2026-08-27T00:00:00.000Z")
    ]);

    await expect(
      runLiveControlBenchmark({
        entityId: "switch.unlisted",
        allowedEntityIds: [DEFAULT_LIVE_CONTROL_ENTITY_ID],
        execute: true,
        cycles: 1,
        ha,
        bridge: bridgeClient(),
        clock: fixedClock(),
        writeArtifact: async () => undefined
      })
    ).rejects.toThrowError("live_control_benchmark_entity_not_allowed");
    expect(ha.serviceCalls).toEqual([]);
  });

  test("executes on then off cycles and writes only allowlisted timing evidence", async () => {
    const entityId = DEFAULT_LIVE_CONTROL_ENTITY_ID;
    const ha = recordingHaClient([
      haState(entityId, "off", "2026-08-27T00:00:00.000Z"),
      haState(entityId, "on", "2026-08-27T00:00:00.260Z"),
      haState(entityId, "off", "2026-08-27T00:00:00.460Z"),
      haState(entityId, "off", "2026-08-27T00:00:03.000Z"),
      haState(entityId, "off", "2026-08-27T00:00:04.000Z")
    ]);
    const artifacts: Array<{ fileName: string; value: unknown }> = [];

    const result = await runLiveControlBenchmark({
      entityId,
      allowedEntityIds: [entityId],
      execute: true,
      cycles: 1,
      ha,
      bridge: bridgeClient({
        state: "CONNECTED",
        decodedDeviceEventCount: 42,
        uniqueLogicalEventCount: 21,
        duplicateEventCount: 21,
        pushAgeMs: 50,
        sequence: 99,
        authorization: "Bearer raw-secret",
        cookie: "raw-cookie"
      }),
      clock: fixedClock([
        "2026-08-27T00:00:00.100Z",
        "2026-08-27T00:00:00.200Z",
        "2026-08-27T00:00:00.250Z",
        "2026-08-27T00:00:00.300Z",
        "2026-08-27T00:00:00.400Z",
        "2026-08-27T00:00:00.450Z",
        "2026-08-27T00:00:00.500Z",
        "2026-08-27T00:00:00.600Z"
      ]),
      writeArtifact: async (fileName, value) => {
        artifacts.push({ fileName, value });
      }
    });

    expect(ha.serviceCalls).toEqual([
      { domain: "switch", service: "turn_on", data: { entity_id: entityId } },
      { domain: "switch", service: "turn_off", data: { entity_id: entityId } }
    ]);
    expect(result.finalState.state).toBe("off");
    expect(result.transitions).toHaveLength(2);
    expect(result.transitions.map((transition) => transition.targetState)).toEqual(["on", "off"]);
    expect(result.transitions[0]).toMatchObject({
      cycle: 1,
      service: "turn_on",
      serviceRequestedAt: "2026-08-27T00:00:00.200Z",
      serviceReturnedAt: "2026-08-27T00:00:00.250Z",
      serviceDurationMs: 50,
      haLastUpdatedAfterRequestMs: 60,
      haObservedAfterRequestMs: 100,
      ha: {
        state: "on",
        lastUpdated: "2026-08-27T00:00:00.260Z",
        observedAt: "2026-08-27T00:00:00.300Z"
      },
      bridge: {
        state: "CONNECTED",
        decodedDeviceEventCount: 42,
        uniqueLogicalEventCount: 21,
        duplicateEventCount: 21,
        pushAgeMs: 50,
        sequence: 99
      }
    });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.fileName).toMatch(/^haos-live-control-benchmark-.*\.json$/u);
    expect(artifacts[0]?.value).toEqual(result);
    expect(JSON.stringify(result)).not.toMatch(/raw-secret|raw-cookie|authorization|cookie/i);
  });

  test("restores the switch to off in finally when an on transition fails", async () => {
    const entityId = DEFAULT_LIVE_CONTROL_ENTITY_ID;
    const ha = recordingHaClient([
      haState(entityId, "off", "2026-08-27T00:00:00.000Z"),
      haState(entityId, "off", "2026-08-27T00:00:01.000Z"),
      haState(entityId, "on", "2026-08-27T00:00:02.000Z"),
      haState(entityId, "off", "2026-08-27T00:00:03.000Z")
    ]);

    await expect(
      runLiveControlBenchmark({
        entityId,
        allowedEntityIds: [entityId],
        execute: true,
        cycles: 1,
        ha,
        bridge: bridgeClient(),
        clock: fixedClock(),
        waitTimeoutMs: 1,
        pollIntervalMs: 0,
        writeArtifact: async () => undefined
      })
    ).rejects.toThrowError("live_control_benchmark_state_timeout");

    expect(ha.serviceCalls).toEqual([
      { domain: "switch", service: "turn_on", data: { entity_id: entityId } },
      { domain: "switch", service: "turn_off", data: { entity_id: entityId } }
    ]);
  });
});

function haState(entityId: string, state: string, lastUpdated: string) {
  return {
    entityId,
    state,
    lastUpdated,
    attributes: {
      friendly_name: "raw secret should be dropped"
    }
  };
}

function recordingHaClient(states: ReturnType<typeof haState>[]): HomeAssistantControlClient & {
  serviceCalls: Array<{ domain: string; service: string; data: Record<string, string> }>;
} {
  const serviceCalls: Array<{ domain: string; service: string; data: Record<string, string> }> = [];
  return {
    serviceCalls,
    async getState(entityId) {
      const next = states.shift();
      if (!next) throw new Error(`missing_state:${entityId}`);
      return next;
    },
    async callService(domain, service, data) {
      serviceCalls.push({ domain, service, data });
    }
  };
}

function bridgeClient(details: Record<string, unknown> = {}): BridgeHealthClient {
  return {
    async getHealth() {
      return {
        state: "CONNECTED",
        decodedDeviceEventCount: 0,
        uniqueLogicalEventCount: 0,
        duplicateEventCount: 0,
        ...details
      };
    }
  };
}

function fixedClock(values: string[] = []): LiveControlBenchmarkClock {
  let index = 0;
  return {
    nowIso() {
      const value = values[index] ?? "2026-08-27T00:00:00.000Z";
      index += 1;
      return value;
    },
    async sleep() {
      return undefined;
    }
  };
}
