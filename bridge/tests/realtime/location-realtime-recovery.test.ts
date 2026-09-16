import { afterEach, describe, expect, test, vi } from "vitest";
import { LocationRealtimeAdapter } from "../../src/realtime/location-realtime-adapter.js";

const adapters: LocationRealtimeAdapter[] = [];
afterEach(() => { for (const adapter of adapters.splice(0)) adapter.stop(); vi.useRealTimers(); });
function fixture(recover = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)) {
  vi.useFakeTimers();
  const failed = vi.fn(); const recovered = vi.fn();
  const adapter = new LocationRealtimeAdapter({ recover, onRecoveryFailed: failed,
    onRecovered: recovered, recoveredFrameTimeoutMs: 30_000 });
  adapters.push(adapter);
  return { adapter, recover, failed, recovered };
}

describe("silent realtime recovery", () => {
  test("retries successful navigation that never produces an inbound frame", async () => {
    const f = fixture(); f.adapter.requestRecovery(); await vi.advanceTimersByTimeAsync(0);
    expect(f.recover).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000); expect(f.failed).toHaveBeenCalledOnce();
    expect(f.recovered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000); expect(f.recover).toHaveBeenCalledTimes(2);
  });

  test("outbound frames do not acknowledge recovery", async () => {
    const f = fixture(); f.adapter.requestRecovery(); await vi.advanceTimersByTimeAsync(0);
    expect(f.adapter.observeFrame("sent")).toBe(false);
    await vi.advanceTimersByTimeAsync(31_000); expect(f.recover).toHaveBeenCalledTimes(2);
  });

  test("an inbound frame cancels the acknowledgement timeout", async () => {
    const f = fixture(); f.adapter.requestRecovery(); await vi.advanceTimersByTimeAsync(0);
    expect(f.adapter.observeFrame("received")).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.recover).toHaveBeenCalledOnce(); expect(f.recovered).toHaveBeenCalledOnce();
  });

  test("watchdog calls cannot defeat the scheduled failure backoff", async () => {
    const f = fixture(vi.fn<() => Promise<void>>().mockRejectedValue(new Error("network")));
    f.adapter.requestRecovery(); await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 20; index += 1) f.adapter.requestRecovery();
    await vi.advanceTimersByTimeAsync(999); expect(f.recover).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(f.recover).toHaveBeenCalledTimes(2);
  });

  test("a temporarily unsafe navigation is deferred rather than forgotten", async () => {
    vi.useFakeTimers(); let allowed = false; const recover = vi.fn().mockResolvedValue(undefined);
    const adapter = new LocationRealtimeAdapter({ recover, canRecover: () => allowed }); adapters.push(adapter);
    adapter.requestRecovery(); await vi.advanceTimersByTimeAsync(1_000);
    expect(recover).not.toHaveBeenCalled();
    allowed = true; await vi.advanceTimersByTimeAsync(1_000); expect(recover).toHaveBeenCalledOnce();
  });

  test("stop cancels timers and ignores late completions", async () => {
    let resolve!: () => void;
    const f = fixture(vi.fn(() => new Promise<void>((done) => { resolve = done; })));
    f.adapter.requestRecovery(); await vi.advanceTimersByTimeAsync(0);
    f.adapter.stop(); resolve(); await vi.advanceTimersByTimeAsync(120_000);
    expect(f.recover).toHaveBeenCalledOnce(); expect(f.failed).not.toHaveBeenCalled();
    expect(f.adapter.observeFrame("received")).toBe(false);
  });

  test("a synchronous recovery exception uses the bounded retry path", async () => {
    const f = fixture(vi.fn((): Promise<void> => { throw new Error("sync"); }));
    expect(() => f.adapter.requestRecovery()).not.toThrow();
    await vi.advanceTimersByTimeAsync(1_000); expect(f.recover).toHaveBeenCalledTimes(2);
  });

  test("an inbound frame before navigation resolves still acknowledges recovery", async () => {
    let resolve!: () => void;
    const f = fixture(vi.fn(() => new Promise<void>((done) => { resolve = done; })));
    f.adapter.requestRecovery(); await vi.advanceTimersByTimeAsync(0);
    f.adapter.observeFrame("received"); resolve(); await vi.advanceTimersByTimeAsync(60_000);
    expect(f.recover).toHaveBeenCalledOnce(); expect(f.recovered).toHaveBeenCalledOnce();
  });
});
