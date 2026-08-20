import { describe, expect, test, vi } from "vitest";

import {
  createPersistentContextLaunch,
  launchSmartThingsPersistentContext,
  validateDedicatedProfileDir
} from "../../src/browser/persistent-context.js";

describe("persistent Chromium context", () => {
  test("uses a dedicated headed persistent profile under the bridge data directory", () => {
    const launch = createPersistentContextLaunch({
      dataDir: "/data",
      profileDir: "/data/chromium-profile",
      downloadDir: "/data/downloads"
    });

    expect(launch.userDataDir).toBe("/data/chromium-profile");
    expect(launch.options.headless).toBe(false);
    expect(launch.options.downloadsPath).toBe("/data/downloads");
    expect(launch.options.args).toContain("--no-first-run");
    expect(launch.options.args).toContain("--disable-background-timer-throttling");
    expect(JSON.stringify(launch)).not.toMatch(/AppData|Google\\Chrome|User Data/i);
  });

  test("rejects regular desktop Chrome profile paths", () => {
    expect(() =>
      validateDedicatedProfileDir("C:/Users/bobby/AppData/Local/Google/Chrome/User Data/Default")
    ).toThrow(/dedicated Chromium profile/);
  });

  test("delegates to Playwright launchPersistentContext without headless mode", async () => {
    const launchPersistentContext = vi.fn().mockResolvedValue({ ok: true });
    const chromium = { launchPersistentContext };

    const result = await launchSmartThingsPersistentContext(
      chromium,
      {
        dataDir: "/data",
        profileDir: "/data/chromium-profile",
        downloadDir: "/data/downloads"
      }
    );

    expect(result).toEqual({ ok: true });
    expect(launchPersistentContext).toHaveBeenCalledWith(
      "/data/chromium-profile",
      expect.objectContaining({ headless: false })
    );
  });
});
