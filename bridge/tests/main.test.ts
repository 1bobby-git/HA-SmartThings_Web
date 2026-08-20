import { describe, expect, test, vi } from "vitest";

import { installShutdownHandlers } from "../src/main.js";

describe("installShutdownHandlers", () => {
  test("records signal intent and logs fixed text when stop rejects", async () => {
    const handlers = new Map<string, () => void>();
    const processLike = {
      once: vi.fn((signal: string, handler: () => void) => {
        handlers.set(signal, handler);
        return processLike;
      })
    };
    const log = { error: vi.fn() };
    const runtime = {
      stop: vi.fn(async () => {
        throw new Error("raw stop token=secret");
      })
    };

    installShutdownHandlers(runtime, processLike, log);
    handlers.get("SIGTERM")?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith("bridge_stop_failed");
    expect(JSON.stringify(log.error.mock.calls)).not.toMatch(/raw stop|secret/);
  });
});
