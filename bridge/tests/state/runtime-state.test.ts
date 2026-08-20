import { describe, expect, test, vi } from "vitest";

import {
  RUNTIME_STATES,
  RuntimeStatusStore,
  type RuntimeStatusPatch
} from "../../src/state/runtime-state.js";

describe("RuntimeStatusStore", () => {
  test("starts with the exact runtime states and safe default snapshot", () => {
    const store = new RuntimeStatusStore({ now: () => 1_000 });

    expect(RUNTIME_STATES).toEqual([
      "STARTING",
      "BROWSER_STARTING",
      "LOGIN_REQUIRED",
      "AUTHENTICATING",
      "PAGE_LOADING",
      "DISCOVERING_PROTOCOL",
      "SYNCING",
      "CONNECTED",
      "STALE",
      "RECONNECTING",
      "REAUTH_REQUIRED",
      "PROTOCOL_CHANGED",
      "BROWSER_FAILED",
      "FATAL"
    ]);
    expect(store.getSnapshot()).toEqual({
      state: "STARTING",
      urlCategory: "unknown",
      chromiumRunning: false,
      keeperPresent: false,
      authenticated: false,
      pushConnected: false,
      initialSnapshotComplete: false,
      parserHealthy: false,
      dbAvailable: false,
      activeConnections: 0,
      observedDeviceCount: 0,
      protocolChangeCount: 0,
      restartCount: 0,
      bridgeVersion: "0.0.0-dev",
      protocolVersion: "unknown",
      heartbeatAtMs: 1_000,
      updatedAtMs: 1_000,
      initialSnapshotCompletedAtMs: undefined,
      lastPushAtMs: undefined,
      lastParserSuccessAtMs: undefined,
      lastBrowserStartAtMs: undefined,
      lastStateChangeAtMs: 1_000
    });
  });

  test("applies controlled partial updates as immutable observable snapshots", () => {
    let now = 10_000;
    const store = new RuntimeStatusStore({ now: () => now });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const before = store.getSnapshot();

    now = 12_500;
    const after = store.update({
      state: "CONNECTED",
      urlCategory: "map",
      chromiumRunning: true,
      keeperPresent: true,
      authenticated: true,
      pushConnected: true,
      initialSnapshotComplete: true,
      parserHealthy: true,
      dbAvailable: true,
      activeConnections: 2,
      observedDeviceCount: 7,
      bridgeVersion: "0.1.0",
      protocolVersion: "2026-08"
    });

    expect(before.state).toBe("STARTING");
    expect(after).not.toBe(before);
    expect(listener).toHaveBeenCalledWith(after, before);
    expect(after.updatedAtMs).toBe(12_500);
    expect(after.lastStateChangeAtMs).toBe(12_500);
    expect(after.initialSnapshotCompletedAtMs).toBe(12_500);
    expect(after).toMatchObject({
      state: "CONNECTED",
      urlCategory: "map",
      chromiumRunning: true,
      keeperPresent: true,
      authenticated: true,
      pushConnected: true,
      initialSnapshotComplete: true,
      parserHealthy: true,
      dbAvailable: true,
      activeConnections: 2,
      observedDeviceCount: 7,
      bridgeVersion: "0.1.0",
      protocolVersion: "2026-08"
    });

    unsubscribe();
    now = 13_000;
    store.update({ state: "STALE" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("rejects unsafe keys and invalid counters from untyped callers", () => {
    const store = new RuntimeStatusStore({ now: () => 1 });
    const unsafePatch = {
      url: "https://smartthingsfind.samsung.com/map?deviceId=raw-device&token=secret",
      deviceId: "raw-device",
      activeConnections: -1
    } as RuntimeStatusPatch;

    expect(() => store.update(unsafePatch)).toThrow(/unsupported runtime status field: deviceId|url/);
    expect(store.getSnapshot()).not.toHaveProperty("url");
    expect(store.getSnapshot()).not.toHaveProperty("deviceId");
    expect(store.getSnapshot().activeConnections).toBe(0);
  });
});
