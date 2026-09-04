import { describe, expect, test, vi } from "vitest";

import { launchSmartThingsPersistentContext } from "../../src/browser/persistent-context.js";

const paths = {
  dataDir: "/data",
  profileDir: "/data/chromium-profile",
  downloadDir: "/data/downloads"
};

describe("persistent Chromium sandbox compatibility fallback", () => {
  test("retries exactly once without Chromium sandbox for a recognized sandbox startup failure", async () => {
    const launchPersistentContext = vi
      .fn()
      .mockRejectedValueOnce(new Error("No usable sandbox! Update your kernel or see Chromium sandbox documentation."))
      .mockResolvedValueOnce({ ok: true });
    const onSandboxFallback = vi.fn();

    const result = await launchSmartThingsPersistentContext(
      { launchPersistentContext },
      paths,
      { onSandboxFallback }
    );

    expect(result).toEqual({ ok: true });
    expect(launchPersistentContext).toHaveBeenCalledTimes(2);
    expect(launchPersistentContext.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ chromiumSandbox: true, headless: false })
    );
    expect(launchPersistentContext.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ chromiumSandbox: false, headless: false })
    );
    expect(onSandboxFallback).toHaveBeenCalledTimes(1);
  });

  test("does not weaken the sandbox for unrelated browser startup failures", async () => {
    const launchPersistentContext = vi
      .fn()
      .mockRejectedValue(new Error("browser executable is temporarily unavailable"));
    const onSandboxFallback = vi.fn();

    await expect(
      launchSmartThingsPersistentContext(
        { launchPersistentContext },
        paths,
        { onSandboxFallback }
      )
    ).rejects.toThrow("browser executable is temporarily unavailable");

    expect(launchPersistentContext).toHaveBeenCalledTimes(1);
    expect(onSandboxFallback).not.toHaveBeenCalled();
  });
});
