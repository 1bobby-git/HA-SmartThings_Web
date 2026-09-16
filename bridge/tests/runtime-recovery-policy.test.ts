import { describe, expect, test } from "vitest";
import { shouldRecoverStaleSmartThingsWebSocket } from "../src/runtime.js";
import type { RuntimeStatusSnapshot } from "../src/state/runtime-state.js";

const baseline = { state: "CONNECTED", authenticated: true, chromiumRunning: true,
  dbAvailable: true, keeperPresent: true, lastPushAtMs: 1_000, lastBrowserStartAtMs: 500,
  pushConnected: false, parserHealthy: false, initialSnapshotComplete: false } as RuntimeStatusSnapshot;

describe("stale realtime recovery policy", () => {
  test.each(["CONNECTED", "STALE", "SYNCING", "DISCOVERING_PROTOCOL", "RECONNECTING"] as const)(
    "recovers incomplete %s state without requiring already-healthy flags", (state) => {
      expect(shouldRecoverStaleSmartThingsWebSocket({ ...baseline, state }, 122_000)).toBe(true);
    });
  test.each(["PROTOCOL_CHANGED", "LOGIN_REQUIRED", "BROWSER_FAILED"] as const)(
    "does not override %s", (state) => {
      expect(shouldRecoverStaleSmartThingsWebSocket({ ...baseline, state }, 122_000)).toBe(false);
    });
  test("does not recover an unauthenticated keeper", () => {
    expect(shouldRecoverStaleSmartThingsWebSocket({ ...baseline, authenticated: false }, 122_000)).toBe(false);
  });
  test("gives a new attempt time to receive its initial frame", () => {
    expect(shouldRecoverStaleSmartThingsWebSocket({ ...baseline, lastReconnectAtMs: 121_000 }, 122_000)).toBe(false);
  });
  test("handles a keeper that never received its first frame", () => {
    expect(shouldRecoverStaleSmartThingsWebSocket({ ...baseline, lastPushAtMs: undefined }, 122_000)).toBe(true);
  });
});
