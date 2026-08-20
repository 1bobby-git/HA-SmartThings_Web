import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { CaptureStore, sanitizeCaptureRecord } from "../../src/state/capture-store.js";

describe("CaptureStore", () => {
  test("persists only records that went through the sanitizer boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-capture-"));
    try {
      const store = new CaptureStore(join(root, "capture.sqlite"));
      const sanitized = sanitizeCaptureRecord(
        "unit",
        { url: "https://example.test/?token=secret", deviceId: "raw-device" },
        () => ({ url: "https://example.test/?token=[REDACTED]", deviceId: "dev_001" })
      );

      store.write(sanitized);
      const rows = store.listRecent(5);
      store.close();

      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toMatch(/secret|raw-device/);
      expect(rows[0]?.payload).toContain("dev_001");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
