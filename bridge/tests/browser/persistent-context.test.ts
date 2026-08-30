import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  test("marks an existing profile for session restore before launching Chromium", async () => {
    const root = mkdtempSync(join(tmpdir(), "stw-persistent-restore-"));
    try {
      const profileDir = join(root, "chromium-profile");
      const preferencesPath = join(profileDir, "Default", "Preferences");
      mkdirSync(join(profileDir, "Default"), { recursive: true });
      writeFileSync(
        preferencesPath,
        JSON.stringify({
          browser: { check_default_browser: false },
          profile: { exited_cleanly: true, exit_type: "Normal" },
          session: { restore_on_startup: 4 }
        }),
        { encoding: "utf8" }
      );
      const launchPersistentContext = vi.fn(async () => {
        const preferences = JSON.parse(readFileSync(preferencesPath, "utf8")) as {
          browser?: { check_default_browser?: boolean };
          profile?: { exited_cleanly?: boolean; exit_type?: string };
          session?: { restore_on_startup?: number };
        };
        return preferences;
      });
      const chromium = { launchPersistentContext };

      const result = await launchSmartThingsPersistentContext(chromium, {
        dataDir: root,
        profileDir,
        downloadDir: join(root, "downloads")
      });

      expect(result).toMatchObject({
        browser: { check_default_browser: false },
        profile: { exited_cleanly: false, exit_type: "Crashed" },
        session: { restore_on_startup: 1 }
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
