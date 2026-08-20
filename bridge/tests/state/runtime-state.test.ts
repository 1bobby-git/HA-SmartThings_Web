import { describe, expect, test, vi } from "vitest";

import {
  MAX_CLOCK_SKEW_MS,
  RUNTIME_STATES,
  RuntimeStatusStore,
  URL_CATEGORIES,
  type RuntimeStatusPatch,
  type RuntimeStatusStoreOptions
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
    expect(URL_CATEGORIES).toEqual([
      "none",
      "smartthings_location",
      "smartthings_advanced",
      "samsung_login",
      "other",
      "error"
    ]);
    expect(store.getSnapshot()).toEqual({
      state: "STARTING",
      urlCategory: "none",
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
      browserVersion: "unknown",
      protocolVersion: "unknown",
      heartbeatAtMs: 1_000,
      updatedAtMs: 1_000,
      initialSnapshotCompletedAtMs: undefined,
      lastSnapshotAtMs: undefined,
      lastFrameAtMs: undefined,
      lastEventAtMs: undefined,
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
      urlCategory: "smartthings_location",
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
      browserVersion: "Chromium 141.0.7390.122",
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
      urlCategory: "smartthings_location",
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
      browserVersion: "Chromium 141.0.7390.122",
      protocolVersion: "2026-08"
    });

    unsubscribe();
    now = 13_000;
    store.update({ state: "STALE" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("rejects unsafe keys and invalid values from untyped callers", () => {
    const store = new RuntimeStatusStore({ now: () => 1 });
    const invalidPatches: RuntimeStatusPatch[] = [
      ({
        url: "https://smartthingsfind.samsung.com/map?deviceId=raw-device&token=secret"
      } as unknown) as RuntimeStatusPatch,
      ({ deviceId: "raw-device" } as unknown) as RuntimeStatusPatch,
      ({ activeConnections: -1 } as unknown) as RuntimeStatusPatch,
      ({ observedDeviceCount: 1.5 } as unknown) as RuntimeStatusPatch,
      ({ chromiumRunning: "yes" } as unknown) as RuntimeStatusPatch,
      ({ state: "BOOTED" } as unknown) as RuntimeStatusPatch,
      ({ urlCategory: "map" } as unknown) as RuntimeStatusPatch,
      ({ heartbeatAtMs: -1 } as unknown) as RuntimeStatusPatch,
      ({ lastFrameAtMs: Number.NaN } as unknown) as RuntimeStatusPatch,
      ({ bridgeVersion: "0.1.0?token=secret" } as unknown) as RuntimeStatusPatch,
      ({ protocolVersion: "proto\nraw" } as unknown) as RuntimeStatusPatch,
      ({ browserVersion: "https://browser.example/version" } as unknown) as RuntimeStatusPatch
    ];

    for (const patch of invalidPatches) {
      expect(() => store.update(patch)).toThrow();
    }
    expect(store.getSnapshot()).not.toHaveProperty("url");
    expect(store.getSnapshot()).not.toHaveProperty("deviceId");
    expect(store.getSnapshot().activeConnections).toBe(0);
  });

  test("rejects unsupported raw keys and invalid values in constructor initial state", () => {
    const invalidOptions: RuntimeStatusStoreOptions[] = [
      { initial: ({ locationId: "raw-location" } as unknown) as RuntimeStatusPatch },
      { initial: ({ urlCategory: "signin" } as unknown) as RuntimeStatusPatch },
      { initial: ({ authenticated: "true" } as unknown) as RuntimeStatusPatch },
      { initial: ({ lastEventAtMs: -1 } as unknown) as RuntimeStatusPatch },
      { initial: ({ browserVersion: "Chromium 141 token=secret" } as unknown) as RuntimeStatusPatch }
    ];

    for (const options of invalidOptions) {
      expect(() => new RuntimeStatusStore(options)).toThrow();
    }
  });

  test("rejects timestamp fields beyond the allowed clock skew in constructor and updates", () => {
    const now = 10_000;
    const withinSkew = now + MAX_CLOCK_SKEW_MS;
    const beyondSkew = withinSkew + 1;

    expect(
      () =>
        new RuntimeStatusStore({
          now: () => now,
          initial: { heartbeatAtMs: beyondSkew }
        })
    ).toThrow(/clock skew/i);

    const store = new RuntimeStatusStore({ now: () => now });

    expect(store.update({ heartbeatAtMs: withinSkew }).heartbeatAtMs).toBe(withinSkew);
    expect(() => store.update({ lastSnapshotAtMs: beyondSkew })).toThrow(/clock skew/i);
    expect(store.getSnapshot().lastSnapshotAtMs).toBeUndefined();
  });

  test("commits updates and notifies later subscribers when one subscriber throws", () => {
    const errors: unknown[] = [];
    const store = new RuntimeStatusStore({
      now: () => 1_000,
      onListenerError: (error) => errors.push(error)
    });
    const throwingError = new Error("listener failed");
    const first = vi.fn(() => {
      throw throwingError;
    });
    const second = vi.fn();

    store.subscribe(first);
    store.subscribe(second);

    const snapshot = store.update({ state: "CONNECTED" });

    expect(snapshot.state).toBe("CONNECTED");
    expect(store.getSnapshot()).toBe(snapshot);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledWith(snapshot, expect.objectContaining({ state: "STARTING" }));
    expect(errors).toEqual([throwingError]);
  });
});
