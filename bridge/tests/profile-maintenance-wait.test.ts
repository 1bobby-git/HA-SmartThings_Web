import {
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { waitForProfileMaintenance } from "../src/runtime.js";

const requiredName = ".profile-maintenance-required";
const failedName = ".profile-maintenance-failed";

const makeLog = () => ({
  info: vi.fn<(message: string) => void>(),
  warn: vi.fn<(message: string) => void>()
});

describe("profile maintenance startup gate", () => {
  test("does not delay browser startup when maintenance was not requested", async () => {
    const root = mkdtempSync(join(tmpdir(), "stw-profile-wait-"));
    const log = makeLog();
    try {
      await expect(
        waitForProfileMaintenance(root, log, () => false, {
timeoutMs: 20,
pollMs: 2
        })
      ).resolves.toBe("not_required");
      expect(log.info).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("waits while HTTP can remain available and continues after maintenance completes", async () => {
    const root = mkdtempSync(join(tmpdir(), "stw-profile-wait-"));
    const required = join(root, requiredName);
    const log = makeLog();
    writeFileSync(required, "");
    const timer = setTimeout(() => unlinkSync(required), 10);
    try {
      await expect(
        waitForProfileMaintenance(root, log, () => false, {
timeoutMs: 200,
pollMs: 2
        })
      ).resolves.toBe("complete");
      expect(log.info).toHaveBeenCalledWith(
        "browser_startup:profile_maintenance_wait"
      );
      expect(log.info).toHaveBeenCalledWith(
        "browser_startup:profile_maintenance_complete"
      );
    } finally {
      clearTimeout(timer);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("continues with a bounded warning after maintenance failure or timeout", async () => {
    const failedRoot = mkdtempSync(join(tmpdir(), "stw-profile-wait-"));
    const failedRequired = join(failedRoot, requiredName);
    const failedMarker = join(failedRoot, failedName);
    const failedLog = makeLog();
    writeFileSync(failedRequired, "");
    const timer = setTimeout(() => {
      writeFileSync(failedMarker, "");
      unlinkSync(failedRequired);
    }, 10);
    try {
      await expect(
        waitForProfileMaintenance(failedRoot, failedLog, () => false, {
timeoutMs: 200,
pollMs: 2
        })
      ).resolves.toBe("failed");
      expect(failedLog.warn).toHaveBeenCalledWith(
        "browser_startup:profile_maintenance_failed"
      );
    } finally {
      clearTimeout(timer);
      rmSync(failedRoot, { recursive: true, force: true });
    }

    const timeoutRoot = mkdtempSync(join(tmpdir(), "stw-profile-wait-"));
    const timeoutLog = makeLog();
    writeFileSync(join(timeoutRoot, requiredName), "");
    try {
      await expect(
        waitForProfileMaintenance(timeoutRoot, timeoutLog, () => false, {
timeoutMs: 10,
pollMs: 2
        })
      ).resolves.toBe("timeout");
      expect(timeoutLog.warn).toHaveBeenCalledWith(
        "browser_startup:profile_maintenance_timeout"
      );
    } finally {
      rmSync(timeoutRoot, { recursive: true, force: true });
    }
  });
});
