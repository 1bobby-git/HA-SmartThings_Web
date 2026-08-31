import { describe, expect, test } from "vitest";

import { LocationRealtimeAdapter } from "../../src/realtime/location-realtime-adapter.js";

describe("LocationRealtimeAdapter", () => {
  test("emits one recovered signal on the first inbound frame after reconnect", () => {
    let now = 1_000;
    const adapter = new LocationRealtimeAdapter({ now: () => now });

    adapter.recoveryStarted();
    now = 2_000;

    expect(adapter.observeFrame("sent")).toBe(false);
    expect(adapter.observeFrame("received")).toBe(true);
    expect(adapter.observeFrame("received")).toBe(false);
    expect(adapter.snapshot()).toEqual({
      awaitingRecoveredFrame: false,
      reconnectCount: 1,
      lastReconnectAtMs: 1_000,
      lastReceivedAtMs: 2_000,
    });
  });
});
