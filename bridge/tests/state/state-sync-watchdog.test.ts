import { describe, expect, test, vi } from "vitest";
import { StateSyncWatchdog } from "../../src/state/state-sync-watchdog.js";

function fixture(intervalMs = 21_600_000) {
  let now = 1_000;
  let allowed = true;
  const observation: { decodedDeviceEventCount: number; uniqueLogicalEventCount?: number; advancedInventoryLastSyncAtMs?: number } = {
    decodedDeviceEventCount: 10
  };
  const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const diagnostic = vi.fn();
  const watchdog = new StateSyncWatchdog({
    now: () => now, observe: () => observation, canRun: () => allowed,
    refresh, intervalMs, onDiagnostic: diagnostic
  });
  return { watchdog, observation, refresh, diagnostic,
    time: (value: number) => { now = value; }, allow: (value: boolean) => { allowed = value; } };
}

describe("state synchronization independent of authenticated heartbeat", () => {
  test("refreshes quiet data after two minutes, not after six hours", async () => {
    const f = fixture();
    await f.watchdog.tick();
    f.time(120_999); await f.watchdog.tick();
    expect(f.refresh).not.toHaveBeenCalled();
    f.time(121_000); await f.watchdog.tick();
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.diagnostic).toHaveBeenCalledWith({ outcome: "ok", reason: "quiet", durationMs: 0, consecutiveFailures: 0 });
    f.time(240_999); await f.watchdog.tick();
    expect(f.refresh).toHaveBeenCalledOnce();
    f.time(241_000); await f.watchdog.tick();
    expect(f.refresh).toHaveBeenCalledTimes(2);
  });

  test("transport and session heartbeat changes do not count as device progress", async () => {
    const f = fixture();
    const observation = f.observation as typeof f.observation & { lastPushAtMs: number; sessionTouchCount: number };
    await f.watchdog.tick();
    for (let index = 1; index <= 12; index += 1) {
      const now = 1_000 + index * 10_000;
      observation.lastPushAtMs = now;
      observation.sessionTouchCount = index;
      f.time(now); await f.watchdog.tick();
    }
    expect(f.refresh).toHaveBeenCalledOnce();
  });

  test("real events suppress quiet reads but cannot hide a partial-stream failure", async () => {
    const f = fixture(); await f.watchdog.tick();
    for (let index = 1; index <= 20; index += 1) {
      f.time(1_000 + index * 60_000); f.observation.decodedDeviceEventCount += 1;
      await f.watchdog.tick();
    }
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.diagnostic.mock.calls[0]?.[0].reason).toBe("interval");
  });

  test("the configured full reconciliation interval still runs during active events", async () => {
    const f = fixture(180_000); await f.watchdog.tick();
    for (let index = 1; index <= 3; index += 1) {
      f.time(1_000 + index * 60_000); f.observation.decodedDeviceEventCount += 1;
      await f.watchdog.tick();
    }
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.diagnostic.mock.calls[0]?.[0].reason).toBe("interval");
  });

  test("a successful external full sync postpones the next quiet read", async () => {
    const f = fixture(); await f.watchdog.tick();
    f.time(120_000); f.observation.advancedInventoryLastSyncAtMs = 120_000;
    await f.watchdog.tick();
    f.time(239_999); await f.watchdog.tick(); expect(f.refresh).not.toHaveBeenCalled();
    f.time(240_000); await f.watchdog.tick(); expect(f.refresh).toHaveBeenCalledOnce();
  });

  test("defers during commands/login/maintenance and retries when safe", async () => {
    const f = fixture(); await f.watchdog.tick(); f.time(121_000); f.allow(false);
    await f.watchdog.tick(); expect(f.refresh).not.toHaveBeenCalled();
    f.allow(true); await f.watchdog.tick(); expect(f.refresh).toHaveBeenCalledOnce();
  });

  test("coalesces overlapping checks until the current read finishes", async () => {
    const f = fixture(); let resolve!: () => void;
    f.refresh.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    await f.watchdog.tick(); f.time(121_000);
    const first = f.watchdog.tick(); const second = f.watchdog.tick();
    expect(first).toBe(second);
    await Promise.resolve(); expect(f.refresh).toHaveBeenCalledOnce();
    resolve(); await first;
  });

  test("backs off failures without treating them as logout or successful sync", async () => {
    const f = fixture(); f.refresh.mockRejectedValue(new Error("network"));
    await f.watchdog.tick(); f.time(121_000); await f.watchdog.tick();
    expect(f.diagnostic.mock.calls[0]?.[0].outcome).toBe("failed");
    f.time(150_999); await f.watchdog.tick(); expect(f.refresh).toHaveBeenCalledOnce();
    f.time(151_000); await f.watchdog.tick(); expect(f.refresh).toHaveBeenCalledTimes(2);
    f.time(210_999); await f.watchdog.tick(); expect(f.refresh).toHaveBeenCalledTimes(2);
    f.refresh.mockResolvedValue(undefined); f.time(211_000); await f.watchdog.tick();
    expect(f.diagnostic.mock.calls.at(-1)?.[0].consecutiveFailures).toBe(0);
  });

  test("handles a synchronous transport exception and throwing diagnostics", async () => {
    const f = fixture(); f.refresh.mockImplementation(() => { throw new Error("transport"); });
    f.diagnostic.mockImplementation(() => { throw new Error("log"); });
    await f.watchdog.tick(); f.time(121_000);
    await expect(f.watchdog.tick()).resolves.toBeUndefined();
    f.time(151_000); await f.watchdog.tick(); expect(f.refresh).toHaveBeenCalledTimes(2);
  });

  test("backwards clock correction cannot suspend synchronization indefinitely", async () => {
    const f = fixture(); f.time(500_000); await f.watchdog.tick();
    f.time(1_000); await f.watchdog.tick();
    f.time(121_000); await f.watchdog.tick(); expect(f.refresh).toHaveBeenCalledOnce();
  });
});

test("replayed device frames cannot suppress quiet recovery", async () => {
  const f = fixture(); f.observation.uniqueLogicalEventCount = 5;
  await f.watchdog.tick();
  for (let index = 1; index <= 12; index += 1) {
    f.time(1_000 + index * 10_000); f.observation.decodedDeviceEventCount += 10;
    await f.watchdog.tick();
  }
  expect(f.refresh).toHaveBeenCalledOnce();
  expect(f.diagnostic.mock.calls[0]?.[0].reason).toBe("quiet");
});

test("unique device progress still postpones a quiet read", async () => {
  const f = fixture(); f.observation.uniqueLogicalEventCount = 5;
  await f.watchdog.tick();
  f.time(120_000); f.observation.uniqueLogicalEventCount += 1;
  await f.watchdog.tick(); expect(f.refresh).not.toHaveBeenCalled();
  f.time(239_999); await f.watchdog.tick(); expect(f.refresh).not.toHaveBeenCalled();
  f.time(240_000); await f.watchdog.tick(); expect(f.refresh).toHaveBeenCalledOnce();
});
