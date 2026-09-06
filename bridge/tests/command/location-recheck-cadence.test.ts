import { afterEach, expect, test, vi } from "vitest";
import { scheduleLocationRechecks } from "../../src/command/location-rechecks.js";
afterEach(() => vi.useRealTimers());
test("30-second Home Monitor window does not jump from 7 to 25 seconds", async () => {
  vi.useFakeTimers(); const start = Date.now(); const times: number[] = [];
  scheduleLocationRechecks(async () => { times.push(Date.now() - start); }, { timeoutMs: 30_000, firstDelayMs: 1_000 });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(times).toEqual([1_000, 2_000, 4_000, 7_000, 10_000, 15_000, 20_000, 25_000]);
});
test("a state visible after eight seconds is checked at ten seconds, with no later reads", async () => {
  vi.useFakeTimers(); const start = Date.now(); const times: number[] = []; let stop = () => {};
  stop = scheduleLocationRechecks(async () => { times.push(Date.now() - start); if (Date.now() - start >= 8_000) stop(); },
    { timeoutMs: 30_000, firstDelayMs: 1_000 });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(times).toEqual([1_000, 2_000, 4_000, 7_000, 10_000]);
});
test("long or disabled windows remain bounded", async () => {
  vi.useFakeTimers(); const read = vi.fn(async () => undefined);
  scheduleLocationRechecks(read, { timeoutMs: 120_000, firstDelayMs: 1_000 });
  await vi.advanceTimersByTimeAsync(240_000); expect(read).toHaveBeenCalledTimes(8);
  read.mockClear(); scheduleLocationRechecks(read, { timeoutMs: 30_000 });
  await vi.advanceTimersByTimeAsync(60_000); expect(read).toHaveBeenCalledOnce();
});
