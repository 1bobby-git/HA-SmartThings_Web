import { describe, expect, test, vi } from "vitest";

import {
  BrowserSupervisor,
  browserLaunchFailureToken
} from "../../src/browser/browser-supervisor.js";
import type { RuntimeStatusPatch, RuntimeStatusStore } from "../../src/state/runtime-state.js";

class FakeStatusStore {
  readonly updates: RuntimeStatusPatch[] = [];

  update(update: RuntimeStatusPatch): RuntimeStatusPatch {
    this.updates.push(update);
    return update;
  }
}

describe("BrowserSupervisor", () => {
  test("reduces launch failures to an allowlisted code token", () => {
    expect(browserLaunchFailureToken({ code: "EACCES" })).toBe("EACCES");
    expect(browserLaunchFailureToken({ code: "EACCES:/data/private" })).toBe("UNKNOWN");
    expect(browserLaunchFailureToken(new Error("spawn permission denied /raw/path"))).toBe(
      "PERMISSION_DENIED"
    );
    expect(
      browserLaunchFailureToken(
        new Error(
          "<launching> /ms-playwright/chromium-1234/chrome --user-data-dir=/data/chromium-profile\n[err] /root/.config/chromium: Permission denied"
        )
      )
    ).toBe("HOME_PERMISSION");
    expect(
      browserLaunchFailureToken(
        new Error("[err] /ms-playwright/chromium-1234/chrome-linux64/helper: Permission denied")
      )
    ).toBe("PLAYWRIGHT_BUNDLE_PERMISSION");
    expect(
      browserLaunchFailureToken(new Error("[err] zygote host failed: Permission denied"))
    ).toBe("ZYGOTE_PERMISSION");
    expect(
      browserLaunchFailureToken(
        new Error("[FATAL:sandbox/linux/services/credentials.cc:135] Permission denied")
      )
    ).toBe("CREDENTIALS_PERMISSION");
    expect(
      browserLaunchFailureToken(new Error("[FATAL:namespace sandbox] Operation not permitted"))
    ).toBe("USERNS_PERMISSION");
    expect(
      browserLaunchFailureToken(new Error("[FATAL:seccomp sandbox] Operation not permitted"))
    ).toBe("SECCOMP_PERMISSION");
    expect(
      browserLaunchFailureToken(
        new Error("[FATAL:sandbox/linux/sandbox_linux.cc:379] Permission denied")
      )
    ).toBe("CHROMIUM_SANDBOX_LINUX_PERMISSION");
    expect(browserLaunchFailureToken(new Error("Running as root without --no-sandbox"))).toBe(
      "SANDBOX_REQUIRED"
    );
    expect(
      browserLaunchFailureToken(
        new Error("The SUID sandbox helper binary was found, but is not configured correctly")
      )
    ).toBe("SUID_SANDBOX_CONFIG");
    expect(
      browserLaunchFailureToken(new Error("chrome_sandbox: Permission denied"))
    ).toBe("SUID_SANDBOX_PERMISSION");
    expect(
      browserLaunchFailureToken(
        new Error("browserType.launchPersistentContext: Timeout 30000ms exceeded.")
      )
    ).toBe("LAUNCH_TIMEOUT");
    expect(browserLaunchFailureToken(new Error("Executable doesn't exist at /raw/path"))).toBe(
      "EXECUTABLE_MISSING"
    );
    expect(browserLaunchFailureToken(new Error("Target page, context or browser has been closed"))).toBe(
      "BROWSER_CLOSED"
    );
    expect(browserLaunchFailureToken(new Error("raw token=secret"))).toBe("UNKNOWN");
  });

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

  test("waits between failed launch attempts but not after the final failure", async () => {
    const launch = vi.fn(async () => {
      throw new Error("transient launch failure");
    });
    const wait = vi.fn(async () => undefined);
    const status = new FakeStatusStore();
    const supervisor = new BrowserSupervisor({
      launch,
      maxRestarts: 2,
      retryDelayMs: 1_000,
      wait,
      status: status as unknown as RuntimeStatusStore
    });

    await supervisor.start();

    expect(launch).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 1_000);
    expect(wait).toHaveBeenNthCalledWith(2, 1_000);
  });
});
