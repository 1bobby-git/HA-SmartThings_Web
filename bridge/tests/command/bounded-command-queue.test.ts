import { describe, test, expect, vi } from "vitest";
import { enqueueWithDeadline } from "../../src/command/bounded-command-queue.js";

describe("bounded UI queue", () => {
  test("expired work is not invoked, and the tail still protects the running predecessor", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const previous = new Promise<void>((resolve) => { release = resolve; });
      const expiredWork = vi.fn(async () => 1);
      const a = enqueueWithDeadline(previous, expiredWork, 10);
      const rejected = a.result.catch((error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(11);
      expect(await rejected).toBe("command_queue_timeout");
      const next = vi.fn(async () => 2);
      const b = enqueueWithDeadline(a.completion, next, 100);
      await vi.advanceTimersByTimeAsync(1); expect(next).not.toHaveBeenCalled();
      release(); expect(await b.result).toBe(2);
      expect(expiredWork).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  test("a rejected predecessor does not poison the queue", async () => {
    const previous = Promise.reject(new Error("previous failed"));
    const queued = enqueueWithDeadline(previous, async () => 3, 30);
    expect(await queued.result).toBe(3); await queued.completion;
  });
  test("the waiting deadline stops when actual execution starts", async () => {
    const queued = enqueueWithDeadline(Promise.resolve(), async () => {
      await new Promise((resolve) => setTimeout(resolve, 20)); return 4;
    }, 5);
    expect(await queued.result).toBe(4);
  });
});
