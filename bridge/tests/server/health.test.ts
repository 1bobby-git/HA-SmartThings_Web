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
      urlCategory: "none",
      activeConnections: 0,
      observedDeviceCount: 0,
      decodedDeviceEventCount: 0,
      uniqueLogicalEventCount: 0,
      duplicateEventCount: 0,
      dedupeJournalSize: 0,
      protocolInvalidFrameCount: 0,
      protocolChangeCount: 0,
      restartCount: 0,
      bridgeVersion: "0.0.0-dev",
      browserVersion: "unknown",
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
      lastSnapshotAtMs: 1_200,
      lastParserSuccessAtMs: 1_800,
      lastPushAtMs: 1_900
    });

    expect(createHealthReport(snapshot, { nowMs: 32_000 }).live).toBe(true);
    expect(createHealthReport(snapshot, { nowMs: 32_001 }).live).toBe(false);
    expect(createHealthReport({ ...snapshot, dbAvailable: false }, { nowMs: 2_500 }).live).toBe(false);
    const liveSnapshotAfterOldBoundary = { ...snapshot, heartbeatAtMs: 121_100 };
    expect(createHealthReport(liveSnapshotAfterOldBoundary, { nowMs: 121_201 }).ready).toBe(true);
  });

  test("requires all operational gates for readiness and exposes only safe details", () => {
    const store = new RuntimeStatusStore({ now: () => 10_000 });
    const snapshot = store.update({
      state: "CONNECTED",
      urlCategory: "smartthings_advanced",
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
      decodedDeviceEventCount: 3,
      uniqueLogicalEventCount: 1,
      duplicateEventCount: 2,
      dedupeJournalSize: 1,
      protocolInvalidFrameCount: 0,
      restartCount: 1,
      protocolChangeCount: 2,
      protocolMismatchSurface: "snapshot:scenes:response_shape",
      bridgeVersion: "0.1.0",
      browserVersion: "Chromium 141.0.7390.122",
      protocolVersion: "proto-4",
      initialSnapshotCompletedAtMs: 9_500,
      lastSnapshotAtMs: 9_400,
      lastFrameAtMs: 9_600,
      lastEventAtMs: 9_650,
      lastParserSuccessAtMs: 9_700,
      lastPushAtMs: 9_800,
      lastBrowserStartAtMs: 8_000
    });

    const ready = createHealthReport(snapshot, { nowMs: 10_000 });
    const missingKeeper = createHealthReport({ ...snapshot, keeperPresent: false }, { nowMs: 10_000 });
    const missingSnapshotProof = createHealthReport(
      { ...snapshot, initialSnapshotCompletedAtMs: undefined, updatedAtMs: 10_000 },
      { nowMs: 10_000 }
    );

    expect(ready.live).toBe(true);
    expect(ready.ready).toBe(true);
    expect(missingKeeper.ready).toBe(false);
    expect(missingSnapshotProof.ready).toBe(false);
    expect(JSON.stringify(ready.details)).not.toMatch(/https?:|deviceId|locationId|token|secret|raw-/i);
    expect(ready.details).toEqual({
      state: "CONNECTED",
      urlCategory: "smartthings_advanced",
      activeConnections: 3,
      observedDeviceCount: 8,
      decodedDeviceEventCount: 3,
      uniqueLogicalEventCount: 1,
      duplicateEventCount: 2,
      dedupeJournalSize: 1,
      protocolInvalidFrameCount: 0,
      protocolChangeCount: 2,
      protocolMismatchSurface: "snapshot:scenes:response_shape",
      restartCount: 1,
      bridgeVersion: "0.1.0",
      browserVersion: "Chromium 141.0.7390.122",
      protocolVersion: "proto-4",
      heartbeatAgeMs: 100,
      snapshotAgeMs: 0,
      initialSnapshotAgeMs: 500,
      lastSnapshotAgeMs: 600,
      frameAgeMs: 400,
      eventAgeMs: 350,
      parserAgeMs: 300,
      pushAgeMs: 200,
      browserUptimeMs: 2_000
    });
  });

  test("treats future heartbeat and snapshot timestamps beyond clock skew as stale", () => {
    const store = new RuntimeStatusStore({ now: () => 10_000 });
    const snapshot = store.update({
      state: "CONNECTED",
      dbAvailable: true,
      heartbeatAtMs: 9_900,
      chromiumRunning: true,
      keeperPresent: true,
      authenticated: true,
      pushConnected: true,
      initialSnapshotComplete: true,
      parserHealthy: true,
      initialSnapshotCompletedAtMs: 9_500,
      lastSnapshotAtMs: 9_400,
      lastPushAtMs: 9_800,
      lastParserSuccessAtMs: 9_700
    });

    const futureHeartbeat = createHealthReport(
      { ...snapshot, heartbeatAtMs: 15_001 },
      { nowMs: 10_000 }
    );
    const futureSnapshot = createHealthReport(
      { ...snapshot, lastSnapshotAtMs: 15_001 },
      { nowMs: 10_000 }
    );
    const futureInitialSnapshot = createHealthReport(
      { ...snapshot, initialSnapshotCompletedAtMs: 15_001 },
      { nowMs: 10_000 }
    );

    expect(futureHeartbeat.live).toBe(false);
    expect(futureHeartbeat.ready).toBe(false);
    expect(futureSnapshot.live).toBe(true);
    expect(futureSnapshot.ready).toBe(false);
    expect(futureInitialSnapshot.ready).toBe(false);
  });

  test("keeps current-context snapshot proof while requiring recent push evidence", () => {
    const store = new RuntimeStatusStore({ now: () => 500_000 });
    const snapshot = store.update({
      state: "CONNECTED",
      dbAvailable: true,
      heartbeatAtMs: 499_900,
      chromiumRunning: true,
      keeperPresent: true,
      authenticated: true,
      pushConnected: true,
      initialSnapshotComplete: true,
      parserHealthy: true,
      initialSnapshotCompletedAtMs: 1_000,
      lastSnapshotAtMs: 1_000,
      lastPushAtMs: 499_900,
      lastParserSuccessAtMs: 1_100
    });

    expect(createHealthReport(snapshot, { nowMs: 500_000, pushFreshMs: 5_000 }).ready).toBe(true);
    expect(
      createHealthReport(
        { ...snapshot, lastPushAtMs: 494_999 },
        { nowMs: 500_000, pushFreshMs: 5_000 }
      ).ready
    ).toBe(false);
    expect(createHealthReport({ ...snapshot, lastPushAtMs: undefined }, { nowMs: 500_000 }).ready).toBe(
      false
    );
    expect(
      createHealthReport({ ...snapshot, lastPushAtMs: 505_001 }, { nowMs: 500_000 }).ready
    ).toBe(false);
    expect(
      createHealthReport({ ...snapshot, lastParserSuccessAtMs: undefined }, { nowMs: 500_000 }).ready
    ).toBe(false);
    expect(
      createHealthReport({ ...snapshot, lastParserSuccessAtMs: 505_001 }, { nowMs: 500_000 }).ready
    ).toBe(false);
  });
});
