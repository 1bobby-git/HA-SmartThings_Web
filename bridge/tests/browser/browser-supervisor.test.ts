import { describe, expect, test, vi } from "vitest";

import { BrowserSupervisor } from "../../src/browser/browser-supervisor.js";
import type { RuntimeStatusPatch, RuntimeStatusStore } from "../../src/state/runtime-state.js";

class FakeStatusStore {
  readonly updates: RuntimeStatusPatch[] = [];

  update(update: RuntimeStatusPatch): RuntimeStatusPatch {
    this.updates.push(update);
    return update;
  }
}

describe("BrowserSupervisor", () => {
  test("attempts the initial launch plus maxRestarts retries before failing", async () => {
    const launch = vi.fn(async () => {
      throw new Error("browser failed");
    });
    const status = new FakeStatusStore();
    const supervisor = new BrowserSupervisor({
      launch,
      maxRestarts: 2,
      status: status as unknown as RuntimeStatusStore,
      now: () => 123
    });

    const context = await supervisor.start();

    expect(context).toBeUndefined();
    expect(launch).toHaveBeenCalledTimes(3);
    expect(status.updates.at(-1)).toMatchObject({
      chromiumRunning: false,
      restartCount: 3,
      state: "BROWSER_FAILED"
    });
  });

  test("succeeds after a retry and records browser start time from the injected clock", async () => {
    const context = { id: "context" };
    const launch = vi
      .fn()
      .mockRejectedValueOnce(new Error("first launch failed"))
      .mockResolvedValueOnce(context);
    const status = new FakeStatusStore();
    const supervisor = new BrowserSupervisor({
      launch,
      maxRestarts: 2,
      status: status as unknown as RuntimeStatusStore,
      now: () => 987_654
    });

    await expect(supervisor.start()).resolves.toBe(context);

    expect(launch).toHaveBeenCalledTimes(2);
    expect(status.updates.at(-1)).toMatchObject({
      chromiumRunning: true,
      lastBrowserStartAtMs: 987_654,
      state: "LOGIN_REQUIRED"
    });
  });

  test("resets retry budget for each start while keeping restartCount cumulative", async () => {
    const first = { id: "first" };
    const second = { id: "second" };
    const launch = vi
      .fn()
      .mockRejectedValueOnce(new Error("first cycle failure"))
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error("second cycle failure"))
      .mockResolvedValueOnce(second);
    const status = new FakeStatusStore();
    const supervisor = new BrowserSupervisor({
      launch,
      maxRestarts: 1,
      status: status as unknown as RuntimeStatusStore,
      now: () => 111
    });

    await expect(supervisor.start()).resolves.toBe(first);
    await expect(supervisor.start()).resolves.toBe(second);

    expect(launch).toHaveBeenCalledTimes(4);
    expect(status.updates.filter((update) => update.restartCount !== undefined)).toEqual([
      expect.objectContaining({ restartCount: 1 }),
      expect.objectContaining({ restartCount: 2 })
    ]);
  });
});
