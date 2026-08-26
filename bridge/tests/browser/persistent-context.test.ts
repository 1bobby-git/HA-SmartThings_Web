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
    expect(launch.options.chromiumSandbox).toBe(true);
    expect(launch.options.downloadsPath).toBe("/data/downloads");
    expect(launch.options.timeout).toBe(30_000);
    expect(launch.options.args).toContain("--no-first-run");
    expect(launch.options.args).toContain("--restore-last-session");
    expect(launch.options.args).toContain("--hide-crash-restore-bubble");
    expect(launch.options.args).not.toContain("--no-sandbox");
    expect(launch.options.args).toContain("--disable-background-timer-throttling");
    expect(launch.options.args).toContain("--disable-backgrounding-occluded-windows");
    expect(launch.options.args).toContain("--disable-renderer-backgrounding");
    expect(JSON.stringify(launch)).not.toMatch(/AppData|Google\\Chrome|User Data/i);
  });

  test("requires the profile basename to be chromium-profile under the bridge data directory", () => {
    expect(() => validateDedicatedProfileDir("/data/chromium-profile", "/data")).not.toThrow();

    expect(() => validateDedicatedProfileDir("/data/chromium-profile-backup", "/data")).toThrow(
      /dedicated Chromium profile/
    );
    expect(() => validateDedicatedProfileDir("/data/other-profile", "/data")).toThrow(
      /dedicated Chromium profile/
    );
    expect(() => validateDedicatedProfileDir("/tmp/chromium-profile", "/data")).toThrow(
      /dedicated Chromium profile/
    );
    expect(() => validateDedicatedProfileDir("/data/nested/chromium-profile", "/data")).toThrow(
      /dedicated Chromium profile/
    );
  });

  test("rejects backup and regular desktop Chrome profile paths", () => {
    const unsafePaths = [
      "C:/Users/bobby/Desktop/chromium-profile",
      "C:/Users/bobby/AppData/Local/Google/Chrome/User Data/Default",
      "/data/backup/chromium-profile",
      "/data/chromium-profile.bak"
    ];

    for (const profileDir of unsafePaths) {
      expect(() => validateDedicatedProfileDir(profileDir, "/data")).toThrow(
        /dedicated Chromium profile/
      );
    }
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
