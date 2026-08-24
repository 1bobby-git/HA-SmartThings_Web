import { describe, expect, it } from "vitest";

import { createSoakSample, parseSoakObservation } from "../tools/haos-soak-core.js";
import {
  createSoakCollectorConfig,
  createSoakCollectorLock,
  createSoakResumeState,
  parseSoakCollectorConfig,
  parseSoakCollectorLock,
  parseSoakObservationLog
} from "../tools/haos-soak-resume-core.js";

const STARTED_AT = "2026-08-24T00:00:00.000Z";
const INTERVAL_MS = 5 * 60_000;
const DURATION_MS = 72 * 60 * 60_000;

describe("HAOS soak collector identity", () => {
  it("round-trips an exact collector lock", () => {
    const lock = createSoakCollectorLock(1234, Date.parse(STARTED_AT));

    expect(parseSoakCollectorLock(JSON.stringify(lock))).toEqual(lock);
    expect(() => parseSoakCollectorLock(JSON.stringify({ ...lock, token: "secret" }))).toThrowError(
      "soak_collector_lock_invalid"
    );
    expect(() => parseSoakCollectorLock('{"schemaVersion":1,"pid":0,"createdAt":"bad"}')).toThrowError(
      "soak_collector_lock_invalid"
    );
  });

  it("round-trips an exact collector configuration", () => {
    const config = createSoakCollectorConfig({
      sshTarget: "pve-new-ts",
      vmId: 100,
      addonSlug: "local_smartthings_web_bridge",
      maxMemoryGrowthBytes: 256 * 1_024 * 1_024
    });

    expect(parseSoakCollectorConfig(JSON.stringify(config))).toEqual(config);
    expect(() =>
      parseSoakCollectorConfig(JSON.stringify({ ...config, password: "secret" }))
    ).toThrowError("soak_collector_config_invalid");
    expect(() =>
      parseSoakCollectorConfig(JSON.stringify({ ...config, sshTarget: "host; shutdown" }))
    ).toThrowError("soak_collector_config_invalid");
  });
});

describe("HAOS soak observation replay", () => {
  it("replays complete allowlisted sample and error lines", () => {
    const observations = [
      sample(STARTED_AT),
      {
        schemaVersion: 1,
        kind: "error",
        sampledAt: "2026-08-24T00:05:00.000Z",
        code: "stats_command_failed"
      }
    ] as const;
    const text = `${observations.map((observation) => JSON.stringify(observation)).join("\n")}\n`;

    expect(parseSoakObservationLog(text)).toEqual(observations);
  });

  it("rejects torn, blank, oversized, or expanded evidence lines", () => {
    const validLine = JSON.stringify(sample(STARTED_AT));
    expect(() => parseSoakObservationLog(validLine)).toThrowError("soak_resume_samples_invalid");
    expect(() => parseSoakObservationLog(`${validLine}\n\n`)).toThrowError(
      "soak_resume_samples_invalid"
    );
    expect(() => parseSoakObservationLog(`${JSON.stringify({ padding: "x".repeat(33_000) })}\n`)).toThrowError(
      "soak_resume_samples_invalid"
    );
    expect(() =>
      parseSoakObservationLog(`${JSON.stringify({ ...sample(STARTED_AT), token: "secret" })}\n`)
    ).toThrowError("soak_resume_samples_invalid");
  });

  it("rejects unknown nested fields before reconstructing an observation", () => {
    const valid = sample(STARTED_AT);

    expect(() =>
      parseSoakObservation({ ...valid, health: { ...valid.health, cookie: "secret" } })
    ).toThrowError("soak_observation_invalid");
    expect(() =>
      parseSoakObservation({ ...valid, resources: { ...valid.resources, command: "secret" } })
    ).toThrowError("soak_observation_invalid");
  });
});

describe("HAOS soak resume state", () => {
  it("keeps the original timing and schedules after the last persisted observation", () => {
    const observations = [sample(STARTED_AT), sample("2026-08-24T00:05:00.000Z")];
    const resumed = createSoakResumeState({
      metadataText: metadata("interrupted"),
      observationsText: `${observations.map((observation) => JSON.stringify(observation)).join("\n")}\n`,
      requestedDurationMs: DURATION_MS,
      requestedIntervalMs: INTERVAL_MS
    });

    expect(resumed.startedAtMs).toBe(Date.parse(STARTED_AT));
    expect(resumed.expectedEndAtMs).toBe(Date.parse(STARTED_AT) + DURATION_MS);
    expect(resumed.nextSampleAtMs).toBe(Date.parse("2026-08-24T00:10:00.000Z"));
    expect(resumed.observations).toEqual(observations);
  });

  it("starts at the original start time when no observation was persisted", () => {
    const resumed = createSoakResumeState({
      metadataText: metadata("running"),
      observationsText: "",
      requestedDurationMs: DURATION_MS,
      requestedIntervalMs: INTERVAL_MS
    });

    expect(resumed.nextSampleAtMs).toBe(Date.parse(STARTED_AT));
  });

  it("rejects completed, mismatched, or pre-start runs", () => {
    expect(() =>
      createSoakResumeState({
        metadataText: metadata("completed"),
        observationsText: "",
        requestedDurationMs: DURATION_MS,
        requestedIntervalMs: INTERVAL_MS
      })
    ).toThrowError("soak_resume_metadata_mismatch");
    expect(() =>
      createSoakResumeState({
        metadataText: metadata("interrupted"),
        observationsText: "",
        requestedDurationMs: DURATION_MS,
        requestedIntervalMs: 60_000
      })
    ).toThrowError("soak_resume_metadata_mismatch");
    expect(() =>
      createSoakResumeState({
        metadataText: metadata("interrupted"),
        observationsText: `${JSON.stringify(sample("2026-08-23T23:55:00.000Z"))}\n`,
        requestedDurationMs: DURATION_MS,
        requestedIntervalMs: INTERVAL_MS
      })
    ).toThrowError("soak_resume_samples_invalid");
  });
});

function metadata(status: "running" | "completed" | "interrupted"): string {
  return JSON.stringify({
    schemaVersion: 1,
    status,
    startedAt: STARTED_AT,
    expectedEndAt: new Date(Date.parse(STARTED_AT) + DURATION_MS).toISOString(),
    durationMs: DURATION_MS,
    intervalMs: INTERVAL_MS,
    outputPolicy: "allowlisted_aggregates_only"
  });
}

function sample(sampledAt: string) {
  return createSoakSample({
    sampledAt,
    health: {
      live: true,
      ready: true,
      state: "CONNECTED",
      urlCategory: "smartthings_location",
      activeConnections: 0,
      observedDeviceCount: 213,
      decodedDeviceEventCount: 100,
      uniqueLogicalEventCount: 50,
      duplicateEventCount: 50,
      dedupeJournalSize: 50,
      protocolInvalidFrameCount: 1,
      protocolChangeCount: 0,
      restartCount: 0,
      bridgeVersion: "0.1.25",
      browserVersion: "151.0.7922.34",
      protocolVersion: "1:93ad956a7d0c0139",
      heartbeatAgeMs: 1000,
      snapshotAgeMs: 1000,
      pushAgeMs: 500,
      browserUptimeMs: 3_600_000
    },
    resources: {
      cpuPercent: 0.35,
      memoryUsageBytes: 400,
      memoryLimitBytes: 10_000,
      memoryPercent: 4,
      networkRxBytes: 1000,
      networkTxBytes: 100,
      blockReadBytes: 0,
      blockWriteBytes: 0
    }
  });
}
