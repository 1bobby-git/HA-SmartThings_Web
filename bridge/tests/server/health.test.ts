import { describe, expect, test } from "vitest";

import { RuntimeStatusStore } from "../../src/state/runtime-state.js";
import { createHealthReport } from "../../src/server/health.js";

describe("createHealthReport", () => {
  test("keeps liveness independent from login, browser, and push status", () => {
    const store = new RuntimeStatusStore({ now: () => 1_000 });
    const snapshot = store.update({
      state: "BROWSER_FAILED",
      dbAvailable: true,
      heartbeatAtMs: 900,
      chromiumRunning: false,
      authenticated: false,
      pushConnected: false
    });

    const report = createHealthReport(snapshot, { nowMs: 1_200 });

    expect(report.live).toBe(true);
    expect(report.ready).toBe(false);
    expect(report.details).toMatchObject({
      state: "BROWSER_FAILED",
      urlCategory: "unknown",
      activeConnections: 0,
      observedDeviceCount: 0,
      protocolChangeCount: 0,
      restartCount: 0,
      bridgeVersion: "0.0.0-dev",
      protocolVersion: "unknown",
      heartbeatAgeMs: 300,
      snapshotAgeMs: 200
    });
  });

  test("fails liveness only when heartbeat is stale or DB is unavailable", () => {
    const store = new RuntimeStatusStore({ now: () => 2_000 });
    const snapshot = store.update({
      dbAvailable: true,
      heartbeatAtMs: 1_000,
      chromiumRunning: true,
      keeperPresent: true,
      authenticated: true,
      pushConnected: true,
      initialSnapshotComplete: true,
      parserHealthy: true,
      initialSnapshotCompletedAtMs: 1_200,
      lastParserSuccessAtMs: 1_800,
      lastPushAtMs: 1_900
    });

    expect(createHealthReport(snapshot, { nowMs: 32_000 }).live).toBe(true);
    expect(createHealthReport(snapshot, { nowMs: 32_001 }).live).toBe(false);
    expect(createHealthReport({ ...snapshot, dbAvailable: false }, { nowMs: 2_500 }).live).toBe(false);
  });

  test("requires all operational gates for readiness and exposes only safe details", () => {
    const store = new RuntimeStatusStore({ now: () => 10_000 });
    const snapshot = store.update({
      state: "CONNECTED",
      urlCategory: "map",
      dbAvailable: true,
      heartbeatAtMs: 9_900,
      chromiumRunning: true,
      keeperPresent: true,
      authenticated: true,
      pushConnected: true,
      initialSnapshotComplete: true,
      parserHealthy: true,
      activeConnections: 3,
      observedDeviceCount: 8,
      restartCount: 1,
      protocolChangeCount: 2,
      bridgeVersion: "0.1.0",
      protocolVersion: "proto-4",
      initialSnapshotCompletedAtMs: 9_500,
      lastParserSuccessAtMs: 9_700,
      lastPushAtMs: 9_800,
      lastBrowserStartAtMs: 8_000
    });

    const ready = createHealthReport(snapshot, { nowMs: 10_000 });
    const missingKeeper = createHealthReport({ ...snapshot, keeperPresent: false }, { nowMs: 10_000 });
    const staleSnapshot = createHealthReport(
      { ...snapshot, initialSnapshotCompletedAtMs: 1 },
      { nowMs: 10_000, snapshotFreshMs: 5_000 }
    );

    expect(ready.live).toBe(true);
    expect(ready.ready).toBe(true);
    expect(missingKeeper.ready).toBe(false);
    expect(staleSnapshot.ready).toBe(false);
    expect(JSON.stringify(ready.details)).not.toMatch(/https?:|deviceId|locationId|token|secret|raw-/i);
    expect(ready.details).toEqual({
      state: "CONNECTED",
      urlCategory: "map",
      activeConnections: 3,
      observedDeviceCount: 8,
      protocolChangeCount: 2,
      restartCount: 1,
      bridgeVersion: "0.1.0",
      protocolVersion: "proto-4",
      heartbeatAgeMs: 100,
      snapshotAgeMs: 0,
      initialSnapshotAgeMs: 500,
      parserAgeMs: 300,
      pushAgeMs: 200,
      browserUptimeMs: 2_000
    });
  });
});
