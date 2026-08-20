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

  test("rejects forged records that only copy the sanitizer marker", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-capture-"));
    let store: CaptureStore | undefined;
    try {
      store = new CaptureStore(join(root, "capture.sqlite"));
      const currentStore = store;

      expect(() =>
        currentStore.write({
          __sanitized: true,
          source: "unit",
          receivedAt: new Date().toISOString(),
          payload: { token: "secret" },
          payloadHash: "forged"
        })
      ).toThrow(/sanitizer/);
    } finally {
      store?.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("validates recent capture limits before querying", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-capture-"));
    let store: CaptureStore | undefined;
    try {
      store = new CaptureStore(join(root, "capture.sqlite"));
      const currentStore = store;

      expect(() => currentStore.listRecent(0)).toThrow(/limit/);
      expect(() => currentStore.listRecent(1.5)).toThrow(/limit/);
      expect(() => currentStore.listRecent(1001)).toThrow(/limit/);
    } finally {
      store?.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("pings the capture database without writing capture data", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-capture-"));
    let store: CaptureStore | undefined;
    try {
      store = new CaptureStore(join(root, "capture.sqlite"));

      expect(store.ping()).toBe(true);
      expect(store.listRecent(5)).toHaveLength(0);
    } finally {
      store?.close();
      rmSync(root, { force: true, recursive: true });
    }
  });
});
