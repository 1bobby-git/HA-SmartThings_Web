import { afterEach, expect, test, vi } from "vitest";
import { enqueueLightIntent } from "../../src/command/latest-light-queue.js";
afterEach(() => vi.useRealTimers());
const error = (code: string) => new Error(code);

test("expired queued work never dispatches when its predecessor eventually finishes", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const predecessor = new Promise<void>((resolve) => { release = resolve; });
  const work = vi.fn(async () => "sent");
  const next = enqueueLightIntent(predecessor, work, new AbortController().signal, 10_000, error);
  const outcome = next.result.catch((failure) => failure.message);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await outcome).toBe("command_queue_timeout");
  release(); await next.completion;
  expect(work).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

test("already aborted intent preserves the real predecessor lane and clears resources", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const predecessor = new Promise<void>((resolve) => { release = resolve; });
  const controller = new AbortController(); controller.abort();
  const work = vi.fn(async () => "sent");
  const next = enqueueLightIntent(predecessor, work, controller.signal, 10_000, error);
  await expect(next.result).rejects.toThrow("command_superseded");
  let completed = false; void next.completion.then(() => { completed = true; });
  await vi.advanceTimersByTimeAsync(10_001); expect(completed).toBe(false);
  release(); await next.completion;
  expect(work).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
