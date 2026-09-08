import { afterEach, describe, expect, test, vi } from "vitest";
import { scheduleLightStateRechecks } from "../../src/command/light-state-rechecks.js";
import { scheduleLocationRechecks } from "../../src/command/location-rechecks.js";

afterEach(() => vi.useRealTimers());

describe("bounded light status latency", () => {
  test("uses at most the existing eight reads and retains the final check", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const reads: number[] = [];
    const stop = scheduleLightStateRechecks(async () => { reads.push(Date.now()); }, { timeoutMs: 30_000, early: true });
    await vi.advanceTimersByTimeAsync(35_000); stop();
    expect(reads).toEqual([0, 500, 1_250, 2_500, 4_500, 8_000, 14_000, 25_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("disabled early verification does not enable a new poller", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const reads: number[] = [];
    scheduleLightStateRechecks(async () => { reads.push(Date.now()); }, { timeoutMs: 30_000, early: false });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads).toEqual([25_000]);
  });

  test("slow reads never overlap or catch up in a request burst", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let active = 0, maxActive = 0;
    const starts: number[] = [], ends: number[] = [];
    scheduleLightStateRechecks(async () => {
      starts.push(Date.now()); maxActive = Math.max(maxActive, ++active);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      ends.push(Date.now()); active--;
    }, { timeoutMs: 10_000, early: true });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(maxActive).toBe(1);
    starts.slice(1).forEach((start, index) => expect(start - ends[index]!).toBeGreaterThanOrEqual(250));
    expect(starts.every((at) => at < 10_000)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("success, supersession and timeout cancellation stop subsequent reads", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let finish!: () => void;
    const read = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const stop = scheduleLightStateRechecks(read, { timeoutMs: 30_000, early: true });
    await vi.advanceTimersByTimeAsync(1); stop(); finish();
    await vi.advanceTimersByTimeAsync(35_000);
    expect(read).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  test("a failed read is bounded and does not turn into a control retry", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const read = vi.fn(async () => { throw Error("unavailable"); });
    scheduleLightStateRechecks(read, { timeoutMs: 30_000, early: true });
    await vi.advanceTimersByTimeAsync(35_000);
    expect(read).toHaveBeenCalledTimes(8); expect(vi.getTimerCount()).toBe(0);
  });

  // Deterministic scheduler comparison, NOT physical light or Samsung measurements.
  test.each([[300, 1_250, 500], [2_000, 3_250, 2_500], [4_000, 6_250, 4_500]])(
    "observes a synthetic state ready at %ims: old %ims, new %ims", async (readyAt, oldAt, newAt) => {
      vi.useFakeTimers();
      for (const fast of [false, true]) {
        vi.setSystemTime(0); let observedAt: number | undefined; let stop: () => void;
        const read = async () => { if (Date.now() >= readyAt) { observedAt = Date.now(); stop(); } };
        stop = fast ? scheduleLightStateRechecks(read, { timeoutMs: 30_000, early: true })
          : scheduleLocationRechecks(read, { timeoutMs: 30_000, firstDelayMs: 250 });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(observedAt).toBe(fast ? newAt : oldAt);
      }
    });
});
