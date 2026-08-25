import { describe, expect, test, vi } from "vitest";

import { installShutdownHandlers, startupFailureToken } from "../src/main.js";

describe("startup failure diagnostics", () => {
  test("reports only allowlisted error-code characters", () => {
    expect(startupFailureToken({ code: "EACCES" })).toBe("EACCES");
    expect(startupFailureToken({ code: "SQLITE_CANTOPEN" })).toBe("SQLITE_CANTOPEN");
  });

  test("does not expose messages, paths, or malformed codes", () => {
    expect(startupFailureToken(new Error("secret path /data/private"))).toBe("UNKNOWN");
    expect(startupFailureToken({ code: "EACCES:/data/private" })).toBe("UNKNOWN");
    expect(startupFailureToken({ code: "" })).toBe("UNKNOWN");
  });
});

describe("graceful shutdown", () => {
  test("waits for the persistent browser context to close before exiting", async () => {
    const handlers = new Map<string, () => void>();
    const stop = vi.fn(async () => undefined);
    const exit = vi.fn();
    installShutdownHandlers(
      { stop },
      {
        once: (signal, handler) => handlers.set(signal, handler),
        exit
      }
    );

    handlers.get("SIGTERM")?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("logs a fixed failure and exits once when graceful shutdown fails", async () => {
    const handlers = new Map<string, () => void>();
    const stop = vi.fn(async () => {
      throw new Error("private shutdown detail");
    });
    const exit = vi.fn();
    const log = { error: vi.fn() };
    installShutdownHandlers(
      { stop },
      {
        once: (signal, handler) => handlers.set(signal, handler),
        exit
      },
      log
    );

    handlers.get("SIGTERM")?.();
    handlers.get("SIGINT")?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

    expect(stop).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith("bridge_stop_failed");
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
